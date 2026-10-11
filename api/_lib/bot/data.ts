import type { SupabaseClient } from '@supabase/supabase-js'
import type { BotClient, BotAgent, BotProduct, BotPolicy, Contact } from './types.js'

/**
 * The bot's data layer — every function the Frappe version asked
 * frappe.get_all for, answered from the SAME live tables the portal
 * reads. A client registered over WhatsApp exists in the portal
 * immediately; a policy bought there appears in My Policies.
 */

/** WhatsApp reports E.164 digits ('26377...'); staff type '077...' or
 *  '+263 77...'. Both sides collapse to the local subscriber form so
 *  formats never miss each other. */
export function normalizePhone(raw: string): string {
  let d = String(raw ?? '').replace(/\D/g, '')
  if (d.startsWith('263')) d = `0${d.slice(3)}`            // 263775668334 -> 0775668334
  if (!d.startsWith('0') && d.length <= 9) d = `0${d}`     // 775668334 -> 0775668334
  return d
}

function phoneSuffix(raw: string): string {
  return String(raw ?? '').replace(/\D/g, '').slice(-9)   // matches any stored format
}

async function agentByPhone(admin: SupabaseClient, phone: string): Promise<BotAgent | null> {
  const { data } = await admin.from('profiles')
    .select('id, name, email, phone')
    .eq('role', 'agent').eq('active', true)
    .ilike('phone', `%${phoneSuffix(phone)}`)
    .limit(1).maybeSingle()
  if (!data) return null
  return { id: data.id as string, name: data.name as string, email: (data.email as string) ?? '' }
}

export async function clientByPhone(admin: SupabaseClient, phone: string): Promise<BotClient | null> {
  const { data } = await admin.from('clients')
    .select('id, name, phone, national_id, email')
    .ilike('phone', `%${phoneSuffix(phone)}`)
    .limit(1).maybeSingle()
  return data ? toBotClient(data) : null
}

export async function clientByNationalId(admin: SupabaseClient, nationalId: string): Promise<BotClient | null> {
  const { data } = await admin.from('clients')
    .select('id, name, phone, national_id, email')
    .eq('national_id', nationalId.trim())
    .limit(1).maybeSingle()
  return data ? toBotClient(data) : null
}

function toBotClient(r: Record<string, unknown>): BotClient {
  return { id: r.id as string, name: r.name as string, phone: r.phone as string, nationalId: (r.national_id as string) ?? '', email: (r.email as string) ?? '' }
}

/** Agent first, then client, then unknown — same order as
 *  find_active_contact() in the Frappe version. */
export async function findContact(admin: SupabaseClient, phone: string): Promise<Contact> {
  const agent = await agentByPhone(admin, phone)
  if (agent) return { type: 'agent', agent }
  const client = await clientByPhone(admin, phone)
  if (client) return { type: 'client', client }
  return { type: 'unknown' }
}

/** Products = the plans. Frappe had Policy -> Packages; the IMS keeps
 *  one row per plan, so product-pick replaces the two-step pick. */
export async function getActiveProducts(admin: SupabaseClient): Promise<BotProduct[]> {
  const { data } = await admin.from('products')
    .select('id, name, code, category, premium, cover_amount, active')
    .eq('active', true).order('name')
  return (data ?? []).map(r => ({
    id: r.id as string, name: r.name as string, code: (r.code as string) ?? '',
    category: r.category as string, premium: Number(r.premium), coverAmount: Number(r.cover_amount),
    active: r.active as boolean,
  }))
}

export async function policiesForClient(admin: SupabaseClient, clientId: string): Promise<BotPolicy[]> {
  const { data } = await admin.from('policies')
    .select('id, policy_number, premium, cover_amount, status, dependants, products(name)')
    .eq('client_id', clientId)
  return (data ?? []).map(r => ({
    id: r.id as string, policyNumber: r.policy_number as string,
    productName: (r.products as { name?: string } | null)?.name ?? '',
    premium: Number(r.premium), coverAmount: Number(r.cover_amount),
    status: r.status as string,
    dependants: Array.isArray(r.dependants) ? r.dependants as BotPolicy['dependants'] : [],
  }))
}

export async function clientsOfAgent(admin: SupabaseClient, agentId: string): Promise<BotClient[]> {
  const { data } = await admin.from('clients')
    .select('id, name, phone, national_id, email')
    .eq('agent_id', agentId).order('name')
  return (data ?? []).map(toBotClient)
}

/** An agent's commission book: every live policy on their clients,
 *  valued at premium x product.commission_pct — the same field the
 *  portal's commission reports read, so both sides always agree. */
