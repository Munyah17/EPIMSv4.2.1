import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import crypto from 'crypto'
import { generateTransactionId } from './_lib/transactionId'
import { dispatchNotification } from './_lib/notify.js'
import { isTobaccoProduct, TOBACCO_SEASON } from './_lib/policyTerm.js'
import { clientRegisteredSms, policyRegisteredSms, policyCoverClause, paymentReceivedSms, isTobaccoFieldToFloor, fieldToFloorCoverLine } from '../src/lib/smsText.js'
import { resolveSmsText, smsVarMoney } from '../src/lib/smsTemplates.js'

/**
 * Public Developer API (/api/v1/...). External developers integrate this
 * into their own apps to sell our insurance products, authenticated by an
 * API key issued from Developers and API → New Developer in the app.
 *
 * Every key is tied to one api_developers row, which is itself backed by a
 * real (login-disabled) profiles row with role='api_partner'. Every policy
 * created through this API gets agent_id = that profile's id, so it flows
 * through the exact same commission/reporting pipeline as a human agent's
 * sales — no parallel accounting system to keep in sync.
 *
 * Isolation: every read/write is scoped server-side to the caller's own
 * agent_profile_id. A key can never see or touch another developer's
 * clients or policies — creating a client only ever reveals/reuses an
 * existing record if THIS developer already has a policy against it,
 * otherwise the write is rejected outright rather than silently attaching
 * to someone else's client. The product catalog only ever exposes the
 * fields a storefront actually needs (never commission_pct or internal
 * notes/documents).
 *
 * Deliberately create/read-only: there is no update or delete endpoint for
 * clients or policies. Developers have the exact same standing as an
 * on-the-ground agent, not more — a correction to sensitive data (wrong
 * DOB, wrong cover amount, etc.) goes through POST /api/v1/tickets, which
 * files a real support ticket for Super Admin to action, never a direct
 * write from the API caller.
 *
 * Lives at api/v1.ts, not api/v1/[...path].ts. It used to be the bracket
 * catch-all convention, which every real caller (confirmed against
 * TopMe's own traffic in api_request_log) hit as a 404 with an empty
 * resolved path: a single segment ("/api/v1/products") reached the
 * function with req.query.path empty, and two or more segments never
 * reached it at all -- Vercel's own platform 404, before this code ever
 * ran. vercel.json now rewrites /api/v1/:path* here explicitly, with the
 * captured tail passed as a plain query string this file splits itself,
 * the same mechanism already proven working for api/ai.ts and
 * api/api-partners.ts, rather than depend on the bracket file convention
 * again.
 */

type Json = Record<string, unknown>

function hashKey(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

function refNumber(prefix: string): string {
  return `${prefix}${new Date().getFullYear()}${Date.now().toString().slice(-6)}${Math.random().toString(36).slice(2, 5).toUpperCase()}`
}

// Mirrors src/lib/policyNumbers.ts — kept local because this function is a
// standalone deployable. The prefixes name the cover (FCP Funeral Cash
// Plan, HCP Hospital Cash Plan, MED Medical Aid, LEG Legal Insurance, TOB
// Tobacco Field-to-Floor) and numbers run sequentially per prefix.
function policyNumberPrefix(product: { name?: string; code?: string; category?: string }): string {
  const name = (product.name ?? '').toLowerCase()
  if (name.includes('tobacco') || name.includes('field to floor')) return 'TOB'
  if (name.includes('funeral') || name.includes('burial')) return 'FCP'
  if (name.includes('hospital')) return 'HCP'
  if (name.includes('medical')) return 'MED'
  if (name.includes('legal')) return 'LEG'
  const codeLetters = (product.code ?? '').replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase()
  if (codeLetters.length === 3) return codeLetters
  switch (product.category) {
    case 'funeral': return 'FCP'
    case 'health': return 'MED'
    case 'agriculture': return 'AGR'
    default: return 'POL'
  }
}

/** Draws the next number from the per-prefix sequence the IMS app, the
 *  website and every other channel share; refNumber() is the stopgap only
 *  for a database missing the sequence function. */
async function nextPolicyNumber(admin: SupabaseClient, product: { name?: string; code?: string; category?: string }): Promise<string> {
  const prefix = policyNumberPrefix(product)
  const { data: seq, error } = await admin.rpc('next_policy_sequence', { p_prefix: prefix })
  if (!error && typeof seq === 'number') return `${prefix}${String(seq).padStart(4, '0')}`
  return refNumber(prefix)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Postgres rejects a malformed UUID with a raw 22P02 error before RLS/lookup
 *  logic even runs — checking the shape up front turns that into a clean 400
 *  instead of a 500 that leaks the underlying DB error text to the caller. */
function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v)
}

/**
 * Postgres error text names tables, columns and constraints — free schema
 * reconnaissance for an external caller. Known codes get a plain sentence;
 * anything else gets a generic refusal. The real error still reaches
 * Vercel's function logs where it is logged, never the HTTP response.
 */
function pgMessage(error: { code?: string } | null): string {
  switch (error?.code) {
    case '23505': return 'That would duplicate an existing record.'
    case '23503': return 'A referenced record does not exist.'
    case '23502': return 'A required field is missing.'
    case '22P02': return 'A value has the wrong format.'
    default: return 'The request was rejected.'
  }
}

