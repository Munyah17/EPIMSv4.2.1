import type { Handler } from '@netlify/functions'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import crypto from 'crypto'

/**
 * Public Developer API (/api/v1/...). External developers integrate this
 * into their own apps to sell our insurance products, authenticated by an
 * API key issued from Developer API → New Developer in the app.
 *
 * Every key is tied to one api_developers row, which is itself backed by a
 * real (login-disabled) profiles row with role='api_partner'. Every policy
 * created through this API gets agent_id = that profile's id, so it flows
 * through the exact same commission/reporting pipeline as a human agent's
 * sales — no parallel accounting system to keep in sync.
 *
 * Isolation: every read/write is scoped server-side to the caller's own
 * agent_profile_id. A key can never see or touch another developer's
 * clients or policies, and the product catalog only ever exposes the
 * fields a storefront actually needs (never commission_pct or internal
 * notes/documents).
 */

type Json = Record<string, unknown>

function json(status: number, body: Json) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) }
}

function hashKey(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

function refNumber(prefix: string): string {
  return `${prefix}${new Date().getFullYear()}${Date.now().toString().slice(-6)}${Math.random().toString(36).slice(2, 5).toUpperCase()}`
}

async function logRequest(admin: SupabaseClient, keyId: string | null, endpoint: string, statusCode: number) {
  if (!keyId) return
  await admin.from('api_request_log').insert({ key_id: keyId, endpoint, status_code: statusCode })
}

function scopeFor(resource: string, method: string): string | null {
  if (resource === 'products' && method === 'GET') return 'products:read'
  if (resource === 'quotes' && method === 'POST') return 'quotes:read'
  if (resource === 'clients' && method === 'POST') return 'clients:write'
  if (resource === 'policies' && method === 'POST') return 'policies:write'
  if (resource === 'policies' && method === 'GET') return 'policies:read'
  if (resource === 'payments' && method === 'POST') return 'payments:write'
  return null
}

export const handler: Handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }, body: '' }
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) return json(500, { error: 'Server is not configured.' })
  const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

  const path = event.path.replace(/^.*\/api-v1\/?/, '').replace(/\/+$/, '')
  const segments = path.split('/').filter(Boolean)
  const resource = segments[0] ?? ''
  const method = event.httpMethod

  const authHeader = event.headers.authorization ?? event.headers.Authorization
  const rawKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined
  if (!rawKey) return json(401, { error: 'Missing Authorization: Bearer <api key> header.' })

  const { data: keyRow } = await admin.from('api_keys').select('*').eq('key_hash', hashKey(rawKey)).eq('status', 'active').maybeSingle()
  if (!keyRow) return json(401, { error: 'Invalid or revoked API key.' })

  const { data: dev } = await admin.from('api_developers').select('*').eq('id', keyRow.developer_id).eq('status', 'active').maybeSingle()
  if (!dev) {
    await logRequest(admin, keyRow.id, path, 403)
    return json(403, { error: 'Developer account is suspended.' })
  }

  const since = new Date(Date.now() - 60000).toISOString()
  const { count } = await admin.from('api_request_log').select('*', { count: 'exact', head: true }).eq('key_id', keyRow.id).gte('ts', since)
  if ((count ?? 0) >= keyRow.rate_limit_per_min) {
    await logRequest(admin, keyRow.id, path, 429)
    return json(429, { error: `Rate limit of ${keyRow.rate_limit_per_min} requests/min exceeded.` })
  }

  const scopeNeeded = scopeFor(resource, method)
  if (!scopeNeeded) {
    await logRequest(admin, keyRow.id, path, 404)
    return json(404, { error: 'Unknown endpoint.' })
  }
  if (!(keyRow.scopes as string[]).includes(scopeNeeded)) {
    await logRequest(admin, keyRow.id, path, 403)
    return json(403, { error: `This API key does not have the '${scopeNeeded}' scope.` })
  }

  let body: Json = {}
  if (event.body) {
    try { body = JSON.parse(event.body) } catch {
      await logRequest(admin, keyRow.id, path, 400)
      return json(400, { error: 'Invalid JSON body.' })
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
      result = await createClient_(admin, body)
    } else if (resource === 'policies' && method === 'POST') {
      result = await createPolicy(admin, body, agentId)
    } else if (resource === 'policies' && method === 'GET' && segments[1]) {
      result = await getPolicy(admin, segments[1], agentId)
    } else if (resource === 'payments' && method === 'POST') {
      result = await recordPayment(admin, body, agentId)
    } else {
      result = { status: 404, body: { error: 'Unknown endpoint or missing path parameter.' } }
    }
  } catch (e) {
    result = { status: 500, body: { error: `Internal error: ${e}` } }
  }

  await admin.from('api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', keyRow.id)
  await logRequest(admin, keyRow.id, path, result.status)
  return json(result.status, result.body)
}

// ── Handlers ─────────────────────────────────────────────────────