export async function commissionForAgent(admin: SupabaseClient, agentId: string): Promise<{ rows: string[]; total: number }> {
  const clients = await clientsOfAgent(admin, agentId)
  if (!clients.length) return { rows: [], total: 0 }
  const { data } = await admin.from('policies')
    .select('policy_number, premium, status, products(name, commission_pct)')
    .in('client_id', clients.map(c => c.id))
    .in('status', ['active', 'waiting_period'])
  const rows: string[] = []
  let total = 0
  for (const p of data ?? []) {
    const prod = p.products as { name?: string; commission_pct?: number } | null
    const pct = Number(prod?.commission_pct ?? 0)
    const amount = Math.round(Number(p.premium) * pct) / 100
    total += amount
    rows.push(`${p.policy_number} (${prod?.name ?? 'policy'}): ${pct}% of $${Number(p.premium).toFixed(2)} = $${amount.toFixed(2)}/mo`)
  }
  return { rows, total }
}

/** Policy-number prefix — same rules as src/lib/policyNumbers.ts,
 *  re-stated here because api/ can't import the browser bundle
 *  (it pulls in vite env). Keep in sync with that file. */
function policyPrefix(product: { name?: string; code?: string; category?: string }): string {
  const name = (product.name ?? '').toLowerCase()
  if (name.includes('tobacco') || name.includes('field to floor')) return 'TOB'
  if (name.includes('funeral') || name.includes('burial') || (name.includes('cash plan') && !name.includes('hospital'))) return 'FCP'
  if (name.includes('hospital')) return 'HCP'
  if (name.includes('medical')) return 'MED'
  if (name.includes('legal')) return 'LEG'
  const code = (product.code ?? '').replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase()
  if (code.length === 3) return code
  switch (product.category) {
    case 'funeral': return 'FCP'
    case 'health': return 'MED'
    case 'agriculture': return 'AGR'
    default: return 'POL'
  }
}

async function nextPolicyNumber(admin: SupabaseClient, product: BotProduct): Promise<string> {
  const prefix = policyPrefix(product)
  const { data: seq, error } = await admin.rpc('next_policy_sequence', { p_prefix: prefix })
  if (!error && typeof seq === 'number') return `${prefix}${String(seq).padStart(4, '0')}`
  throw new Error(`Could not issue a policy number: ${error?.message ?? 'no sequence'}`)
}

export async function createClient(admin: SupabaseClient, c: {
  name: string; nationalId: string; phone: string; email?: string; dob?: string; gender?: string; agentId?: string
}): Promise<BotClient> {
  const { data, error } = await admin.from('clients').insert({
    name: c.name, national_id: c.nationalId, phone: c.phone,
    email: c.email ?? '', dob: c.dob || null, gender: c.gender ?? null,
    address: '', status: 'active',
    agent_id: c.agentId ?? null,
  }).select('id, name, phone, national_id, email').single()
  if (error) throw new Error(`Could not save the client: ${error.message}`)
  return toBotClient(data)
}

export async function createPolicy(admin: SupabaseClient, p: {
  clientId: string; product: BotProduct; paymentMethod: string; agentId?: string; startDate: string; endDate: string
}): Promise<BotPolicy> {
  const policyNumber = await nextPolicyNumber(admin, p.product)
  const { data, error } = await admin.from('policies').insert({
    policy_number: policyNumber, client_id: p.clientId, product_id: p.product.id,
    premium: p.product.premium, cover_amount: p.product.coverAmount,
    start_date: p.startDate, end_date: p.endDate, status: 'pending',
    dependants: [], payment_method: p.paymentMethod,
    agent_id: p.agentId ?? null, source: 'whatsapp_chatbot',
  }).select('id, policy_number, premium, cover_amount, status, dependants, products(name)').single()
  if (error) throw new Error(`Could not save the policy: ${error.message}`)
  return {
    id: data.id as string, policyNumber: data.policy_number as string,
    productName: (data.products as { name?: string } | null)?.name ?? '',
    premium: Number(data.premium), coverAmount: Number(data.cover_amount),
    status: data.status as string, dependants: [],
  }
}

/** Append a dependant to a policy's JSONB dependants array. */
export async function addDependant(admin: SupabaseClient, policyId: string, dependant: Record<string, unknown>): Promise<void> {
  const { data: pol } = await admin.from('policies').select('dependants').eq('id', policyId).single()
  const list = Array.isArray(pol?.dependants) ? (pol!.dependants as unknown[]) : []
  const { error } = await admin.from('policies').update({ dependants: [...list, dependant] }).eq('id', policyId)
  if (error) throw new Error(`Could not add the dependant: ${error.message}`)
}

/** A WhatsApp-filed claim — intake stage, staff enrich it on the portal. */
export async function createClaim(admin: SupabaseClient, c: {
  policyId: string; description: string; documents?: unknown
}): Promise<void> {
  const claimNumber = `CLM${new Date().getFullYear()}${String(Date.now()).slice(-4)}${Math.random().toString(36).slice(2, 5).toUpperCase()}`
  const { error } = await admin.from('claims').insert({
    claim_number: claimNumber, policy_id: c.policyId, claim_type: 'general',
    amount: 0, status: 'submitted', stage: 'intake',
    date_of_event: new Date().toISOString().slice(0, 10),
    date_submitted: new Date().toISOString(),
    description: c.description, fraud_score: 0, documents: c.documents ?? [],
  })
  if (error) throw new Error(`Could not file the claim: ${error.message}`)
}