/**
 * Takes `amount` from a developer's wallet, atomically.
 *
 * PostgREST cannot express `wallet_balance = wallet_balance - n`, so this
 * is a compare-and-set loop: read the live balance, then write the
 * decremented figure only if the row still shows what was just read.
 * Postgres serialises concurrent updates on the row, so two sales racing
 * each other cannot both pass the balance check and spend the same dollars
 * twice — the loser sees a changed balance, retries, and either succeeds
 * on the new figure or runs out of money honestly. Returns the balance
 * actually written so the ledger row can record it truthfully, or null
 * when the float could not cover the debit.
 */
async function debitWallet(admin: SupabaseClient, devId: string, amount: number): Promise<number | null> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const { data: row } = await admin.from('api_developers').select('wallet_balance').eq('id', devId).single()
    if (!row) return null
    const balance = Number(row.wallet_balance) || 0
    if (balance < amount) return null
    const next = Math.round((balance - amount) * 100) / 100
    const { data: updated } = await admin.from('api_developers')
      .update({ wallet_balance: next }).eq('id', devId).eq('wallet_balance', balance).select('id')
    if (updated && updated.length > 0) return next
  }
  return null
}

/**
 * One stored shape for national IDs: separators and case stripped, the same
 * normalisation the public checkout applies before it ever writes a client.
 * "63-1234567-A-89" and "631234567A89" are the same person — dedup and
 * lookups only work if the row always carries the canonical form.
 */
function normalizeNationalId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
}

/** A generous ceiling — funeral family plans top out well below this; a
 *  bigger array is junk input, not a bigger family. */
const MAX_DEPENDANTS = 10

/**
 * Shapes the caller's dependants into the only fields a policy row may
 * carry. The API sells one product per policy, so a dependant's premium
 * and cover are always THIS product's — never read from the request. A
 * caller-supplied `premium` of a cent used to flow straight into the row,
 * and every renewal after that priced the dependant at a cent too (see
 * perPeriod in recordPayment and billablePremium in api/paynow-webhook.ts):
 * the issuance debit charged full price per head while renewals billed
 * pocket change.
 */
function sanitizeDependants(raw: unknown, product: { id: string; name: string; premium: number; cover_amount: number }):
  { ok: true; dependants: Record<string, unknown>[] } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, dependants: [] }
  if (!Array.isArray(raw) || raw.length > MAX_DEPENDANTS) return { ok: false }
  const dependants: Record<string, unknown>[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { ok: false }
    const d = entry as Record<string, unknown>
    const name = String(d.name ?? '').trim()
    if (!name) return { ok: false }
    const dob = String(d.dob ?? '').trim()
    const phone = String(d.phone ?? '').trim()
    dependants.push({
      name: name.slice(0, 120),
      relationship: String(d.relationship ?? '').trim().slice(0, 40),
      dob: /^\d{4}-\d{2}-\d{2}$/.test(dob) ? dob : '',
      nationalId: normalizeNationalId(String(d.nationalId ?? '')),
      productId: product.id,
      productName: product.name,
      premium: Number(product.premium),
      coverAmount: Number(product.cover_amount),
      ...(phone ? { phone: phone.slice(0, 40) } : {}),
    })
  }
  return { ok: true, dependants }
}

/**
 * Records the request against the key that made it. Method, caller IP and
 * elapsed time are included because a bare endpoint-and-status pair cannot
 * answer who called, from where, or whether a key is being hammered, which
 * is the whole reason for keeping the log.
 *
 * Never allowed to fail the request it describes: a broken audit write must
 * not turn a successful API call into an error for the partner.
 */
async function logRequest(
  admin: SupabaseClient, keyId: string | null, endpoint: string, statusCode: number,
  meta: { method?: string; ip?: string; startedAt?: number } = {},
) {
  if (!keyId) return
  try {
    await admin.from('api_request_log').insert({
      key_id: keyId, endpoint, status_code: statusCode,
      method: meta.method ?? null,
      ip: meta.ip ?? null,
      duration_ms: meta.startedAt ? Date.now() - meta.startedAt : null,
    })
  } catch (e) {
    console.error('api_request_log write failed', endpoint, e)
  }
}

