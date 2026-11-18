import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { BotClient, BotAgent, BotProduct, BotPolicy, Contact } from './types.js'
import { normalizeNationalId } from '../zwFormats.js'
import { fetchAllRows } from '../../../src/lib/paged.js'
import { downloadMedia } from './whatsapp.js'

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
    .select('id, name, phone, national_id, email, agent_id')
    .ilike('phone', `%${phoneSuffix(phone)}`)
    .limit(1).maybeSingle()
  return data ? toBotClient(data) : null
}

export async function clientByNationalId(admin: SupabaseClient, nationalId: string): Promise<BotClient | null> {
  // Rows written before normalisation may still carry separators, so the
  // canonical form and the raw text both match the same person.
  const raw = nationalId.trim()
  const { data } = await admin.from('clients')
    .select('id, name, phone, national_id, email, agent_id')
    .in('national_id', [...new Set([normalizeNationalId(raw), raw])])
    .limit(1).maybeSingle()
  return data ? toBotClient(data) : null
}

function toBotClient(r: Record<string, unknown>): BotClient {
  return {
    id: r.id as string, name: r.name as string, phone: r.phone as string,
    nationalId: (r.national_id as string) ?? '', email: (r.email as string) ?? '',
    agentId: (r.agent_id as string | null) ?? undefined,
  }
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
  const { data } = await fetchAllRows(
    () => admin.from('products')
      .select('id, name, code, category, premium, cover_amount, active')
      .eq('active', true).order('name'),
    { orderBy: 'id' },
  )
  return (data ?? []).map(r => ({
    id: r.id as string, name: r.name as string, code: (r.code as string) ?? '',
    category: r.category as string, premium: Number(r.premium), coverAmount: Number(r.cover_amount),
    active: r.active as boolean,
  }))
}

function toBotPolicy(r: Record<string, unknown>, status?: string): BotPolicy {
  const product = r.products as { name?: string; category?: string } | null
  return {
    id: r.id as string, policyNumber: r.policy_number as string,
    productId: (r.product_id as string) ?? '', productName: product?.name ?? '', productCategory: product?.category ?? '',
    premium: Number(r.premium), coverAmount: Number(r.cover_amount),
    status: status ?? r.status as string,
    nextPaymentDate: r.next_payment_date ? String(r.next_payment_date).slice(0, 10) : undefined,
    coverScope: (r.cover_scope as string | null) ?? undefined,
    onceOff: r.once_off === true,
    dependants: Array.isArray(r.dependants) ? r.dependants as BotPolicy['dependants'] : [],
  }
}

export async function policiesForClient(admin: SupabaseClient, clientId: string): Promise<BotPolicy[]> {
  const { data } = await fetchAllRows(
    () => admin.from('policies')
      .select('id, policy_number, product_id, premium, cover_amount, status, dependants, next_payment_date, cover_scope, once_off, products(name, category)')
      .eq('client_id', clientId),
    { orderBy: 'id' },
  )
  return (data ?? []).map(r => toBotPolicy(r as Record<string, unknown>))
}

export async function clientsOfAgent(admin: SupabaseClient, agentId: string): Promise<BotClient[]> {
  const { data } = await fetchAllRows(
    () => admin.from('clients')
      .select('id, name, phone, national_id, email, agent_id')
      .eq('agent_id', agentId).order('name'),
    { orderBy: 'id' },
  )
  return (data ?? []).map(toBotClient)
}

/** An agent's commission book: every live policy on their clients,
 *  valued at premium x product.commission_pct — the same field the
 *  portal's commission reports read, so both sides always agree. */