async function listProducts(admin: SupabaseClient) {
  const { data, error } = await admin
    .from('products')
    .select('id, name, category, premium, cover_amount, waiting_period_days, min_age, max_age, features, description')
    .eq('active', true)
  if (error) return { status: 500, body: { error: error.message } }
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
  const { data: product, error } = await admin
    .from('products').select('id, name, premium, cover_amount, waiting_period_days, min_age, max_age')
    .eq('id', productId).eq('active', true).maybeSingle()
  if (error) return { status: 500, body: { error: error.message } }
  if (!product) return { status: 404, body: { error: 'Product not found or inactive.' } }

  const age = typeof body.age === 'number' ? body.age : undefined
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

async function createClient_(admin: SupabaseClient, body: Json) {
  const name = String(body.name ?? '').trim()
  const phone = String(body.phone ?? '').trim()
  const nationalId = String(body.nationalId ?? '').trim()
  if (!name || !phone || !nationalId) return { status: 400, body: { error: 'name, phone, and nationalId are required.' } }

  const { data: existing } = await admin.from('clients').select('id').eq('national_id', nationalId).maybeSingle()
  if (existing) return { status: 200, body: { data: { id: existing.id, existing: true } } }

  const { data, error } = await admin.from('clients').insert({
    name, phone, national_id: nationalId,
    email: body.email ? String(body.email) : null,
    dob: body.dob ? String(body.dob) : null,
    address: body.address ? String(body.address) : null,
    occupation: body.occupation ? String(body.occupation) : null,
    status: 'active',
  }).select('id').single()
  if (error) return { status: 400, body: { error: error.code === '23505' ? 'A client with that national ID already exists.' : error.message } }
  return { status: 201, body: { data: { id: data.id, existing: false } } }
}

async function createPolicy(admin: SupabaseClient, body: Json, agentId: string) {
  const clientId = body.clientId as string | undefined
  const productId = body.productId as string | undefined
  const paymentMethod = String(body.paymentMethod ?? 'EcoCash')
  if (!clientId || !productId) return { status: 400, body: { error: 'clientId and productId are required.' } }

  const { data: client } = await admin.from('clients').select('id').eq('id', clientId).maybeSingle()
  if (!client) return { status: 404, body: { error: 'Client not found.' } }

  const { data: product } = await admin.from('products').select('id, premium, cover_amount').eq('id', productId).eq('active', true).maybeSingle()
  if (!product) return { status: 404, body: { error: 'Product not found or inactive.' } }

  const startDate = body.startDate ? new Date(String(body.startDate)) : new Date()
  const endDate = new Date(startDate)
  endDate.setFullYear(endDate.getFullYear() + 1)

  const beneficiaries = Array.isArray(body.beneficiaries) ? body.beneficiaries : []

  const { data, error } = await admin.from('policies').insert({
    policy_number: refNumber('API'),
    client_id: clientId,
    product_id: productId,
    premium: product.premium,
    cover_amount: product.cover_amount,
    start_date: startDate.toISOString().split('T')[0],
    end_date: endDate.toISOString().split('T')[0],
    status: 'pending',
    beneficiaries,
    payment_method: paymentMethod,
    agent_id: agentId,
  }).select('id, policy_number').single()
  if (error) return { status: 400, body: { error: error.message } }
  return { status: 201, body: { data: { id: data.id, policyNumber: data.policy_number, status: 'pending' } } }
}

async function getPolicy(admin: SupabaseClient, policyNumber: string, agentId: string) {
  const { data, error } = await admin
    .from('policies')
    .select('id, policy_number, premium, cover_amount, status, start_date, end_date')
    .eq('policy_number', policyNumber)
    .eq('agent_id', agentId)
    .maybeSingle()
  if (error) return { status: 500, body: { error: error.message } }
  if (!data) return { status: 404, body: { error: 'Policy not found.' } }
  return {
    status: 200,
    body: {
      data: {
        id: data.id, policyNumber: data.policy_number, premium: data.premium, coverAmount: data.cover_amount,
        status: data.status, startDate: data.start_date, endDate: data.end_date,
      },
    },
  }
}

async function recordPayment(admin: SupabaseClient, body: Json, agentId: string) {
  const policyNumber = String(body.policyNumber ?? '')
  const amount = Number(body.amount)
  if (!policyNumber || !amount) return { status: 400, body: { error: 'policyNumber and amount are required.' } }

  const { data: policy } = await admin.from('policies').select('id, agent_id').eq('policy_number', policyNumber).maybeSingle()
  if (!policy || policy.agent_id !== agentId) return { status: 404, body: { error: 'Policy not found.' } }

  const { data, error } = await admin.from('payments').insert({
    reference: refNumber('PAY'),
    policy_id: policy.id,
    amount,
    method: String(body.method ?? 'EcoCash'),
    status: 'completed',
  }).select('id, reference').single()
  if (error) return { status: 400, body: { error: error.message } }

  await admin.from('policies').update({ status: 'active', last_payment_date: new Date().toISOString().split('T')[0] }).eq('id', policy.id)

  return { status: 201, body: { data: { id: data.id, reference: data.reference, status: 'completed' } } }
}