function scopeFor(resource: string, method: string): string | null {
  if (resource === 'products' && method === 'GET') return 'products:read'
  if (resource === 'quotes' && method === 'POST') return 'quotes:read'
  if (resource === 'clients' && method === 'POST') return 'clients:write'
  // A client's row only ever surfaces through a policy this developer owns,
  // so the read is covered by the policies:read scope every key already
  // carries — no new scope, no need for existing partners to reissue keys.
  if (resource === 'clients' && method === 'GET') return 'policies:read'
  if (resource === 'policies' && method === 'POST') return 'policies:write'
  if (resource === 'policies' && method === 'GET') return 'policies:read'
  if (resource === 'payments' && method === 'POST') return 'payments:write'
  // Always granted regardless of issued scopes (see create-api-key.ts) — a
  // developer must always be able to flag a problem even with a narrowly
  // scoped key, since this is their only path to a correction at all: the
  // API has no update/delete endpoints on purpose (see module doc comment).
  if (resource === 'tickets' && method === 'POST') return 'support:write'
  return null
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    return res.status(204).end()
  }
  res.setHeader('Access-Control-Allow-Origin', '*')

  // Captured once here so every log line for this request shares the same
  // start time and caller identity. x-forwarded-for is a list when proxies
  // chain; the first entry is the original client.
  const startedAt = Date.now()
  const forwarded = req.headers['x-forwarded-for']
  const callerIp = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim()
    || req.socket?.remoteAddress
    || undefined
  const reqMeta = { method: req.method ?? undefined, ip: callerIp, startedAt }

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: 'Server is not configured.' })
  const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

  // The rewrite in vercel.json hands the whole tail after /api/v1/ as one
  // string (e.g. "policies/ABC123"), captured exactly as :path* matched it
  // -- split here rather than trusting Vercel's dynamic-route array
  // population, which is the part that was silently failing.
  const rawPath = req.query.path
  const pathString = Array.isArray(rawPath) ? rawPath.join('/') : (rawPath ?? '')
  const segments = pathString.split('/').filter(Boolean)
  const path = segments.join('/')
  const resource = segments[0] ?? ''
  const method = req.method ?? 'GET'

  const authHeader = req.headers.authorization
  const rawKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined
  if (!rawKey) return res.status(401).json({ error: 'Missing Authorization: Bearer <api key> header.' })

  const { data: keyRow } = await admin.from('api_keys').select('*').eq('key_hash', hashKey(rawKey)).eq('status', 'active').maybeSingle()
  if (!keyRow) return res.status(401).json({ error: 'Invalid or revoked API key.' })

  const { data: dev } = await admin.from('api_developers').select('*').eq('id', keyRow.developer_id).eq('status', 'active').maybeSingle()
  if (!dev) {
    await logRequest(admin, keyRow.id, path, 403, reqMeta)
    return res.status(403).json({ error: 'Developer account is suspended.' })
  }

  const since = new Date(Date.now() - 60000).toISOString()
  const { count } = await admin.from('api_request_log').select('*', { count: 'exact', head: true }).eq('key_id', keyRow.id).gte('ts', since)
  if ((count ?? 0) >= keyRow.rate_limit_per_min) {
    await logRequest(admin, keyRow.id, path, 429, reqMeta)
    return res.status(429).json({ error: `Rate limit of ${keyRow.rate_limit_per_min} requests/min exceeded.` })
  }

  const scopeNeeded = scopeFor(resource, method)
  if (!scopeNeeded) {
    await logRequest(admin, keyRow.id, path, 404, reqMeta)
    return res.status(404).json({ error: 'Unknown endpoint.' })
  }
  if (!(keyRow.scopes as string[]).includes(scopeNeeded)) {
    await logRequest(admin, keyRow.id, path, 403, reqMeta)
    return res.status(403).json({ error: `This API key does not have the '${scopeNeeded}' scope.` })
  }

  let body: Json = {}
  if (req.body) {
    try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body } catch {
      await logRequest(admin, keyRow.id, path, 400, reqMeta)
      return res.status(400).json({ error: 'Invalid JSON body.' })
    }
  }

  const agentId = dev.agent_profile_id as string
  let result: { status: number; body: Json }

  try {
    if (resource === 'products' && method === 'GET') {
      result = await listProducts(admin)
    } else if (resource === 'quotes' && method === 'POST') {
      result = await getQuote(admin, body)
    } else if (resource === 'clients' && method === 'POST') {
      result = await createClient_(admin, body, agentId)
    } else if (resource === 'clients' && method === 'GET') {
      const nidQuery = req.query.nationalId
      result = await listClients(admin, agentId, Array.isArray(nidQuery) ? nidQuery[0] : nidQuery)
    } else if (resource === 'policies' && method === 'POST') {
      result = await createPolicy(admin, body, dev)
    } else if (resource === 'policies' && method === 'GET' && segments[1]) {
      result = await getPolicy(admin, segments[1], agentId)
    } else if (resource === 'policies' && method === 'GET') {
      result = await listPolicies(admin, agentId)
    } else if (resource === 'payments' && method === 'POST') {
      result = await recordPayment(admin, body, agentId)
    } else if (resource === 'tickets' && method === 'POST') {
      result = await submitApiTicket(admin, body, agentId, dev.company_name as string)
    } else {
      result = { status: 404, body: { error: 'Unknown endpoint or missing path parameter.' } }
    }
  } catch (e) {
    // Never echo the raw exception back to an external caller — it can
    // carry Postgres schema/constraint details. Vercel's own function logs
    // still capture it for us to debug from.
    console.error('api/v1 handler error:', e)
    result = { status: 500, body: { error: 'Internal server error.' } }
  }

  await admin.from('api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', keyRow.id)
  await logRequest(admin, keyRow.id, path, result.status, reqMeta)
  return res.status(result.status).json(result.body)
}

// ── Handlers ─────────────────────────────────────────────────────