export async function commissionForAgent(admin: SupabaseClient, agentId: string): Promise<{ rows: string[]; total: number }> {
  const clients = await clientsOfAgent(admin, agentId)
  if (!clients.length) return { rows: [], total: 0 }
  const { data } = await fetchAllRows(
    () => admin.from('policies')
      .select('policy_number, premium, status, dependants, cover_scope, once_off, products(name, category, commission_pct)')
      .in('client_id', clients.map(c => c.id))
      .in('status', ['active', 'waiting_period']),
    { orderBy: 'id' },
  )
  const rows: string[] = []
  let total = 0
  for (const p of data ?? []) {
    const prod = p.products as { name?: string; category?: string; commission_pct?: number } | null
    const pct = Number(prod?.commission_pct ?? 0)
    const named = Array.isArray(p.dependants)
      ? (p.dependants as { name?: string; premium?: number }[]).filter(d => (d.name ?? '').trim())
      : []
    const memberPremium = (d: { premium?: number }) => Number(d.premium) > 0 ? Number(d.premium) : Number(p.premium)
    const billed = p.cover_scope === 'corporate' || p.cover_scope === 'group' || p.cover_scope === 'team' || p.once_off
      ? named.reduce((sum, d) => sum + memberPremium(d), 0)
      : prod?.category === 'agriculture'
        ? Number(p.premium)
        : Number(p.premium) + named.reduce((sum, d) => sum + memberPremium(d), 0)
    const amount = Math.round(billed * pct) / 100
    total += amount
    const period = p.once_off ? 'term' : prod?.category === 'agriculture' ? 'yr' : 'mo'
    rows.push(`${p.policy_number} (${prod?.name ?? 'policy'}): ${pct}% of $${billed.toFixed(2)} = $${amount.toFixed(2)}/${period}`)
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
  // One stored shape — "+263" + the 9-digit subscriber — the same format
  // rule the portal and partner API enforce (see api/_lib/zwFormats.ts).
  // A caller's own WhatsApp number arrives as "263…" digits, a typed
  // number as "0…" or "+263…" — all reduce to the canonical form;
  // anything that doesn't reduce is refused, never written.
  const digits = c.phone.replace(/\D/g, '')
  const local = digits.startsWith('263') ? digits.slice(3) : digits.startsWith('0') ? digits.slice(1) : digits
  if (!/^\d{9}$/.test(local)) {
    throw new Error(`'${c.phone}' is not a usable Zimbabwean number — +263 followed by 9 digits, or 10 digits starting with 0.`)
  }
  const { data, error } = await admin.from('clients').insert({
    name: c.name, national_id: c.nationalId, phone: `+263${local}`,
    email: c.email ?? '', dob: c.dob || null, gender: c.gender ?? null,
    address: '', status: 'active',
    agent_id: c.agentId ?? null,
    captured_by: c.agentId ?? null,
  }).select('id, name, phone, national_id, email, agent_id').single()
  if (error) throw new Error(`Could not save the client: ${error.message}`)
  return toBotClient(data)
}

export async function createPolicy(admin: SupabaseClient, p: {
  clientId: string; product: BotProduct; paymentMethod: string; agentId?: string; startDate: string; endDate: string
  /** Channel stamp — 'whatsapp_chatbot', 'motions_website', etc. */
  source?: string
  /** Medical declaration — required by the caller for health-category
   *  products (portal validates before this is ever invoked). */
  hasChronicIllness?: boolean; chronicIllnessDetails?: string
  /** Agriculture underwriting fields — hectarage is required by the portal. */
  growerNumber?: string; contractor?: string; hectarage?: number
}): Promise<BotPolicy> {
  if (p.product.category === 'agriculture' && !(Number(p.hectarage) > 0)) {
    throw new Error('Agriculture cover requires a planted hectarage.')
  }
  const policyNumber = await nextPolicyNumber(admin, p.product)
  const { data, error } = await admin.from('policies').insert({
    policy_number: policyNumber, client_id: p.clientId, product_id: p.product.id,
    premium: p.product.premium, cover_amount: p.product.coverAmount,
    start_date: p.startDate, end_date: p.endDate, status: 'pending',
    dependants: [], payment_method: p.paymentMethod,
    agent_id: p.agentId ?? null, captured_by: p.agentId ?? null,
    source: p.source ?? 'whatsapp_chatbot',
    has_chronic_illness: p.hasChronicIllness ?? null,
    chronic_illness_details: p.chronicIllnessDetails ?? null,
    grower_number: p.growerNumber ?? null,
    contractor: p.contractor ?? null,
    hectarage: p.hectarage ?? null,
  }).select('id, policy_number, product_id, premium, cover_amount, status, dependants, products(name, category)').single()
  if (error) throw new Error(`Could not save the policy: ${error.message}`)
  return toBotPolicy(data as Record<string, unknown>)
}

/** Create a policy in the pending_policies table - used for website signups
 *  where payment must be confirmed before the policy is finalized. */
export async function createPendingPolicy(admin: SupabaseClient, p: {
  clientId: string; product: BotProduct; paymentMethod: string; agentId?: string; startDate: string; endDate: string
  /** Channel stamp — 'motions_website', etc. */
  source?: string
  /** Medical declaration — required by the caller for health-category products. */
  hasChronicIllness?: boolean; chronicIllnessDetails?: string
  /** Agriculture underwriting fields — hectarage is required by the portal. */
  growerNumber?: string; contractor?: string; hectarage?: number
}): Promise<BotPolicy> {
  if (p.product.category === 'agriculture' && !(Number(p.hectarage) > 0)) {
    throw new Error('Agriculture cover requires a planted hectarage.')
  }
  const policyNumber = await nextPolicyNumber(admin, p.product)
  const { data, error } = await admin.from('pending_policies').insert({
    policy_number: policyNumber, client_id: p.clientId, product_id: p.product.id,
    premium: p.product.premium, cover_amount: p.product.coverAmount,
    start_date: p.startDate, end_date: p.endDate,
    dependants: [], payment_method: p.paymentMethod,
    agent_id: p.agentId ?? null, source: p.source ?? 'motions_website',
    has_chronic_illness: p.hasChronicIllness ?? null,
    chronic_illness_details: p.chronicIllnessDetails ?? null,
    grower_number: p.growerNumber ?? null,
    contractor: p.contractor ?? null,
    hectarage: p.hectarage ?? null,
  }).select('id, policy_number, product_id, premium, cover_amount, dependants, products(name, category)').single()
  if (error) throw new Error(`Could not save the pending policy: ${error.message}`)
  return toBotPolicy(data as Record<string, unknown>, 'pending')
}

/** Check for existing pending policies for a client */
export async function pendingPoliciesForClient(admin: SupabaseClient, clientId: string): Promise<BotPolicy[]> {
  const { data } = await admin.from('pending_policies')
    .select('id, policy_number, product_id, premium, cover_amount, dependants, products(name, category)')
    .eq('client_id', clientId)
  return (data ?? []).map(r => toBotPolicy(r as Record<string, unknown>, 'pending'))
}

/** Move a pending row back into the normal pending-policy queue when the
 *  payer switches away from Paynow (EcoCash push or office/cash). Staff can
 *  then approve and record it in the same place as every other pending sale. */
export async function promotePendingPolicy(admin: SupabaseClient, pendingId: string, paymentMethod?: string): Promise<BotPolicy | null> {
  const { data: pending } = await admin.from('pending_policies')
    .select('id, policy_number, client_id, product_id, premium, cover_amount, start_date, end_date, dependants, payment_method, source, grower_number, contractor, hectarage, agent_id, cover_scope, team_activity, has_chronic_illness, chronic_illness_details, products(name, category)')
    .eq('id', pendingId).maybeSingle()
  if (!pending) return null
  const { data: policy, error } = await admin.from('policies').insert({
    policy_number: pending.policy_number,
    client_id: pending.client_id, product_id: pending.product_id,
    premium: pending.premium, cover_amount: pending.cover_amount,
    start_date: pending.start_date, end_date: pending.end_date,
    dependants: pending.dependants ?? [],
    payment_method: paymentMethod ?? pending.payment_method, source: pending.source,
    grower_number: pending.grower_number, contractor: pending.contractor,
    hectarage: pending.hectarage, agent_id: pending.agent_id,
    cover_scope: pending.cover_scope, team_activity: pending.team_activity,
    has_chronic_illness: pending.has_chronic_illness,
    chronic_illness_details: pending.chronic_illness_details,
    status: 'pending', next_payment_date: new Date().toISOString().slice(0, 10),
  }).select('id, policy_number, product_id, premium, cover_amount, status, dependants, cover_scope, once_off, products(name, category)').single()
  if (error) throw new Error(`Could not move the pending policy to staff review: ${error.message}`)
  await admin.from('pending_policies').delete().eq('id', pendingId)
  return toBotPolicy(policy as Record<string, unknown>)
}

/** What one billing period costs — the server-side twin of
 *  src/lib/premium.ts. Agriculture bills the crop once; group/corporate/
 *  team and once-off packages bill only the roster members the organisation
 *  named; ordinary products bill the policyholder plus every named
 *  dependant. Blank roster rows are never billed. */
export function botBillablePremium(policy: BotPolicy): number {
  const named = policy.dependants.filter(d => (d.name ?? '').trim().length > 0)
  const memberPremium = (d: BotPolicy['dependants'][number]) => {
    const p = Number(d.premium)
    return Number.isFinite(p) && p > 0 ? p : policy.premium
  }
  if (policy.coverScope === 'corporate' || policy.coverScope === 'group' || policy.coverScope === 'team' || policy.onceOff) {
    return Math.round(named.reduce((sum, d) => sum + memberPremium(d), 0) * 100) / 100
  }
  if (policy.productCategory === 'agriculture') return Math.round(policy.premium * 100) / 100
  const total = named.reduce((sum, d) => sum + memberPremium(d), policy.premium)
  return Math.round(total * 100) / 100
}

export async function completedPaymentsForPolicy(admin: SupabaseClient, policyId: string): Promise<{ amount: number; date: string }[]> {
  const { data } = await admin.from('payments')
    .select('amount, payment_date')
    .eq('policy_id', policyId)
    .eq('status', 'completed')
  return (data ?? []).map(r => ({ amount: Number(r.amount) || 0, date: String(r.payment_date ?? '').slice(0, 10) }))
}

/** Append a dependant to a policy's JSONB dependants array. The same ID /
 *  birth-record number cannot be added twice. */
export async function addDependant(admin: SupabaseClient, policyId: string, dependant: Record<string, unknown>): Promise<void> {
  const { data: pol } = await admin.from('policies').select('dependants').eq('id', policyId).single()
  const list = Array.isArray(pol?.dependants) ? (pol!.dependants as Record<string, unknown>[]) : []
  const incomingId = normalizeNationalId(String(dependant.nationalId ?? ''))
  if (incomingId && list.some(d => normalizeNationalId(String(d.nationalId ?? '')) === incomingId)) {
    throw new Error('That dependant is already on this policy.')
  }
  const { error } = await admin.from('policies').update({ dependants: [...list, dependant] }).eq('id', policyId)
  if (error) throw new Error(`Could not add the dependant: ${error.message}`)
}

/** Staff-visible work item for a dependant-removal request — the bot never
 *  deletes cover silently. */
export async function createDependantRemovalTask(admin: SupabaseClient, opts: {
  client: BotClient; policy: BotPolicy; dependant: BotPolicy['dependants'][number]
}): Promise<void> {
  const { error } = await admin.from('tasks').insert({
    title: `Remove dependant from ${opts.policy.policyNumber}`,
    description:
      `Requested through WhatsApp.\n\n` +
      `Client: ${opts.client.name} (${opts.client.nationalId})\n` +
      `Dependant: ${opts.dependant.name} (${opts.dependant.nationalId ?? 'no id'})\n` +
      `Policy: ${opts.policy.policyNumber} — ${opts.policy.productName}\n\n` +
      `Verify the request, remove the dependant only after staff approval, then tell the policyholder.`,
    priority: 'medium', status: 'open', assignee_id: null, assignee_name: '',
    created_by: null, created_by_name: 'WhatsApp Bot', due_date: null,
  })
  if (error) throw new Error(`Could not send the removal request: ${error.message}`)
}

/** Download a WhatsApp attachment and put it in the private documents
 *  bucket under the claim id. Returns the path to store in claims.documents. */
export async function storeClaimMedia(admin: SupabaseClient, claimId: string, mediaId: string, filename: string): Promise<string> {
  const media = await downloadMedia(mediaId, filename)
  const path = `claims/${claimId}/${Date.now()}-${media.filename}`
  const { error } = await admin.storage.from('documents').upload(path, media.bytes, {
    contentType: media.mimeType, upsert: false,
  })
  if (error) throw new Error(`Could not store the claim attachment: ${error.message}`)
  return path
}

/** A WhatsApp-filed claim — intake stage, staff enrich it on the portal.
 *  `id` is generated before the media is downloaded so the stored file can
 *  sit under documents/claims/<claim id>/, the same path rule the portal's
 *  signed-document reader expects. */
export async function createClaim(admin: SupabaseClient, c: {
  id?: string; policyId: string; description: string; documents?: string[]
}): Promise<string> {
  const id = c.id ?? randomUUID()
  const claimNumber = `CLM${new Date().getFullYear()}${String(Date.now()).slice(-4)}${Math.random().toString(36).slice(2, 5).toUpperCase()}`
  const { error } = await admin.from('claims').insert({
    id, claim_number: claimNumber, policy_id: c.policyId, claim_type: 'general',
    amount: 0, status: 'pending', stage: 'intake',
    date_of_event: new Date().toISOString().slice(0, 10),
    date_submitted: new Date().toISOString(),
    description: c.description, fraud_score: 0, documents: c.documents ?? [],
  })
  if (error) throw new Error(`Could not file the claim: ${error.message}`)
  return id
}
