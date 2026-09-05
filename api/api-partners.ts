import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import crypto from 'crypto'

/**
 * Developer/partner administration: registering a partner, and issuing that
 * partner's API keys.
 *
 * These were two functions (create-api-developer.ts, create-api-key.ts).
 * They are one now purely because Vercel's Hobby plan allows 12 serverless
 * functions per deployment and this project reached 13 -- api/v1.ts
 * sits in a subdirectory and is easy to forget when counting. Nothing about
 * the two flows changed: same request bodies, same responses, same
 * admin-only authorization, and vercel.json rewrites keep both original
 * URLs working, so callers are unaffected. The pattern matches api/ai.ts,
 * which consolidated four AI endpoints the same way.
 *
 * They pair naturally: a key can only ever be issued to a developer created
 * by the other action, and both are admin-only.
 */

const DEFAULT_SCOPES = ['products:read', 'quotes:read', 'clients:write', 'policies:write', 'policies:read', 'payments:write']

interface DeveloperBody {
  companyName: string
  contactEmail: string
  contactPhone?: string
  termsAccepted: boolean
  termsVersion: string
}

interface KeyBody {
  developerId: string
  scopes?: string[]
  rateLimitPerMin?: number
  environment?: 'sandbox' | 'live'
}

/**
 * Both actions require the same thing: a real, active admin session. Kept as
 * one function so the two can never drift apart -- an authorization check
 * that is right in one place and stale in the other is exactly the kind of
 * hole that does not announce itself.
 */
async function requireAdmin(
  req: VercelRequest,
  admin: SupabaseClient,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const authHeader = req.headers.authorization
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined
  if (!token) return { ok: false, status: 401, error: 'Missing Authorization header.' }

  const { data: { user: caller }, error: callerError } = await admin.auth.getUser(token)
  if (callerError || !caller) return { ok: false, status: 401, error: 'Invalid or expired session.' }

  const { data: callerProfile } = await admin.from('profiles').select('role, active').eq('id', caller.id).single()
  if (!callerProfile || !callerProfile.active || !['admin', 'super_admin'].includes(callerProfile.role)) {
    return { ok: false, status: 403, error: 'You do not have permission to administer API partners.' }
  }
  return { ok: true }
}

/**
 * Registers a new external API developer/partner. Creates a real (but
 * login-disabled — random password, never issued to anyone) Supabase Auth
 * identity + profiles row with role='api_partner', so policies.agent_id
 * can point at it and the developer's sales flow through the exact same
 * commission/reporting pipeline as a human agent's. The developer never
 * authenticates with this identity directly; they only ever use an API key
 * (issued by createKey below) against /api/v1/*.
 */
async function createDeveloper(req: VercelRequest, res: VercelResponse, admin: SupabaseClient) {
  const body: DeveloperBody = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {})
  if (!body.companyName?.trim() || !body.contactEmail?.trim()) {
    return res.status(400).json({ error: 'companyName and contactEmail are required.' })
  }
  if (!body.termsAccepted || !body.termsVersion) {
    return res.status(400).json({ error: 'The Developer API terms must be accepted to register.' })
  }

  const internalEmail = `api-partner-${crypto.randomUUID()}@partners.internal`
  const randomPassword = crypto.randomBytes(24).toString('hex')

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: internalEmail,
    password: randomPassword,
    email_confirm: true,
    user_metadata: { name: body.companyName.trim(), role: 'api_partner', department: 'API Partner' },
  })
  if (createError || !created.user) {
    return res.status(400).json({ error: createError?.message ?? 'Failed to create partner identity.' })
  }

  const { data: developer, error: devError } = await admin.from('api_developers').insert({
    agent_profile_id: created.user.id,
    company_name: body.companyName.trim(),
    contact_email: body.contactEmail.trim(),
    contact_phone: body.contactPhone?.trim() || null,
    status: 'active',
    terms_accepted_at: new Date().toISOString(),
    terms_version: body.termsVersion,
  }).select('*').single()

  if (devError || !developer) {
    await admin.auth.admin.deleteUser(created.user.id).catch(() => {})
    return res.status(400).json({ error: devError?.message ?? 'Failed to register developer.' })
  }

  return res.status(200).json({ success: true, developer })
}

/**
 * Issues a new API key PAIR for an existing developer — a publishable key
 * (returned every time it's listed, safe to display/copy at any point) and
 * a secret key (returned exactly once in this response and never stored —
 * only its SHA-256 hash is kept, matched against on every /api/v1/*
 * request). Mirrors the pk_/sk_ pattern developers already expect.
 *
 * `environment` tags the key as sandbox or live for display/audit purposes.
 * Note: this is a first version — sandbox keys authenticate against the
 * same live database as live keys (there's no isolated test dataset yet),
 * so treat the sandbox/live split as a labelling and audit-trail feature
 * for now, not a guarantee that sandbox activity can't touch real records.
 */
async function createKey(req: VercelRequest, res: VercelResponse, admin: SupabaseClient) {
  const body: KeyBody = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {})
  if (!body.developerId) return res.status(400).json({ error: 'developerId is required.' })

  const { data: developer } = await admin.from('api_developers').select('id').eq('id', body.developerId).maybeSingle()
  if (!developer) return res.status(404).json({ error: 'Developer not found.' })

  const environment: 'sandbox' | 'live' = body.environment === 'sandbox' ? 'sandbox' : 'live'
  const rawKey = `tqfy_sk_${environment}_${crypto.randomBytes(24).toString('hex')}`
  const publishableKey = `tqfy_pk_${environment}_${crypto.randomBytes(12).toString('hex')}`
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex')
  const keyPrefix = rawKey.slice(0, 22)

  // support:write (submit a ticket, see api/v1.ts) is always
  // granted regardless of what's chosen — it's a developer's only path to
  // flag a problem at all, since the API has no update/delete endpoints.
  const chosenScopes = body.scopes?.length ? body.scopes : DEFAULT_SCOPES
  const scopes = chosenScopes.includes('support:write') ? chosenScopes : [...chosenScopes, 'support:write']

  const { data: keyRow, error } = await admin.from('api_keys').insert({
    developer_id: body.developerId,
    key_prefix: keyPrefix,
    key_hash: keyHash,
    publishable_key: publishableKey,
    environment,
    scopes,
    rate_limit_per_min: body.rateLimitPerMin && body.rateLimitPerMin > 0 ? body.rateLimitPerMin : 60,
    status: 'active',
  }).select('id, key_prefix, publishable_key, environment, scopes, rate_limit_per_min, status, created_at').single()

  if (error || !keyRow) return res.status(400).json({ error: error?.message ?? 'Failed to create key.' })

  return res.status(200).json({ success: true, key: { ...keyRow, rawKey } })
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'Server is not configured (missing Supabase service credentials).' })
  }

  const action = String(req.query.action ?? '')
  if (action !== 'create-developer' && action !== 'create-key') {
    return res.status(400).json({ error: 'action must be "create-developer" or "create-key".' })
  }

  const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

  const auth = await requireAdmin(req, admin)
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error })

  return action === 'create-developer'
    ? createDeveloper(req, res, admin)
    : createKey(req, res, admin)
}