async function listProducts(admin: SupabaseClient) {
  const { data, error } = await admin
    .from('products')
    .select('id, name, category, premium, cover_amount, waiting_period_days, min_age, max_age, features, description')
    .eq('active', true)
  if (error) {
    console.error('v1 listProducts query failed', error)
    return { status: 500, body: { error: 'Internal server error.' } }
  }
  return {
    status: 200,
    body: {
      data: (data ?? []).map(p => ({
        id: p.id, name: p.name, category: p.category, premium: p.premium, coverAmount: p.cover_amount,
        waitingPeriodDays: p.waiting_period_days, minAge: p.min_age, maxAge: p.max_age,
        features: p.features, description: p.description,
      })),
    },
  }
}

async function getQuote(admin: SupabaseClient, body: Json) {
  const productId = body.productId as string | undefined
  if (!productId) return { status: 400, body: { error: 'productId is required.' } }
  if (!isUuid(productId)) return { status: 400, body: { error: 'productId must be a valid UUID.' } }
  const { data: product, error } = await admin
    .from('products').select('id, name, premium, cover_amount, waiting_period_days, min_age, max_age')
    .eq('id', productId).eq('active', true).maybeSingle()
  if (error) {
    console.error('v1 getQuote query failed', error)
    return { status: 500, body: { error: 'Internal server error.' } }
  }
  if (!product) return { status: 404, body: { error: 'Product not found or inactive.' } }

  const age = body.age !== undefined && body.age !== null && Number.isFinite(Number(body.age)) ? Number(body.age) : undefined
  const eligible = age === undefined || (age >= product.min_age && age <= product.max_age)

  return {
    status: 200,
    body: {
      data: {
        productId: product.id, productName: product.name, eligible,
        reason: eligible ? undefined : `Age must be between ${product.min_age} and ${product.max_age}.`,
        premium: product.premium, coverAmount: product.cover_amount, waitingPeriodDays: product.waiting_period_days,
      },
    },
  }
}

async function createClient_(admin: SupabaseClient, body: Json, agentId: string) {
  const name = String(body.name ?? '').trim().slice(0, 120)
  const phone = String(body.phone ?? '').trim().slice(0, 40)
  // Partners type the ID however it appears on the card — dashes, spaces,
  // lowercase check letter. Store the canonical form so the same person
  // presented two ways still deduplicates to one client.
  const rawNationalId = String(body.nationalId ?? '').trim().slice(0, 60)
  const nationalId = normalizeNationalId(rawNationalId)
  if (!name || !phone || !nationalId) return { status: 400, body: { error: 'name, phone, and nationalId are required.' } }

  const dob = body.dob ? String(body.dob).trim() : ''
  // Checked here rather than letting Postgres reject the date column —
  // same outcome, without the raw 22007 error text going to the caller.
  if (dob && !/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
    return { status: 400, body: { error: 'dob must be YYYY-MM-DD.' } }
  }

  const { data, error } = await admin.from('clients').insert({
    name, phone, national_id: nationalId,
    email: body.email ? String(body.email).slice(0, 120) : null,
    dob: dob || null,
    address: body.address ? String(body.address).slice(0, 300) : null,
    occupation: body.occupation ? String(body.occupation).slice(0, 120) : null,
    // The developer's own agent profile is recorded as the referring
    // agent: anyone this key registers was, by definition, brought in
    // by that partner.
    agent_id: agentId,
    status: 'active',
  }).select('id').single()
  if (!error) {
    // The client and the office both hear about a new registration —
    // wherever it came in from.
    const regSms = await resolveSmsText(admin, 'client_registered', {
      vars: { clientName: name },
      fallback: clientRegisteredSms(name, phone),
    })
    void dispatchNotification(admin, {
      event: 'registration',
      client: { name, phone, email: body.email ? String(body.email) : null },
      smsText: regSms,
      emailSubject: 'Welcome to Motions Microinsurance',
      emailText: `Dear ${name},\n\nYour details are on file with Motions Microinsurance.\n\nPlease note this registration does not itself put any cover in place. One of our agents will contact you to arrange a policy suited to you.\n\nRegards,\nMotions Microinsurance`,
    }).catch(e => console.error('v1.clients: registration notify failed', e))
    return { status: 201, body: { data: { id: data.id, nationalId, existing: false } } }
  }
  if (error.code !== '23505') return { status: 400, body: { error: pgMessage(error) } }

  // Already exists — only hand back the id (and let the caller treat it as
  // "their" client) if this developer already has a policy against them.
  // Otherwise this lookup would let any key harvest another developer's
  // client ids just by guessing national ID numbers. Rows written before
  // normalisation may still carry separators, so match the raw text too.
  const { data: existingClients } = await admin.from('clients').select('id')
    .in('national_id', [...new Set([nationalId, rawNationalId])]).limit(1)
  const existingClient = existingClients?.[0]
  if (existingClient) {
    const { data: ownPolicy } = await admin.from('policies').select('id').eq('client_id', existingClient.id).eq('agent_id', agentId).limit(1).maybeSingle()
    if (ownPolicy) return { status: 200, body: { data: { id: existingClient.id, existing: true } } }
  }
  return {
    status: 409,
    body: { error: 'A client with that national ID already exists under a different agent. Submit a support ticket (POST /api/v1/tickets) if you believe this is an error.' },
  }
}

async function createPolicy(admin: SupabaseClient, body: Json, dev: Record<string, unknown>) {
  const agentId = dev.agent_profile_id as string
  // The client may be identified two ways: the UUID POST /clients returned
  // (clientId), or the national ID itself (clientNationalId — or a national
  // ID sent in clientId, which is accepted too, so a partner who skipped
  // the client round-trip is not bounced on a format technicality).
  const clientRef = String(body.clientId ?? body.clientNationalId ?? '').trim()
  const productId = body.productId as string | undefined
  const paymentMethod = String(body.paymentMethod ?? 'EcoCash').slice(0, 40)
  if (!clientRef || !productId) return { status: 400, body: { error: 'clientId (or clientNationalId) and productId are required.' } }
  if (!isUuid(productId)) return { status: 400, body: { error: 'productId must be a valid UUID.' } }

  let clientId: string | null = null
  if (isUuid(clientRef)) {
    clientId = clientRef
  } else {
    const nid = normalizeNationalId(clientRef)
    const { data: byNationalId } = await admin.from('clients').select('id')
      .in('national_id', [...new Set([nid, clientRef])]).limit(1)
    clientId = byNationalId?.[0]?.id ?? null
  }

  const { data: client } = clientId
    ? await admin.from('clients').select('id').eq('id', clientId).maybeSingle()
    : { data: null }
  if (!client) return { status: 404, body: { error: 'Client not found. Register them first with POST /clients, then pass the returned id (or their national ID) as clientId.' } }

  // A client with no policies yet is fair game (this developer would be
  // the first); one with existing policies all belonging to other agents
  // is not — never let this key attribute a policy to itself for someone
  // else's client.
  const { data: existingPolicies } = await admin.from('policies').select('agent_id').eq('client_id', clientId)
  if (existingPolicies && existingPolicies.length > 0 && !existingPolicies.some(p => p.agent_id === agentId)) {
    return { status: 403, body: { error: 'This client is already associated with a different agent. Submit a support ticket (POST /api/v1/tickets) to request access.' } }
  }

  const { data: product } = await admin.from('products').select('id, name, code, premium, cover_amount, category').eq('id', productId).eq('active', true).maybeSingle()
  if (!product) return { status: 404, body: { error: 'Product not found or inactive.' } }

  // Agriculture is hard-blocked for every partner key, no exceptions: it
  // is billed once a year via Stop Order through the grower's sponsoring
  // association (paid once the crop sells), so there is no float to debit
  // and real cover would go out on our name with no money in hand at all.
  // That is exactly the fraud surface the wallet exists to close -- it is
  // issued by staff inside the IMS only, never self-served through an API.
  if (product.category === 'agriculture') {
    return { status: 403, body: { error: 'Agriculture cover cannot be issued through the partner API. It is arranged through sponsoring associations — contact Motions Microinsurance directly.' } }
  }

  // A dependant's premium is always this product's (the API sells one
  // product per policy), so a head count is exactly what the float is
  // charged and what renewals will bill — caller-supplied premiums never
  // reach the row (see sanitizeDependants).
  const dep = sanitizeDependants(body.dependants, product as { id: string; name: string; premium: number; cover_amount: number })
  if (!dep.ok) {
    return { status: 400, body: { error: `dependants must be an array of at most ${MAX_DEPENDANTS} objects, each with at least a name.` } }
  }
  const dependants = dep.dependants
  const requiredAmount = Number(product.premium) * (1 + dependants.length)

  // A Digital Agent collects its own money and settles with us separately,
  // so a policy is only ever issued against a float already on deposit --
  // never on the strength of a sale it merely claims to have made.
  const walletBalance = Number(dev.wallet_balance ?? 0)
  if (walletBalance < requiredAmount) {
    return {
      status: 402,
      body: { error: `Insufficient wallet balance. This policy requires $${requiredAmount.toFixed(2)}; your account holds $${walletBalance.toFixed(2)}. Top up your float and try again.` },
    }
  }

  // Tobacco Field-to-Floor is bound to the fixed season window — the
  // caller's startDate (or its absence) is ignored, matching the portal.
  const tobacco = isTobaccoProduct({ name: String(product.name ?? ''), category: String(product.category ?? '') })
  const startDate = tobacco ? new Date(`${TOBACCO_SEASON.start}T00:00:00Z`) : (body.startDate ? new Date(String(body.startDate)) : new Date())
  if (Number.isNaN(startDate.getTime())) return { status: 400, body: { error: 'startDate is not a valid date.' } }
  // start_date feeds the 90-day waiting-period lift in cron-reminders, so a
  // wildly backdated one is not a typo — it is free cover. Bounded to what
  // a partner could legitimately mean: a recent issue date or a scheduled
  // start coming up soon.
  const DAY_MS = 86400000
  const startMs = startDate.getTime()
  if (!tobacco && (startMs < Date.now() - 14 * DAY_MS || startMs > Date.now() + 60 * DAY_MS)) {
    return { status: 400, body: { error: 'startDate must be within the last 14 days or the next 60 days.' } }
  }
  const endDate = tobacco ? new Date(`${TOBACCO_SEASON.end}T00:00:00Z`) : new Date(startDate)
  if (!tobacco) endDate.setFullYear(endDate.getFullYear() + 1)

  const { data, error } = await admin.from('policies').insert({
    policy_number: await nextPolicyNumber(admin, product),
    client_id: clientId,
    product_id: productId,
    premium: product.premium,
    cover_amount: product.cover_amount,
    start_date: startDate.toISOString().split('T')[0],
    end_date: endDate.toISOString().split('T')[0],
    status: 'pending',
    dependants,
    payment_method: paymentMethod,
    agent_id: agentId,
    source: 'api_partner',
  }).select('id, policy_number').single()
  if (error) return { status: 400, body: { error: pgMessage(error) } }

  // The float is only ever spent, never quietly not-spent — and never
  // double-spent: the earlier check read the balance once at request
  // start, so the debit itself is an atomic compare-and-set (see
  // debitWallet). If it cannot land, the just-inserted policy cannot stand
  // either — cover issued for nothing is the exact fraud the wallet exists
  // to close — so it is deleted rather than parked. The delete failing
  // still leaves only a 'pending' policy a human must approve anyway.
  const newBalance = await debitWallet(admin, dev.id as string, requiredAmount)
  if (newBalance === null) {
    await admin.from('policies').delete().eq('id', data.id)
    console.error('createPolicy: wallet debit failed; policy rolled back', dev.id, data.id)
    return { status: 402, body: { error: 'Insufficient wallet balance — the policy was not issued. Top up your float and try again.' } }
  }
  const { error: ledgerError } = await admin.from('api_wallet_transactions').insert({
    developer_id: dev.id, type: 'policy_debit', amount: -requiredAmount, balance_after: newBalance,
    policy_id: data.id, note: `Policy ${data.policy_number}`,
  })
  if (ledgerError) {
    // The debit itself DID land — a missing ledger row is a reporting gap
    // on a real transaction, never a reason to undo paid-for cover.
    console.error('createPolicy: wallet ledger write failed after successful debit', dev.id, data.id, ledgerError.message)
  }

  // Issued through a partner, still our policy — the client gets the same
  // registration confirmation as a counter sale, and the office sees it land.
  const { data: contact } = await admin.from('clients').select('name, phone, email').eq('id', clientId).maybeSingle()
  const polPremium = Number(product.premium)
  const polF2F = isTobaccoFieldToFloor(product.name)
  const polSms = await resolveSmsText(admin, 'registration_confirmation', {
    productId: product.id as string,
    vars: {
      clientName: contact?.name ?? 'Client',
      policyNumber: data.policy_number,
      productName: product.name,
      coverAmount: smsVarMoney(Number(product.cover_amount)),
      coverLine: polF2F
        ? fieldToFloorCoverLine(product.name, polPremium)
        : smsVarMoney(Number(product.cover_amount)),
      coverClause: policyCoverClause(product.name, Number(product.cover_amount), polPremium),
      premium: smsVarMoney(polPremium),
      // Tobacco texts carry no period label and no closing dot — see
      // smsText.ts. Non-tobacco keeps the trailing period inside the
      // var so one template body serves both product classes.
      period: polF2F ? '' : '/yr',
      premiumWithPeriod: polF2F ? smsVarMoney(polPremium) : `${smsVarMoney(polPremium)}/yr.`,
      paymentMethod,
    },
    fallback: policyRegisteredSms({
      clientName: contact?.name ?? 'Client',
      policyNumber: data.policy_number,
      productName: product.name,
      productCategory: product.category as string | undefined,
      coverAmount: Number(product.cover_amount),
      premium: polPremium,
      paymentMethod,
      clientPhone: contact?.phone,
    }),
  })
  void dispatchNotification(admin, {
    event: 'registration',
    ref: data.policy_number,
    client: contact ?? undefined,
    smsText: polSms,
    emailSubject: `Policy ${data.policy_number} confirmed`,
    emailText: `Dear ${contact?.name ?? 'Client'},\n\nYour policy is on record through one of our agents.\n\nPolicy Number:  ${data.policy_number}\nProduct:        ${product.name}\nCover Amount:   $${Number(product.cover_amount).toLocaleString()}\nPremium:        $${Number(product.premium).toFixed(2)} per month\nStatus:         PENDING APPROVAL\n\nWe will confirm once it is active.\n\nRegards,\nMotions Microinsurance`,
  }).catch(e => console.error('v1.policies: registration notify failed', e))

  return { status: 201, body: { data: { id: data.id, policyNumber: data.policy_number, status: 'pending' } } }
}

async function getPolicy(admin: SupabaseClient, policyNumber: string, agentId: string) {
  const { data, error } = await admin
    .from('policies')
    .select('id, policy_number, premium, cover_amount, status, start_date, end_date, dependants')
    .eq('policy_number', policyNumber)
    .eq('agent_id', agentId)
    .maybeSingle()
  if (error) {
    console.error('v1 getPolicy query failed', error)
    return { status: 500, body: { error: 'Internal server error.' } }
  }
  if (!data) return { status: 404, body: { error: 'Policy not found.' } }
  return {
    status: 200,
    body: {
      data: {
        id: data.id, policyNumber: data.policy_number, premium: data.premium, coverAmount: data.cover_amount,
        status: data.status, startDate: data.start_date, endDate: data.end_date,
        dependants: data.dependants ?? [],
      },
    },
  }
}

/**
 * Read-side mirror of POST /clients for the partner's own book: every
 * client they hold a policy on, optionally narrowed to one national ID via
 * ?nationalId=. Clients belonging to other agents never appear — the list
 * is built from this developer's policy rows, the same boundary the write
 * side enforces.
 */
async function listClients(admin: SupabaseClient, agentId: string, nationalId?: string) {
  const { data: ownPolicies, error: polError } = await admin.from('policies').select('client_id').eq('agent_id', agentId)
  if (polError) {
    console.error('v1 listClients policies query failed', polError)
    return { status: 500, body: { error: 'Internal server error.' } }
  }
  const clientIds = [...new Set((ownPolicies ?? []).map(p => p.client_id as string).filter(Boolean))]
  if (clientIds.length === 0) return { status: 200, body: { data: [] } }

  let query = admin.from('clients')
    .select('id, name, phone, national_id, email, dob, status')
    .in('id', clientIds)
  if (nationalId) {
    const nid = normalizeNationalId(nationalId)
    query = query.in('national_id', [...new Set([nid, nationalId.trim()])])
  }
  const { data, error } = await query
  if (error) {
    console.error('v1 listClients query failed', error)
    return { status: 500, body: { error: 'Internal server error.' } }
  }
  return {
    status: 200,
    body: {
      data: (data ?? []).map(c => ({
        id: c.id, name: c.name, phone: c.phone, nationalId: c.national_id,
        email: c.email, dob: c.dob, status: c.status,
      })),
    },
  }
}

/**
 * The partner's whole book in one call — the same fields GET
 * /policies/:policyNumber returns plus client and product names, so a
 * partner can reconcile their records without having held onto every
 * policy number they were ever issued. Newest first, capped rather than
 * paged for now.
 */
async function listPolicies(admin: SupabaseClient, agentId: string) {
  const { data, error } = await admin
    .from('policies')
    .select('id, policy_number, client_id, product_id, premium, cover_amount, status, start_date, end_date, dependants')
    .eq('agent_id', agentId)
    .order('created_at', { ascending: false })
    .limit(500)
  if (error) {
    console.error('v1 listPolicies query failed', error)
    return { status: 500, body: { error: 'Internal server error.' } }
  }

  const rows = data ?? []
  const clientIds = [...new Set(rows.map(r => r.client_id as string).filter(Boolean))]
  const productIds = [...new Set(rows.map(r => r.product_id as string).filter(Boolean))]
  const [clientsRes, productsRes] = await Promise.all([
    clientIds.length ? admin.from('clients').select('id, name, national_id').in('id', clientIds) : Promise.resolve({ data: [] as { id: string; name: string; national_id: string }[] }),
    productIds.length ? admin.from('products').select('id, name').in('id', productIds) : Promise.resolve({ data: [] as { id: string; name: string }[] }),
  ])
  const clientById = new Map((clientsRes.data ?? []).map(c => [c.id, c]))
  const productById = new Map((productsRes.data ?? []).map(p => [p.id, p]))

  return {
    status: 200,
    body: {
      data: rows.map(p => ({
        id: p.id, policyNumber: p.policy_number,
        clientId: p.client_id,
        clientName: clientById.get(p.client_id)?.name,
        clientNationalId: clientById.get(p.client_id)?.national_id,
        productId: p.product_id,
        productName: productById.get(p.product_id)?.name,
        premium: p.premium, coverAmount: p.cover_amount, status: p.status,
        startDate: p.start_date, endDate: p.end_date, dependants: p.dependants ?? [],
      })),
    },
  }
}

async function recordPayment(admin: SupabaseClient, body: Json, agentId: string) {
  const policyNumber = String(body.policyNumber ?? '')
  const amount = Number(body.amount)
  if (!policyNumber || !Number.isFinite(amount) || amount <= 0) {
    return { status: 400, body: { error: 'policyNumber is required and amount must be a positive number.' } }
  }

  const { data: policy } = await admin.from('policies')
    .select('id, agent_id, status, product_id, premium, dependants, next_payment_date, clients!client_id(name, email, phone)')
    .eq('policy_number', policyNumber).maybeSingle()
  if (!policy || policy.agent_id !== agentId) return { status: 404, body: { error: 'Policy not found.' } }

  // A 'pending' policy is still awaiting Admin approval (the API creates
  // policies as 'pending' specifically so a human reviews external-sourced
  // business before it's live) — a payment must never be the thing that
  // silently pushes it past that gate.
  if (policy.status === 'pending') {
    return { status: 409, body: { error: 'This policy is still pending approval and cannot accept payments yet.' } }
  }
  if (policy.status === 'cancelled' || policy.status === 'expired') {
    return { status: 409, body: { error: `This policy is ${policy.status} and cannot accept payments.` } }
  }

  const method = String(body.method ?? 'EcoCash').slice(0, 40)
  const { data: paymentRow, error } = await admin.from('payments').insert({
    reference: refNumber('PAY'),
    policy_id: policy.id,
    amount,
    method,
    // A partner's own transaction reference wins; otherwise mint ours.
    transaction_id: body.transactionId
      ? String(body.transactionId).slice(0, 60)
      : generateTransactionId({
          clientName: (policy.clients as { name?: string } | null)?.name ?? policyNumber,
          method,
        }),
    status: 'completed',
  }).select('id, reference').single()
  if (error) return { status: 400, body: { error: pgMessage(error) } }

  // Mirrors applyCompletedPaymentToPolicy in src/lib/db.ts, the same rule
  // staff-recorded payments follow: agriculture jumps straight to active on
  // its first payment (no waiting period); a lapsed policy reinstates to a
  // fresh waiting_period, not straight back to active; everything else
  // keeps its current status — the 90-day wait is lifted by the hourly
  // reminder-engine check, not by paying.
  const { data: product } = await admin.from('products').select('category').eq('id', policy.product_id).maybeSingle()
  const category = product?.category ?? ''

  // Only whole periods extend cover. This used to advance a full cycle for
  // any amount at all, so a partner posting a token payment bought a month
  // of cover. Mirrors applyCompletedPaymentToPolicy in src/lib/db.ts.
  //
  // Premiums are per head, so the period price is the policyholder's
  // premium plus one for each dependant, except agriculture which is
  // billed on the crop.
  const deps = Array.isArray(policy.dependants) ? policy.dependants as { premium?: number }[] : []
  const own = Number(policy.premium) || 0
  const perPeriod = category === 'agriculture'
    ? own
    : deps.reduce((sum, d) => {
      const p = Number(d?.premium)
      return sum + (Number.isFinite(p) && p > 0 ? p : own)
    }, own)
  const periodsPaid = perPeriod > 0 && amount > 0 ? Math.floor(amount / perPeriod) : 0

  let nextStatus = policy.status
  if (periodsPaid >= 1) {
    if (policy.status === 'lapsed' || policy.status === 'defaulted') nextStatus = category === 'agriculture' ? 'active' : 'waiting_period'
    else if (category === 'agriculture' && policy.status === 'waiting_period') nextStatus = 'active'
  }

  const today = new Date()
  const cycleMonths = category === 'agriculture' ? 12 : 1
  const base = policy.next_payment_date && new Date(policy.next_payment_date) > today ? new Date(policy.next_payment_date) : today
  const next = new Date(base)
  next.setMonth(next.getMonth() + cycleMonths * periodsPaid)

  await admin.from('policies').update({
    status: nextStatus,
    last_payment_date: today.toISOString().split('T')[0],
    next_payment_date: next.toISOString().split('T')[0],
  }).eq('id', policy.id)

  if (category !== 'agriculture') {
    const client = policy.clients as { name?: string; email?: string | null; phone?: string | null } | null
    const amountFmt = `$${amount.toFixed(2)}`
    const paySms = await resolveSmsText(admin, 'payment_received', {
      productId: policy.product_id,
      vars: {
        clientName: client?.name ?? 'Client',
        policyNumber,
        amount: smsVarMoney(amount),
        method,
        reference: paymentRow.reference,
      },
      fallback: paymentReceivedSms({
        clientName: client?.name ?? 'Client',
        policyNumber,
        amount,
        method,
        reference: paymentRow.reference,
        clientPhone: client?.phone,
      }),
    })
    void dispatchNotification(admin, {
      event: 'payment', ref: policyNumber, client,
      smsText: paySms,
      emailSubject: `Payment received: policy ${policyNumber}`,
      emailText: `Dear ${client?.name ?? 'Client'},\n\nWe have received your payment.\n\nAmount:    ${amountFmt}\nPolicy:    ${policyNumber}\nMethod:    ${method}\nReference: ${paymentRow.reference}\n\nThank you for keeping your cover up to date.\n\nRegards,\nMotions Microinsurance`,
    }).catch(e => console.error('v1.payments: notify failed', e))
  }

  return { status: 201, body: { data: { id: paymentRow.id, reference: paymentRow.reference, status: 'completed' } } }
}

/**
 * The API's only path for anything that isn't a straightforward create —
 * a wrong DOB, a wrong cover amount, a client who needs re-linking, etc.
 * Files a real ticket for staff to action rather than exposing any kind of
 * update/delete endpoint to external callers. clientId is required and
 * must belong to the calling developer, same as every other endpoint.
 */
async function submitApiTicket(admin: SupabaseClient, body: Json, agentId: string, companyName: string) {
  const subject = String(body.subject ?? '').trim().slice(0, 150)
  const description = String(body.description ?? '').trim().slice(0, 5000)
  const clientId = body.clientId ? String(body.clientId) : ''
  if (!subject || !description || !clientId) {
    return { status: 400, body: { error: 'subject, description, and clientId are required.' } }
  }
  if (!isUuid(clientId)) return { status: 400, body: { error: 'clientId must be a valid UUID.' } }

  const { data: ownPolicy } = await admin.from('policies').select('id').eq('client_id', clientId).eq('agent_id', agentId).limit(1).maybeSingle()
  if (!ownPolicy) return { status: 403, body: { error: 'clientId is not associated with this API key.' } }

  const { data, error } = await admin.from('tickets').insert({
    ticket_number: refNumber('TKT'),
    client_id: clientId,
    subject: `[API Partner: ${companyName}] ${subject}`.slice(0, 200),
    description,
    status: 'open',
    priority: 'high',
    category: 'API Partner Request',
  }).select('id, ticket_number').single()
  if (error) return { status: 400, body: { error: pgMessage(error) } }

  return { status: 201, body: { data: { id: data.id, ticketNumber: data.ticket_number, status: 'open' } } }
}
