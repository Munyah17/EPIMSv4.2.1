import { supabase } from './supabase'
import { health } from './health'
// localStore is deliberately NOT imported here. It seeds itself from
// src/data/mockData.ts, so serving it on a failed read put invented clients,
// policies and payments in front of staff as though they were the real book.
// Reads fall back to offlineCache (real rows previously fetched) or to an
// empty result with an explanation; writes fail and say why.
import { cacheGet, cacheSet } from './offlineCache'
import { hammingDistance, DUPLICATE_THRESHOLD } from './photoHash'
import { policyBillablePremium, billableHeadCount } from './premium'
import { toIsoDate } from './dateUtils'
import type { ExchangeRate } from './exchangeRate'
import type {
  AppUser, Client, Product, ClientSafeProduct, Policy, Claim, Payment,
  Ticket, EmailMessage, Lead, FraudCase, Reminder, CautionFlag,
  PolicyStatus, ClaimStatus, PaymentStatus, PaymentMethod,
  TicketStatus, TicketPriority, LeadStatus, FraudCaseStatus, CustomRole,
  ClaimAssessment, PolicyAssessment, AssessmentPhoto, CropType, FraudSignalRule, HeroSlide,
  PolicyCard, Group, GroupMember, Invoice, InvoiceStatus, AgentProfile,
  MarketingContact, MarketingTemplate, MarketingCampaign, CampaignRecipient,
} from '../types'
import { STAFF_ROLES } from '../types'

// ── helpers ───────────────────────────────────────────────────────
function date(v: string | null | undefined): string { return v?.split('T')[0] ?? '' }
// uid() used to mint ids for records invented in browser storage when a
// write failed. Writes no longer do that, so nothing needs a fake id.

/** Try a Supabase query; record timing/health; return {ok, data, error}. */
async function sb<T>(
  table: string,
  type: 'read' | 'write' | 'delete',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: () => PromiseLike<{ data: any; error: any }>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  isListOk: (d: any) => boolean = (d) => d !== null,
): Promise<{ ok: boolean; data: T | null; error: string | null }> {
  const start = Date.now()
  try {
    const { data, error } = await query()
    const duration = Date.now() - start
    const ok = !error && isListOk(data)
    health.record({ ts: Date.now(), type, table, success: ok, duration, source: 'supabase',
      detail: error ? String(error?.message ?? error) : undefined })
    return { ok, data: ok ? data : null, error: ok ? null : (error?.message ?? 'The database rejected this request.') }
  } catch (e) {
    const duration = Date.now() - start
    health.record({ ts: Date.now(), type, table, success: false, duration, source: 'supabase',
      detail: String(e) })
    return { ok: false, data: null, error: String(e) }
  }
}

/**
 * A write that did not reach the database is a failure, and must be
 * reported as one.
 *
 * Every create/update below used to fall back to browser-local storage on
 * any error and return `error: null`, so the UI announced success. Nothing
 * ever syncs that storage back, so the record existed in exactly one
 * browser: invisible to every colleague, gone when the cache cleared. It is
 * how a policy captured on one laptop was simply not there for anyone else.
 *
 * Reads still fall back to the local cache — showing the last known data
 * beats showing nothing — but a write now surfaces the real reason.
 */
/** PostgREST's "no rows" error is what RLS looks like when an update is
 *  refused. Say that, instead of the raw coerce message. */
function explainWriteError(error: string | null): string | null {
  if (!error) return error
  if (/cannot coerce|0 rows|no\) rows returned|PGRST116/i.test(error)) {
    return 'The database did not save this change. Your account may not be allowed to edit this record, or it was removed.'
  }
  if (/invalid input syntax for type uuid/i.test(error)) {
    return 'That agent could not be saved. Pick an agent from the list, or leave the field unassigned.'
  }
  if (/invalid input syntax for type date/i.test(error)) {
    return 'One of the dates is not a real date. Check the payment date and the end date, then try again.'
  }
  if (/invalid input syntax for type numeric/i.test(error)) {
    return 'Premium and cover amount must be numbers.'
  }
  return error
}

function writeFailed(table: string, error: string | null): { data: null; error: string } {
  health.record({ ts: Date.now(), type: 'write', table, success: false, duration: 0, source: 'supabase', detail: error ?? undefined })
  window.dispatchEvent(new CustomEvent(DB_FALLBACK_EVENT, { detail: { table, type: 'write', error } }))
  return { data: null, error: error ?? 'Could not save to the database. Check your connection and try again — nothing has been saved.' }
}

/**
 * Optional-schema probing. Columns added by migrations that the user runs
 * by hand (groups/group_cover on policies, transaction_id on payments)
 * are asked for with a cheap `select(column).limit(0)`; the answer is
 * remembered so every subsequent query can pick the right SELECT string
 * and write payload. A false is re-checked after a minute so the feature
 * wakes up on its own once the migration lands — a true is cached for
 * the session (columns don't disappear).
 */
const schemaFlags = new Map<string, { ok: boolean; at: number }>()
const SCHEMA_PROBE_TTL_MS = 60_000

async function hasColumn(table: string, column: string): Promise<boolean> {
  const key = `${table}.${column}`
  const hit = schemaFlags.get(key)
  if (hit && (hit.ok || Date.now() - hit.at < SCHEMA_PROBE_TTL_MS)) return hit.ok
  const { error } = await supabase.from(table).select(column).limit(0)
  const ok = !error
  schemaFlags.set(key, { ok, at: Date.now() })
  return ok
}

const policySelect = async () => {
  const [groupCols, medCols, hectarageCol, capturedCol] = await Promise.all([
    hasColumn('policies', 'group_id'),
    hasColumn('policies', 'has_chronic_illness'),
    // The med block grew hectarage after contractor — probe the newest
    // column too, or a database one generation behind would fail every
    // policy read instead of degrading to the older select.
    hasColumn('policies', 'hectarage'),
    // captured_by records the staff member who captured the policy —
    // probed so a database before that migration still reads fine.
    hasColumn('policies', 'captured_by'),
  ])
  if (groupCols && medCols && hectarageCol) return POLICY_SELECT + (capturedCol ? POLICY_SELECT_CAP : '')
  if (groupCols) return POLICY_SELECT_GROUP + (capturedCol ? POLICY_SELECT_CAP : '')
  return POLICY_SELECT_BASE + (capturedCol ? POLICY_SELECT_CAP : '')
}
/** Optional columns are probed (hasColumn) so the select survives an
 *  env where a migration hasn't run — transaction_id, pop_url and
 *  pop_description all came later than the base row. */
const paymentSelect = async () => {
  const extras = (await Promise.all([
    hasColumn('payments', 'transaction_id'),
    hasColumn('payments', 'pop_url'),
    hasColumn('payments', 'pop_description'),
  ]).then(([txn, pop, desc]) => [
    txn ? 'transaction_id' : '',
    pop ? 'pop_url' : '',
    desc ? 'pop_description' : '',
  ])).filter(Boolean).join(', ')
  return extras ? PAYMENT_SELECT_BASE.replace('payment_date,', `payment_date, ${extras},`) : PAYMENT_SELECT_BASE
}

/** Dispatched whenever a read/write falls back to browser-local storage, so the UI can warn the user. */
export const DB_FALLBACK_EVENT = 'ims:db-fallback'

function local(table: string, type: 'read' | 'write' | 'delete') {
  health.record({ ts: Date.now(), type, table, success: true, duration: 0, source: 'local' })
  window.dispatchEvent(new CustomEvent(DB_FALLBACK_EVENT, { detail: { table, type } }))
}

// ── Row transformers ──────────────────────────────────────────────

function toProfile(r: Record<string, unknown>): AppUser {
  return {
    id:          r.id as string,
    name:        r.name as string,
    username:    (r.username as string | null) ?? undefined,
    email:       (r.email as string) ?? '',
    role:        r.role as AppUser['role'],
    department:  (r.department as string) ?? '',
    phone:       r.phone as string | undefined,
    active:      r.active as boolean,
    permissions: (r.permissions as string[]) ?? [],
    customRoleId:   (r.custom_role_id as string | null) ?? undefined,
    customRoleName: (r.custom_roles as { name?: string } | null)?.name ?? undefined,
    lastLogin:   r.last_login as string | undefined,
  }
}

function toCustomRole(r: Record<string, unknown>): CustomRole {
  return {
    id:          r.id as string,
    name:        r.name as string,
    description: (r.description as string | null) ?? undefined,
    permissions: (r.permissions as string[]) ?? [],
    createdBy:   (r.created_by as string | null) ?? undefined,
    createdAt:   r.created_at as string,
  }
}

function toClient(r: Record<string, unknown>): Client {
  return {
    id:          r.id as string,
    name:        r.name as string,
    email:       (r.email as string) ?? '',
    phone:       r.phone as string,
    nationalId:  r.national_id as string,
    dob:         date(r.dob as string),
    gender:      (r.gender as string | null) ?? undefined,
    address:     (r.address as string) ?? '',
    occupation:  r.occupation as string | undefined,
    insurer:     (r.insurer as Client['insurer']) ?? undefined,
    insurerProvisional: (r.insurer_provisional as boolean) ?? false,
    agentId:     (r.agent_id as string | null) ?? undefined,
    createdAt:   date(r.created_at as string),
    policyCount: (r.policy_count as number) ?? 0,
    status:      r.status as Client['status'],
  }
}

/** Shared by toProduct and toClientSafeProduct — every column the client-safe
 *  view actually carries. Kept as one function so the two never drift apart
 *  on the fields both are allowed to see. */
function toClientSafeProduct(r: Record<string, unknown>): ClientSafeProduct {
  return {
    id:                r.id as string,
    name:              r.name as string,
    code:              r.code as string,
    category:          r.category as Product['category'],
    premium:           r.premium as number,
    coverAmount:       r.cover_amount as number,
    waitingPeriodDays: r.waiting_period_days as number,
    minAge:            r.min_age as number,
    maxAge:            r.max_age as number,
    active:            r.active as boolean,
    features:          (r.features as string[]) ?? [],
    description:       (r.description as string) ?? '',
    excess:            (r.excess as string) || undefined,
  }
}

function toProduct(r: Record<string, unknown>): Product {
  return {
    ...toClientSafeProduct(r),
    commissionPct:     r.commission_pct as number,
    policiesCount:     (r.policies_count as number) ?? 0,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toPolicy(r: any): Policy {
  return {
    id:              r.id,
    policyNumber:    r.policy_number,
    clientId:        r.clients?.id ?? r.client_id ?? '',
    clientName:      r.clients?.name ?? '',
    productId:       r.products?.id ?? r.product_id ?? '',
    productName:     r.products?.name ?? '',
    productCategory: r.products?.category ?? undefined,
    excess:          r.products?.excess ?? undefined,
    premium:         r.premium,
    coverAmount:     r.cover_amount,
    startDate:       date(r.start_date),
    endDate:         date(r.end_date),
    status:          r.status as PolicyStatus,
    dependants:      r.dependants ?? [],
    paymentMethod:   r.payment_method,
    insurer:         r.insurer ?? undefined,
    growerNumber:    r.grower_number ?? undefined,
    gpsLat:          r.gps_lat ?? undefined,
    gpsLng:          r.gps_lng ?? undefined,
    agentId:         r.profiles?.id ?? r.agent_id,
    agentName:       r.profiles?.name,
    // The staff member who captured the policy — a different person from
    // the agent/field officer who sourced the business.
    capturedById:    r.capturer?.id ?? r.captured_by ?? undefined,
    capturedByName:  r.capturer?.name ?? undefined,
    groupId:         r.groups?.id ?? r.group_id ?? undefined,
    groupName:       r.groups?.name ?? undefined,
    coverScope:      (r.cover_scope as Policy['coverScope']) ?? 'individual',
    teamActivity:    r.team_activity ?? undefined,
    hasChronicIllness: r.has_chronic_illness ?? undefined,
    chronicIllnessDetails: r.chronic_illness_details ?? undefined,
    contractor:      r.contractor ?? undefined,
    hectarage:       r.hectarage != null ? Number(r.hectarage) : undefined,
    source:          r.source ?? undefined,
    createdAt:       date(r.created_at),
    nextPaymentDate: r.next_payment_date ? date(r.next_payment_date) : undefined,
    lastPaymentDate: r.last_payment_date ? date(r.last_payment_date) : undefined,
  }
}

function toGroup(r: Record<string, unknown>, memberCount?: number): Group {
  return {
    id:                 r.id as string,
    name:               r.name as string,
    groupType:          r.group_type as Group['groupType'],
    registrationNumber: (r.registration_number as string | null) ?? undefined,
    customType:         (r.custom_type as string | null) ?? undefined,
    description:        (r.description as string | null) ?? undefined,
    orgPhone:           (r.org_phone as string | null) ?? undefined,
    orgEmail:           (r.org_email as string | null) ?? undefined,
    contactName:        (r.contact_name as string | null) ?? undefined,
    contactEmail:       (r.contact_email as string | null) ?? undefined,
    contactPhone:       (r.contact_phone as string | null) ?? undefined,
    address:            (r.address as string | null) ?? undefined,
    active:             r.active as boolean,
    memberCount,
    createdAt:          r.created_at as string,
  }
}

function toGroupMember(r: Record<string, unknown>): GroupMember {
  return {
    id:         r.id as string,
    groupId:    r.group_id as string,
    fullName:   r.full_name as string,
    nationalId: (r.national_id as string | null) ?? undefined,
    dob:        date(r.dob as string | null) || undefined,
    phone:      (r.phone as string | null) ?? undefined,
    position:   (r.position as string | null) ?? undefined,
    memberNo:   (r.member_no as string | null) ?? undefined,
    premium:    r.premium != null ? Number(r.premium) : undefined,
    coverAmount: r.cover_amount != null ? Number(r.cover_amount) : undefined,
    status:     r.status as GroupMember['status'],
    createdAt:  r.created_at as string,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toClaim(r: any): Claim {
  const pol = r.policies
  return {
    id:            r.id,
    claimNumber:   r.claim_number,
    policyId:      r.policy_id,
    policyNumber:  pol?.policy_number ?? '',
    clientId:      pol?.clients?.id ?? '',
    clientName:    pol?.clients?.name ?? '',
    productName:   pol?.products?.name ?? '',
    claimType:     r.claim_type,
    amount:        r.amount,
    status:        r.status as ClaimStatus,
    stage:         (r.stage as Claim['stage']) ?? 'intake',
    category:      r.category ?? pol?.products?.category ?? undefined,
    dateOfEvent:   date(r.date_of_event),
    dateSubmitted: date(r.date_submitted),
    description:   r.description ?? '',
    fraudScore:    r.fraud_score,
    assignedTo:    r.assigned_to ?? undefined,
    assignedName:  r.assignee?.name ?? undefined,
    agentId:       r.agent_id ?? undefined,
    agentName:     r.agent?.name ?? undefined,
    assessmentNotes: r.assessment_notes ?? undefined,
    documents:     r.documents ?? [],
    notes:         r.notes ?? undefined,
    resolvedAt:    r.resolved_at ?? undefined,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toPayment(r: any): Payment {
  const pol = r.policies
  return {
    id:            r.id,
    reference:     r.reference,
    policyId:      r.policy_id,
    policyNumber:  pol?.policy_number ?? '',
    clientName:    pol?.clients?.name ?? '',
    amount:        r.amount,
    method:        r.method as PaymentMethod,
    status:        r.status as PaymentStatus,
    date:          date(r.payment_date),
    transactionId: r.transaction_id ?? undefined,
    recordedAt:    r.created_at ?? undefined,
    splitPayments: r.split_payments ?? undefined,
    popUrl:        r.pop_url ?? undefined,
    popDescription: (r.pop_description as string | null) ?? undefined,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toTicket(r: any): Ticket {
  return {
    id:           r.id,
    ticketNumber: r.ticket_number,
    clientId:     r.clients?.id ?? r.client_id ?? '',
    clientName:   r.clients?.name ?? '',
    subject:      r.subject,
    description:  r.description ?? '',
    status:       r.status as TicketStatus,
    priority:     r.priority as TicketPriority,
    category:     r.category,
    assignedTo:   r.assigned_to ?? undefined,
    assignedName: r.profiles?.name ?? undefined,
    createdAt:    r.created_at,
    updatedAt:    r.updated_at,
    messages:     r.messages ?? [],
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toEmail(r: any): EmailMessage {
  return {
    id:          r.id,
    from:        r.from_address,
    fromName:    r.from_name ?? r.from_address,
    to:          r.to_address,
    cc:          r.cc ?? undefined,
    subject:     r.subject,
    body:        r.body ?? '',
    timestamp:   r.created_at ?? r.timestamp,
    read:        r.read,
    starred:     r.starred ?? false,
    folder:      r.folder,
    linkedTo:    r.linked_to ?? undefined,
    attachments: r.attachments ?? [],
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toLead(r: any): Lead {
  return {
    id:              r.id,
    name:            r.name,
    email:           r.email ?? undefined,
    phone:           r.phone,
    source:          r.source ?? '',
    productInterest: r.product_interest ?? '',
    status:          r.status as LeadStatus,
    intentScore:     r.intent_score,
    createdAt:       r.created_at,
    lastContact:     r.last_contact ? date(r.last_contact) : undefined,
    notes:           r.notes ?? undefined,
    assignedTo:      r.assigned_to ?? undefined,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toFraudCase(r: any): FraudCase {
  return {
    id:           r.id,
    claimId:      r.claim_id,
    claimNumber:  r.claims?.claim_number ?? '',
    policyNumber: r.claims?.policies?.policy_number ?? '',
    clientName:   r.claims?.policies?.clients?.name ?? '',
    category:     r.claims?.category ?? undefined,
    amount:       r.claims?.amount ?? undefined,
    fraudScore:   r.fraud_score,
    signals:      r.signals ?? [],
    status:       r.status as FraudCaseStatus,
    assignedTo:   r.assigned_to ?? undefined,
    createdAt:    r.created_at,
    resolvedAt:   r.resolved_at ?? undefined,
    notes:        r.notes ?? undefined,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toReminder(r: any): Reminder {
  return {
    id:           r.id,
    type:         r.type,
    clientId:     r.clients?.id ?? r.client_id ?? '',
    clientName:   r.clients?.name ?? '',
    policyId:     r.policy_id ?? undefined,
    policyNumber: r.policies?.policy_number ?? undefined,
    dueDate:      date(r.due_date),
    message:      r.message ?? '',
    smsBody:      r.sms_body ?? undefined,
    sent:         r.sent,
    channel:      r.channel,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toCautionFlag(r: any): CautionFlag {
  return {
    policyId:        r.policy_id,
    policyNumber:    r.policy_number,
    clientId:        r.client_id,
    clientName:      r.client_name,
    agentId:         r.agent_id ?? undefined,
    daysOverdue:     r.days_overdue,
    flaggedAt:       r.flagged_at,
    monthsDefaulted: r.months_defaulted,
    cleared:         r.cleared,
    clearedAt:       r.cleared_at ?? undefined,
  }
}

// ── SELECT strings ────────────────────────────────────────────────
// The base shapes are what existed before the group-cover and
// transaction-id migrations. The extras are appended only after a live
// probe confirms the columns exist — deploying code ahead of a migration
// must not take the whole policies/payments screens down with it.
const POLICY_SELECT_BASE = `
  id, policy_number, client_id, product_id, premium, cover_amount,
  start_date, end_date, status, dependants, payment_method, insurer,
  grower_number, gps_lat, gps_lng, agent_id, next_payment_date, last_payment_date, created_at,
  source,
  clients!client_id(id, name),
  products!product_id(id, name, category, excess),
  profiles!agent_id(id, name)
`
const POLICY_SELECT_GROUP = POLICY_SELECT_BASE + `,
  group_id, cover_scope, team_activity,
  groups!group_id(id, name, group_type)
`
const POLICY_SELECT_MED = `,
  has_chronic_illness, chronic_illness_details, contractor, hectarage`
const POLICY_SELECT = POLICY_SELECT_GROUP + POLICY_SELECT_MED
// Who captured the policy — a staff profile, unlike agent_id (the field
// officer who sourced it). Probed like the other newer columns.
const POLICY_SELECT_CAP = `,
  captured_by, capturer:profiles!captured_by(id, name)`
const CLAIM_SELECT = `
  id, claim_number, policy_id, claim_type, amount, status,
  stage, assessment_notes, agent_id, category,
  date_of_event, date_submitted, description, fraud_score,
  assigned_to, documents, notes, resolved_at, created_at,
  policies!policy_id(
    id, policy_number,
    clients!client_id(id, name),
    products!product_id(name, category)
  ),
  assignee:profiles!assigned_to(id, name),
  agent:profiles!agent_id(id, name)
`
const PAYMENT_SELECT_BASE = `
  id, reference, policy_id, amount, method, status, payment_date, split_payments, created_at,
  policies!policy_id(
    policy_number,
    clients!client_id(name)
  )
`
const TICKET_SELECT = `
  id, ticket_number, client_id, subject, description,
  status, priority, category, assigned_to, messages, created_at, updated_at,
  clients!client_id(id, name),
  profiles!assigned_to(id, name)
`
const FRAUD_SELECT = `
  id, claim_id, fraud_score, signals, status, assigned_to, notes, resolved_at, created_at,
  claims!claim_id(
    claim_number, category, amount,
    policies!policy_id(
      policy_number,
      clients!client_id(name)
    )
  )
`
const REMINDER_SELECT = `
  id, type, client_id, policy_id, due_date, message, sent, channel, created_at,
  clients!client_id(id, name),
  policies!policy_id(policy_number)
`
// sms_body arrives with add_reminder_sms_body.sql — probed like every
// other optional column so a database without it still reads fine.
const reminderSelect = async () =>
  (await hasColumn('reminders', 'sms_body')) ? `${REMINDER_SELECT}, sms_body` : REMINDER_SELECT

// ── POLICIES ──────────────────────────────────────────────────────
export const policies = {
  // Falls back to a real read-through cache (offlineCache.ts), not
  // localStore's demo-seeded mock data — an assessor offline on a farm
  // visit must see their real assigned policies (or a clear "no cached
  // data yet" empty state), never a fake policy that looks real enough to
  // record a genuine site visit against.
  async list() {
    const select = await policySelect()
    const { ok, data } = await sb('policies', 'read',
      () => supabase.from('policies').select(select).order('created_at', { ascending: false }),
      d => Array.isArray(d),
    )
    if (ok && data) {
      const mapped = (data as unknown[]).map(toPolicy)
      cacheSet('policies', mapped)
      return { data: mapped, error: null }
    }
    const cached = cacheGet<Policy>('policies')
    if (cached) { local('policies', 'read'); return { data: cached.data, error: null } }
    local('policies', 'read')
    return { data: [], error: 'Could not load policies — connect to the internet at least once to cache them for offline use.' }
  },

  /** Minimal per-client lookup — just enough for "does this client already
   *  hold a live policy on product X" before an insert hits the unique
   *  index. Not cached: it must be current the moment it's asked. */
  async listForClient(clientId: string) {
    const { ok, data, error } = await sb('policies', 'read',
      () => supabase.from('policies').select('id, policy_number, product_id, status, products!product_id(name)').eq('client_id', clientId),
      d => Array.isArray(d),
    )
    if (!ok || !data) return { data: null, error: error ?? 'Could not load that client\'s policies.' }
    return {
      data: (data as Record<string, unknown>[]).map(r => ({
        id: r.id as string,
        policyNumber: r.policy_number as string,
        productId: r.product_id as string,
        productName: (r.products as { name?: string } | null)?.name ?? '',
        status: r.status as PolicyStatus,
      })),
      error: null,
    }
  },

  async get(id: string) {
    const select = await policySelect()
    const { ok, data } = await sb('policies', 'read',
      () => supabase.from('policies').select(select).eq('id', id).single(),
    )
    if (ok && data) return { data: toPolicy(data), error: null }
    const cachedPolicy = cacheGet<Policy>('policies')?.data.find(p => p.id === id)
    if (cachedPolicy) return { data: cachedPolicy, error: null }
    return { data: null, error: 'Could not load that policy.' }
  },

  async create(policy: Omit<Policy, 'id'>) {
    const row = {
      policy_number: policy.policyNumber, client_id: policy.clientId,
      product_id: policy.productId, premium: policy.premium,
      cover_amount: policy.coverAmount, start_date: policy.startDate,
      end_date: policy.endDate, status: policy.status,
      dependants: policy.dependants, payment_method: policy.paymentMethod,
      insurer: policy.insurer ?? null, grower_number: policy.growerNumber ?? null,
      gps_lat: policy.gpsLat ?? null, gps_lng: policy.gpsLng ?? null,
      agent_id: policy.agentId ?? null, next_payment_date: policy.nextPaymentDate ?? null,
      // Defaulting to 'web_app' is honest: any insert reaching this code
      // path without a source set was issued by staff in the IMS itself.
      source: policy.source ?? 'web_app',
    }
    // Who captured the policy — the staff member at the desk, as distinct
    // from agent_id (the field officer who sourced the business). The
    // column lands via database/add_policy_captured_by.sql; probed so a
    // database without it still writes fine.
    if (await hasColumn('policies', 'captured_by')) {
      const { data: { session } } = await supabase.auth.getSession()
      ;(row as Record<string, unknown>).captured_by = session?.user?.id ?? null
    }
    // Group-cover columns only exist once database/add_group_cover.sql has
    // been run. An individual policy omits them entirely (the DB default
    // applies); an organisation policy refuses rather than silently
    // becoming an individual policy detached from its roster.
    // Medical-declaration columns exist once add_medical_declaration.sql
    // runs; a health policy REFUSES rather than silently dropping the
    // underwriting answer it was required to ask.
    const medColsReady = await hasColumn('policies', 'has_chronic_illness')
    if (policy.hasChronicIllness !== undefined) {
      if (!medColsReady) {
        return { data: null, error: 'Medical declarations need a database update first — run database/add_medical_declaration.sql in Supabase, then try again.' }
      }
      ;(row as Record<string, unknown>).has_chronic_illness = policy.hasChronicIllness
      ;(row as Record<string, unknown>).chronic_illness_details = policy.chronicIllnessDetails ?? null
    }
    // contractor shares the medical-columns probe block — it landed in
    // the same schema-generation pass (add_policy_contractor.sql).
    if (policy.contractor !== undefined) {
      if (!medColsReady) {
        return { data: null, error: 'The contractor field needs a database update first — run database/add_policy_contractor.sql in Supabase, then try again.' }
      }
      ;(row as Record<string, unknown>).contractor = policy.contractor || null
    }
    // hectarage lands with the contractor block — tobacco-only field,
    // same add_policy_hectarage.sql generation.
    if (policy.hectarage !== undefined) {
      if (!(await hasColumn('policies', 'hectarage'))) {
        return { data: null, error: 'The hectarage field needs a database update first — run database/add_policy_hectarage.sql in Supabase, then try again.' }
      }
      ;(row as Record<string, unknown>).hectarage = policy.hectarage ?? null
    }
    const groupColsReady = await hasColumn('policies', 'group_id')
    if (policy.groupId || (policy.coverScope && policy.coverScope !== 'individual')) {
      if (!groupColsReady) {
        return { data: null, error: 'Corporate/group policies need a database update first — run database/add_group_cover.sql in the Supabase SQL editor, then try again.' }
      }
      ;(row as Record<string, unknown>).group_id = policy.groupId ?? null
      ;(row as Record<string, unknown>).cover_scope = policy.coverScope ?? 'individual'
      ;(row as Record<string, unknown>).team_activity = policy.teamActivity ?? null
    } else if (groupColsReady) {
      ;(row as Record<string, unknown>).cover_scope = 'individual'
    }
    const policySelect_ = await policySelect()
    // Inserted directly rather than through sb(), because a duplicate must
    // be reported as a refusal. Falling back to local storage on a unique
    // violation would tell the user their policy was created and then
    // quietly never sync it -- the opposite of what the constraint is for.
    const start = Date.now()
    const { data, error } = await supabase.from('policies').insert(row).select(policySelect_).single()
    health.record({ ts: Date.now(), type: 'write', table: 'policies', success: !error, duration: Date.now() - start, source: 'supabase', detail: error ? String(error.message) : undefined })

    if (!error && data) return { data: toPolicy(data), error: null }
    if (error?.code === '23505') {
      const duplicateProduct = error.message.includes('policies_one_live_per_client_product')
      return {
        data: null,
        error: duplicateProduct
          ? 'This client already holds a live policy for this product. Add a different product, or upgrade the existing policy instead of issuing a second one.'
          : 'That would duplicate an existing record. Check whether this client or policy is already on the system.',
      }
    }
    // Anything else is a genuine failure: the policy does not exist.
    return writeFailed('policies', error?.message ?? null)
  },

  async update(id: string, updates: Partial<Policy>) {
    const row: Record<string, unknown> = {}
    if (updates.status)                              row.status             = updates.status
    if (updates.paymentMethod)                       row.payment_method     = updates.paymentMethod
    if (updates.insurer !== undefined)               row.insurer            = updates.insurer || null
    if (updates.growerNumber !== undefined)          row.grower_number      = updates.growerNumber || null
    if (updates.contractor !== undefined)            row.contractor         = updates.contractor || null
    if ('hectarage' in updates)                      row.hectarage          = updates.hectarage ?? null
    if (updates.gpsLat !== undefined)                row.gps_lat            = updates.gpsLat ?? null
    if (updates.gpsLng !== undefined)                row.gps_lng            = updates.gpsLng ?? null
    // Blank date must become NULL. An empty string is not a date, and
    // Postgres rejects the whole update with a syntax error.
    if (updates.nextPaymentDate !== undefined)       row.next_payment_date  = updates.nextPaymentDate || null
    if (updates.dependants !== undefined)            row.dependants         = updates.dependants ?? []
    if (updates.premium !== undefined) {
      const premium = Number(updates.premium)
      if (!Number.isFinite(premium)) return { data: null, error: 'Premium must be a number.' }
      row.premium = premium
    }
    if (updates.coverAmount !== undefined) {
      const cover = Number(updates.coverAmount)
      if (!Number.isFinite(cover)) return { data: null, error: 'Cover amount must be a number.' }
      row.cover_amount = cover
    }
    if (updates.endDate !== undefined) {
      if (!updates.endDate) return { data: null, error: 'A policy must have an end date.' }
      row.end_date = updates.endDate
    }
    // A cleared agent used to be sent as "" and Postgres rejected the
    // update because agent_id is a uuid.
    if (updates.agentId !== undefined)               row.agent_id           = updates.agentId || null
    if (updates.source)                              row.source             = updates.source
    const policySelect_ = await policySelect()
    if (schemaFlags.get('policies.group_id')?.ok) {
      if (updates.groupId !== undefined)             row.group_id           = updates.groupId ?? null
      if (updates.coverScope)                        row.cover_scope        = updates.coverScope
      if (updates.teamActivity !== undefined)        row.team_activity      = updates.teamActivity ?? null
    }
    if (Object.keys(row).length === 0) return { data: null, error: 'No changes to save.' }
    const { ok, data, error } = await sb('policies', 'write',
      () => supabase.from('policies').update(row).eq('id', id).select(policySelect_).single(),
    )
    if (ok && data) return { data: toPolicy(data), error: null }
    return writeFailed('policies', explainWriteError(error))
  },

  /** What is standing in the way of deleting this policy. Reminders,
   *  caution flags and pre-loss assessments all cascade, so what remains is
   *  claims, payments, and the web checkout session a policy bought online
   *  was created from -- that last one holds a plain reference that neither
   *  cascades nor nulls itself, so it blocks silently if not accounted for. */
  async deletionBlockers(id: string): Promise<{ claims: number; payments: number; checkouts: number }> {
    const [claimsRes, paymentsRes, checkoutRes] = await Promise.all([
      supabase.from('claims').select('id', { count: 'exact', head: true }).eq('policy_id', id),
      supabase.from('payments').select('id', { count: 'exact', head: true }).eq('policy_id', id),
      supabase.from('checkout_sessions').select('id', { count: 'exact', head: true }).eq('policy_id', id),
    ])
    return { claims: claimsRes.count ?? 0, payments: paymentsRes.count ?? 0, checkouts: checkoutRes.count ?? 0 }
  },

  /**
   * RLS (policies_delete_admin) restricts this to admin/super_admin already;
   * hasPermission('policies.delete') additionally gates the button itself
   * so a custom role can hide it from a given admin/staff member too.
   *
   * Claims and payments deliberately do NOT cascade in the schema, because
   * silently destroying a payment record along with a policy is not
   * something anyone should be able to do by accident. Passing `force`
   * removes them explicitly, which is the caller stating that is what they
   * meant -- and the reason for it gets written to the activity log.
   */
  async remove(id: string, opts: { force?: boolean } = {}) {
    if (opts.force) {
      // Order matters: all three reference the policy, so they go first.
      const { error: claimsError } = await supabase.from('claims').delete().eq('policy_id', id)
      if (claimsError) return { error: `Could not remove the policy's claims: ${claimsError.message}` }
      const { error: paymentsError } = await supabase.from('payments').delete().eq('policy_id', id)
      if (paymentsError) return { error: `Could not remove the policy's payments: ${paymentsError.message}` }
      // The checkout session is a payment record in its own right, so it is
      // detached rather than destroyed -- what the buyer paid, when, and
      // through which gateway stays on file even though the policy it
      // produced is gone.
      const { error: checkoutError } = await supabase.from('checkout_sessions').update({ policy_id: null }).eq('policy_id', id)
      if (checkoutError) return { error: `Could not detach the policy's checkout session: ${checkoutError.message}` }
    }

    const { error } = await supabase.from('policies').delete().eq('id', id)
    if (!error) return { error: null }
    if (error.code !== '23503') return { error: error.message }

    // Name what is actually holding it, rather than listing everything it
    // might have been -- "claims or payments" sends someone looking for a
    // claim that was never there.
    const { claims, payments, checkouts } = await policies.deletionBlockers(id)
    const parts = [
      claims > 0 && `${claims} claim${claims === 1 ? '' : 's'}`,
      payments > 0 && `${payments} payment${payments === 1 ? '' : 's'}`,
      checkouts > 0 && `${checkouts} online checkout${checkouts === 1 ? '' : 's'}`,
    ].filter(Boolean)
    return {
      error: parts.length
        ? `This policy still has ${parts.join(' and ')} recorded against it.`
        : 'This policy is still referenced by other records and cannot be deleted.',
    }
  },
}

// ── CLIENTS ───────────────────────────────────────────────────────
export const clients = {
  // See policies.list() above — falls back to a real cache, not
  // localStore's demo-seeded mock data, so offline lookups (e.g. matching
  // a farm visit to the right grower by phone/ID) never surface a fake
  // client record.
  async list() {
    const { ok, data } = await sb('clients', 'read',
      () => supabase.from('clients').select('*, policies(count)').order('created_at', { ascending: false }),
      d => Array.isArray(d),
    )
    if (ok && data) {
      const mapped = (data as Record<string, unknown>[]).map(r =>
        toClient({ ...r, policy_count: (r.policies as {count:number}[])?.[0]?.count ?? 0 })
      )
      cacheSet('clients', mapped)
      return { data: mapped, error: null }
    }
    const cached = cacheGet<Client>('clients')
    if (cached) { local('clients', 'read'); return { data: cached.data, error: null } }
    local('clients', 'read')
    return { data: [], error: 'Could not load clients — connect to the internet at least once to cache them for offline use.' }
  },

  async get(id: string) {
    const { ok, data } = await sb('clients', 'read',
      () => supabase.from('clients').select('*, policies(count)').eq('id', id).single(),
    )
    if (ok && data) return {
      data: toClient({ ...(data as Record<string, unknown>), policy_count: ((data as Record<string, unknown>).policies as {count:number}[])?.[0]?.count ?? 0 }),
      error: null,
    }
    const cachedClient = cacheGet<Client>('clients')?.data.find(c => c.id === id)
    if (cachedClient) return { data: cachedClient, error: null }
    return { data: null, error: 'Could not load that client.' }
  },

  async create(client: Omit<Client, 'id' | 'policyCount'>) {
    const row = {
      name: client.name, email: client.email, phone: client.phone,
      national_id: client.nationalId, dob: client.dob || null,
      gender: client.gender ?? null,
      address: client.address, occupation: client.occupation ?? null,
      insurer: client.insurer ?? null, status: client.status,
      insurer_provisional: client.insurerProvisional ?? false,
      agent_id: client.agentId ?? null,
    }
    const { ok, data, error } = await sb('clients', 'write',
      () => supabase.from('clients').insert(row).select().single(),
    )
    if (ok && data) return { data: toClient({ ...(data as Record<string,unknown>), policy_count: 0 }), error: null }
    // National ID is unique — a walk-in who was registered before (by an
    // agent, the website, or the bot) must be found via the existing-client
    // search, not reported as a server failure.
    if (error && /duplicate key/i.test(error) && /national_id/i.test(error)) {
      return writeFailed('clients', `A client with national ID ${client.nationalId} already exists — switch to "Existing Customer" and search for them instead of registering again.`)
    }
    return writeFailed('clients', error)
  },

  async update(id: string, updates: Partial<Client>) {
    const row: Record<string, unknown> = {}
    if (updates.name       !== undefined) row.name       = updates.name.trim()
    if (updates.email      !== undefined) row.email      = updates.email.trim() || null
    if (updates.phone      !== undefined) {
      const phone = updates.phone.trim()
      if (!phone) return { data: null, error: 'Phone number is required.' }
      row.phone = phone
    }
    if (updates.nationalId !== undefined) row.national_id = updates.nationalId
    if (updates.dob        !== undefined) row.dob        = updates.dob || null
    if (updates.gender     !== undefined && await hasColumn('clients', 'gender')) row.gender = updates.gender || null
    if (updates.address    !== undefined) row.address    = updates.address
    if (updates.occupation !== undefined) row.occupation = updates.occupation || null
    if (updates.insurer    !== undefined) row.insurer    = updates.insurer || null
    if (updates.insurerProvisional !== undefined) row.insurer_provisional = updates.insurerProvisional
    if (updates.agentId    !== undefined) row.agent_id   = updates.agentId || null
    if (updates.status     !== undefined) row.status     = updates.status
    if (Object.keys(row).length === 0) return { data: null, error: 'No changes to save.' }
    const { ok, data, error } = await sb('clients', 'write',
      () => supabase.from('clients').update(row).eq('id', id).select().single(),
    )
    if (ok && data) return { data: toClient({ ...(data as Record<string,unknown>), policy_count: 0 }), error: null }
    if (error && /duplicate key/i.test(error) && /national_id/i.test(error)) {
      return writeFailed('clients', 'That national ID already belongs to another client — check for a duplicate registration first.')
    }
    return writeFailed('clients', explainWriteError(error))
  },

  /**
   * Super Admin only (enforced by RLS — clients_delete_super_admin). No
   * local-storage fallback, same reasoning as staff.remove(): a "deleted"
   * client that only disappeared from browser state was never really gone.
   * Policies/claims reference clients with ON DELETE RESTRICT, so this
   * fails with a clear foreign-key error for any client who still has a
   * policy — surfaced as a friendly message rather than a raw Postgres one.
   */
  async remove(id: string) {
    const { error } = await supabase.from('clients').delete().eq('id', id)
    if (error) {
      return { error: error.code === '23503' ? 'This client has existing policies and cannot be deleted.' : error.message }
    }
    return { error: null }
  },
}

// ── PRODUCTS ──────────────────────────────────────────────────────
export const products = {
  // See policies.list() above — falls back to a real cache, not
  // localStore's demo-seeded mock data, so an offline category lookup
  // (e.g. deciding whether a policy is agriculture or vehicle) never uses
  // fake product data.
  async list() {
    const { ok, data } = await sb('products', 'read',
      () => supabase.from('products').select('*').order('name'),
      d => Array.isArray(d),
    )
    if (ok && data) {
      const mapped = (data as Record<string,unknown>[]).map(toProduct)
      cacheSet('products', mapped)
      return { data: mapped, error: null }
    }
    const cached = cacheGet<Product>('products')
    if (cached) { local('products', 'read'); return { data: cached.data, error: null } }
    local('products', 'read')
    return { data: [], error: 'Could not load products — connect to the internet at least once to cache them for offline use.' }
  },

  /**
   * For anyone who is not staff — a client viewing their own cover, or a
   * future public quote/checkout flow. Reads public.products_client_safe
   * (see database/add_products_client_safe_view.sql) instead of the base
   * table, so commission_pct and policies_count never reach the browser in
   * the first place -- not merely go unrendered by whichever page called
   * this. Cached under its own key so a client-safe read can never be the
   * thing that backfills the full-Product cache products.list() falls back
   * to when offline.
   */
  async listClientSafe(): Promise<{ data: ClientSafeProduct[]; error: string | null }> {
    const { ok, data } = await sb('products_client_safe', 'read',
      () => supabase.from('products_client_safe').select('*').order('name'),
      d => Array.isArray(d),
    )
    if (ok && data) {
      const mapped = (data as Record<string,unknown>[]).map(toClientSafeProduct)
      cacheSet('products_client_safe', mapped)
      return { data: mapped, error: null }
    }
    const cached = cacheGet<ClientSafeProduct>('products_client_safe')
    if (cached) { local('products_client_safe', 'read'); return { data: cached.data, error: null } }
    local('products_client_safe', 'read')
    return { data: [], error: 'Could not load products — connect to the internet at least once to cache them for offline use.' }
  },

  /**
   * No local-storage fallback here — products.code is UNIQUE in the
   * database, so a reused code fails with a real, actionable Postgres
   * error. Silently "succeeding" into localStorage on that error was the
   * cause of "products aren't saving / vanish after logout": the item
   * looked saved for the current browser session but was never actually
   * in Supabase, so it disappeared the moment a real fetch replaced it.
   */
  async create(product: Omit<Product, 'id' | 'policiesCount'>) {
    const row = {
      name: product.name, code: product.code, category: product.category,
      premium: product.premium, cover_amount: product.coverAmount,
      waiting_period_days: product.waitingPeriodDays, min_age: product.minAge,
      max_age: product.maxAge, commission_pct: product.commissionPct,
      active: product.active, features: product.features, description: product.description,
      excess: product.excess || null,
    }
    const start = Date.now()
    const { data, error } = await supabase.from('products').insert(row).select().single()
    health.record({ ts: Date.now(), type: 'write', table: 'products', success: !error, duration: Date.now() - start, source: 'supabase', detail: error ? String(error.message) : undefined })
    if (error) {
      return { data: null, error: error.code === '23505' ? 'That product code is already in use; please choose a different one.' : error.message }
    }
    return { data: toProduct({ ...(data as Record<string,unknown>), policies_count: 0 }), error: null }
  },

  async update(id: string, updates: Partial<Product>) {
    const row: Record<string, unknown> = {}
    if (updates.name              !== undefined) row.name                = updates.name
    if (updates.code              !== undefined) row.code                = updates.code
    if (updates.premium           !== undefined) row.premium             = updates.premium
    if (updates.coverAmount       !== undefined) row.cover_amount        = updates.coverAmount
    if (updates.commissionPct     !== undefined) row.commission_pct      = updates.commissionPct
    if (updates.active            !== undefined) row.active              = updates.active
    if (updates.features          !== undefined) row.features            = updates.features
    if (updates.description       !== undefined) row.description         = updates.description
    if (updates.waitingPeriodDays !== undefined) row.waiting_period_days = updates.waitingPeriodDays
    if (updates.excess            !== undefined) row.excess              = updates.excess || null
    const start = Date.now()
    const { data, error } = await supabase.from('products').update(row).eq('id', id).select().single()
    health.record({ ts: Date.now(), type: 'write', table: 'products', success: !error, duration: Date.now() - start, source: 'supabase', detail: error ? String(error.message) : undefined })
    if (error) {
      return { data: null, error: error.code === '23505' ? 'That product code is already in use; please choose a different one.' : error.message }
    }
    return { data: toProduct(data as Record<string,unknown>), error: null }
  },
}

// ── CROP TYPES ────────────────────────────────────────────────────
export const cropTypes = {
  async list() {
    const { ok, data } = await sb('crop_types', 'read',
      () => supabase.from('crop_types').select('*').order('name'),
      d => Array.isArray(d),
    )
    if (ok && data) return { data: (data as Record<string, unknown>[]).map(r => ({ id: r.id as string, name: r.name as string, status: r.status as 'active' | 'inactive', createdAt: r.created_at as string })), error: null }
    return { data: [] as CropType[], error: null }
  },

  async create(name: string) {
    const { data, error } = await supabase.from('crop_types').insert({ name }).select().single()
    if (error) return { data: null, error: error.code === '23505' ? 'That crop type already exists.' : error.message }
    return { data: { id: data.id, name: data.name, status: data.status, createdAt: data.created_at } as CropType, error: null }
  },

  async setStatus(id: string, status: 'active' | 'inactive') {
    const { error } = await supabase.from('crop_types').update({ status }).eq('id', id)
    return { error: error?.message ?? null }
  },
}

// ── FRAUD SIGNAL RULES (org-defined red flags fed into AI scoring) ──
export const fraudSignalRules = {
  async list() {
    const { ok, data } = await sb('fraud_signal_rules', 'read',
      () => supabase.from('fraud_signal_rules').select('id, description, status, created_at, profiles!created_by(name)').order('created_at', { ascending: false }),
      d => Array.isArray(d),
    )
    if (ok && data) {
      return {
        data: (data as Record<string, unknown>[]).map(r => ({
          id: r.id as string, description: r.description as string, status: r.status as 'active' | 'inactive',
          createdByName: (r.profiles as { name?: string } | null)?.name, createdAt: r.created_at as string,
        })) as FraudSignalRule[],
        error: null,
      }
    }
    return { data: [] as FraudSignalRule[], error: null }
  },

  async create(description: string, createdBy: string) {
    const { data, error } = await supabase.from('fraud_signal_rules').insert({ description, created_by: createdBy || null }).select().single()
    if (error) return { data: null, error: error.message }
    return { data: { id: data.id, description: data.description, status: data.status, createdAt: data.created_at } as FraudSignalRule, error: null }
  },

  async setStatus(id: string, status: 'active' | 'inactive') {
    const { error } = await supabase.from('fraud_signal_rules').update({ status }).eq('id', id)
    return { error: error?.message ?? null }
  },

  async remove(id: string) {
    const { error } = await supabase.from('fraud_signal_rules').delete().eq('id', id)
    return { error: error?.message ?? null }
  },
}

// ── HERO SLIDES (public site hero carousel content) ──────────────────
function toHeroSlide(r: Record<string, unknown>): HeroSlide {
  return {
    id: r.id as string, icon: r.icon as string, headline: (r.headline as string) ?? undefined,
    sortOrder: r.sort_order as number, status: r.status as 'active' | 'inactive', createdAt: r.created_at as string,
  }
}

export const heroSlides = {
  async list() {
    const { ok, data } = await sb('hero_slides', 'read',
      () => supabase.from('hero_slides').select('*').order('sort_order'),
      d => Array.isArray(d),
    )
    if (ok && data) return { data: (data as Record<string, unknown>[]).map(toHeroSlide), error: null }
    return { data: [] as HeroSlide[], error: null }
  },

  async create(input: { icon: string; headline?: string; sortOrder: number }) {
    const { data, error } = await supabase.from('hero_slides')
      .insert({ icon: input.icon, headline: input.headline || null, sort_order: input.sortOrder })
      .select().single()
    if (error) return { data: null, error: error.message }
    return { data: toHeroSlide(data), error: null }
  },

  async update(id: string, patch: Partial<{ icon: string; headline: string | null; sortOrder: number; status: 'active' | 'inactive' }>) {
    const row: Record<string, unknown> = {}
    if (patch.icon !== undefined) row.icon = patch.icon
    if (patch.headline !== undefined) row.headline = patch.headline || null
    if (patch.sortOrder !== undefined) row.sort_order = patch.sortOrder
    if (patch.status !== undefined) row.status = patch.status
    const { data, error } = await supabase.from('hero_slides').update(row).eq('id', id).select().single()
    if (error) return { data: null, error: error.message }
    return { data: toHeroSlide(data), error: null }
  },

  async remove(id: string) {
    const { error } = await supabase.from('hero_slides').delete().eq('id', id)
    return { error: error?.message ?? null }
  },
}

// ── PHOTO HASHES (duplicate/reused photo detection) ─────────────────
export interface PhotoHashMatch {
  reference: string
  label: string
  sourceType: 'claim' | 'policy'
  createdAt: string
  distance: number
}

export const photoHashes = {
  async record(input: { hash: string; sourceType: 'claim' | 'policy'; sourceId: string; reference: string; label: string; photoPath: string }) {
    await supabase.from('photo_hashes').insert({
      hash: input.hash, source_type: input.sourceType, source_id: input.sourceId,
      reference: input.reference, label: input.label, photo_path: input.photoPath,
    })
  },

  /** First-version duplicate check: pulls the most recent hashes and
   *  compares client-side via Hamming distance (see lib/photoHash.ts) —
   *  fine at the volumes a single insurer sees, not meant to scale to
   *  millions of rows without moving the comparison server-side. */
  async findMatches(hash: string, excludeSourceId: string): Promise<PhotoHashMatch[]> {
    const { data, error } = await supabase
      .from('photo_hashes')
      .select('hash, source_type, source_id, reference, label, created_at')
      .neq('source_id', excludeSourceId)
      .order('created_at', { ascending: false })
      .limit(2000)
    if (error || !data) return []
    return (data as { hash: string; source_type: 'claim' | 'policy'; reference: string; label: string; created_at: string }[])
      .map(row => ({ ...row, distance: hammingDistance(hash, row.hash) }))
      .filter(row => row.distance <= DUPLICATE_THRESHOLD)
      .sort((a, b) => a.distance - b.distance)
      .map(row => ({ reference: row.reference, label: row.label, sourceType: row.source_type, createdAt: row.created_at, distance: row.distance }))
  },
}

// ── CLAIMS ────────────────────────────────────────────────────────
export const claims = {
  async list() {
    const { ok, data } = await sb('claims', 'read',
      () => supabase.from('claims').select(CLAIM_SELECT).order('created_at', { ascending: false }),
      d => Array.isArray(d),
    )
    if (ok && data) {
      const mapped = (data as unknown[]).map(toClaim)
      cacheSet('claims', mapped)
      return { data: mapped, error: null }
    }
    const cached = cacheGet<Claim>('claims')
    if (cached) { local('claims', 'read'); return { data: cached.data, error: null } }
    return { data: [] as Claim[], error: 'Could not load claims — connect to the internet at least once to cache them for offline use.' }
  },

  async create(claim: Omit<Claim, 'id' | 'claimNumber' | 'policyNumber' | 'clientId' | 'clientName' | 'productName'>) {
    if (!Number.isFinite(claim.amount) || claim.amount <= 0) {
      return { data: null, error: 'Claim amount must be greater than zero.' }
    }
    // The last 4 digits of epoch-ms repeat every ~10 seconds, so two claims
    // filed in the same window collided on the unique constraint and the
    // second one failed as though the database were broken. The random tail
    // keeps the number short while making collisions a lottery, not a
    // certainty (same pattern as api/v1.ts's refNumber).
    const claimNumber = `CLM${new Date().getFullYear()}${String(Date.now()).slice(-4)}${Math.random().toString(36).slice(2, 5).toUpperCase()}`
    const row = {
      claim_number: claimNumber, policy_id: claim.policyId,
      claim_type: claim.claimType, amount: claim.amount, status: claim.status,
      stage: claim.stage ?? 'intake', agent_id: claim.agentId ?? null, category: claim.category ?? null,
      date_of_event: claim.dateOfEvent, date_submitted: claim.dateSubmitted,
      description: claim.description, fraud_score: claim.fraudScore, documents: claim.documents,
    }
    const { ok, data, error } = await sb('claims', 'write',
      () => supabase.from('claims').insert(row).select(CLAIM_SELECT).single(),
    )
    if (ok && data) return { data: toClaim(data), error: null }
    return writeFailed('claims', error)
  },

  async update(id: string, updates: Partial<Claim>) {
    const row: Record<string, unknown> = {}
    if (updates.status     !== undefined) row.status      = updates.status
    if (updates.stage      !== undefined) row.stage       = updates.stage
    if (updates.assignedTo !== undefined) row.assigned_to = updates.assignedTo ?? null
    if (updates.assessmentNotes !== undefined) row.assessment_notes = updates.assessmentNotes ?? null
    if (updates.notes      !== undefined) row.notes       = updates.notes ?? null
    if (updates.resolvedAt !== undefined) row.resolved_at = updates.resolvedAt ?? null
    const { ok, data, error } = await sb('claims', 'write',
      () => supabase.from('claims').update(row).eq('id', id).select(CLAIM_SELECT).single(),
    )
    if (ok && data) return { data: toClaim(data), error: null }
    // This used to save to browser storage and report "pending sync". There
    // is no sync: nothing ever writes local storage back to Supabase, so the
    // claim advanced a stage for one person and for nobody else, while the
    // message promised it would catch up. A failed write is a failed write.
    return writeFailed('claims', error)
  },

  /**
   * Removes a claim outright. Its physical assessment and any fraud case go
   * with it (both cascade), so nothing is left orphaned pointing at a claim
   * that no longer exists.
   *
   * The activity log is deliberately untouched: entity_id there is plain
   * text rather than a foreign key, precisely so the record of who deleted
   * what survives the deletion. A trail that disappears along with the thing
   * it describes is not a trail.
   *
   * RLS (claims_delete_admin) already limits this to admin/super_admin;
   * hasPermission('claims.delete') gates the button as well, so a custom
   * role can withhold it from a given administrator.
   */
  async remove(id: string) {
    const { error } = await supabase.from('claims').delete().eq('id', id)
    if (error) return { error: error.message }
    return { error: null }
  },
}

/**
 * Advances a policy's payment cursor and status whenever a completed
 * payment lands against it — called from every completion path (create or
 * update-to-completed) so the lifecycle stays consistent everywhere rather
 * than being reimplemented per call site. Agriculture goes straight to
 * 'active' on its first payment (no waiting period); a lapsed policy that
 * gets caught up is reinstated to 'waiting_period', not straight to
 * 'active' — except agriculture, which has no waiting period at all and
 * reinstates straight to 'active', per the 2026-08 access review.
 * Fire-and-forget — a failure here shouldn't roll back an already-recorded
 * payment.
 */
async function applyCompletedPaymentToPolicy(policyId: string, amountPaid: number): Promise<void> {
  const [{ data: policy }, { data: prods }] = await Promise.all([policies.get(policyId), products.list()])
  if (!policy) return
  const category = prods?.find(p => p.id === policy.productId)?.category ?? ''
  const cycleMonths = category === 'agriculture' ? 12 : 1
  // One period costs the whole policy's premium — the policyholder plus
  // every dependant, since premiums are per head. Dividing by the
  // policyholder's share alone credited a family's single monthly payment
  // as several months of cover.
  const perPeriod = policyBillablePremium(policy, category)

  /**
   * Cover is only extended by the whole periods the money actually covers.
   *
   * This used to be Math.max(1, Math.round(paid / perPeriod)), which gave a
   * full month of cover for ANY payment at all: 50 cents against a $12
   * premium, a zero, even a negative, all bought a month. Rounding also
   * over-credited — $18 against $12 bought two months instead of one.
   *
   * floor() and no minimum: a part payment is still recorded as received
   * (the client is owed the credit and staff can see it), but it does not
   * move the due date until it adds up to a full period. Nothing is ever
   * extended for free.
   */
  const periodsPaid = perPeriod > 0 && amountPaid > 0
    ? Math.floor(amountPaid / perPeriod)
    : 0
  const monthsToAdvance = cycleMonths * periodsPaid

  const today = new Date()
  const base = policy.nextPaymentDate && new Date(policy.nextPaymentDate) > today ? new Date(policy.nextPaymentDate) : today
  const next = new Date(base)
  next.setMonth(next.getMonth() + monthsToAdvance)

  // Reinstatement and activation are worth a full period, same as cover:
  // a token payment must not bring a lapsed policy back to life. Gated on
  // periodsPaid for exactly that reason.
  let status = policy.status
  if (periodsPaid >= 1) {
    if (policy.status === 'lapsed' || policy.status === 'defaulted') status = category === 'agriculture' ? 'active' : 'waiting_period'
    else if (category === 'agriculture' && policy.status === 'waiting_period') status = 'active'
  }

  await policies.update(policyId, {
    status,
    lastPaymentDate: toIsoDate(today),
    nextPaymentDate: toIsoDate(next),
  })
}

// ── PAYMENTS ──────────────────────────────────────────────────────
export const payments = {
  async list() {
    const select = await paymentSelect()
    const { ok, data } = await sb('payments', 'read',
      () => supabase.from('payments').select(select).order('payment_date', { ascending: false }),
      d => Array.isArray(d),
    )
    if (ok && data) {
      const mapped = (data as unknown[]).map(toPayment)
      cacheSet('payments', mapped)
      return { data: mapped, error: null }
    }
    const cached = cacheGet<Payment>('payments')
    if (cached) { local('payments', 'read'); return { data: cached.data, error: null } }
    return { data: [] as Payment[], error: 'Could not load payments — connect to the internet at least once to cache them for offline use.' }
  },

  async create(payment: Omit<Payment, 'id'>) {
    // A zero or negative amount recorded as 'completed' still advances
    // nextPaymentDate and can reinstate a lapsed policy for free (see
    // applyCompletedPaymentToPolicy's Math.max(1, ...) floor) -- checked
    // here rather than trusting every caller (a UI form, the manual
    // recording flow, a future one) to have validated it first.
    if (!Number.isFinite(payment.amount) || payment.amount <= 0) {
      return { data: null, error: 'Payment amount must be greater than zero.' }
    }
    const row: Record<string, unknown> = {
      reference: payment.reference, policy_id: payment.policyId,
      amount: payment.amount, method: payment.method, status: payment.status,
      payment_date: payment.date,
      split_payments: payment.splitPayments ?? null,
    }
    // transaction_id only exists once database/add_payment_txn.sql has run
    // — a payment must still record before it has; the ID just isn't
    // persisted until it is.
    const paymentSelect_ = await paymentSelect()
    if (schemaFlags.get('payments.transaction_id')?.ok) row.transaction_id = payment.transactionId ?? null
    if (schemaFlags.get('payments.pop_url')?.ok) row.pop_url = payment.popUrl ?? null
    if (schemaFlags.get('payments.pop_description')?.ok) row.pop_description = payment.popDescription ?? null
    const { ok, data, error } = await sb('payments', 'write',
      () => supabase.from('payments').insert(row).select(paymentSelect_).single(),
    )
    if (ok && data) {
      const result = toPayment(data)
      if (result.status === 'completed') void applyCompletedPaymentToPolicy(result.policyId, result.amount)
      return { data: result, error: null }
    }
    return writeFailed('payments', error)
  },

  /** Marks a captured payment as validated (completed) or otherwise updates
   *  its status — the "payments capturing and validation" split from the
   *  2026-08 access review: capture = record(), validation = this. */
  async update(id: string, updates: Partial<Payment>) {
    if (updates.amount !== undefined && (!Number.isFinite(updates.amount) || updates.amount <= 0)) {
      return { data: null, error: 'Payment amount must be greater than zero.' }
    }
    // Marking an already-completed payment completed again must not advance
    // the policy a second time — applyCompletedPaymentToPolicy has no way
    // to know this money was already counted (it extends the due date on
    // every call). The previous status is read before the write so only a
    // genuine transition into 'completed' is applied. Two staff validating
    // concurrently can still both pass this check — a truly once-only
    // transition needs a DB constraint; this closes the everyday case of
    // the same record being re-saved.
    let wasAlreadyCompleted = false
    if (updates.status === 'completed') {
      const { data: prev } = await supabase.from('payments').select('status').eq('id', id).maybeSingle()
      wasAlreadyCompleted = prev?.status === 'completed'
    }
    const row: Record<string, unknown> = {}
    if (updates.status !== undefined) row.status = updates.status
    if (updates.amount !== undefined) row.amount = updates.amount
    if (updates.method !== undefined) row.method = updates.method
    if (updates.date !== undefined) row.payment_date = updates.date
    if (updates.splitPayments !== undefined) row.split_payments = updates.splitPayments ?? null
    const paymentSelect_ = await paymentSelect()
    if (schemaFlags.get('payments.transaction_id')?.ok && updates.transactionId !== undefined) {
      row.transaction_id = updates.transactionId ?? null
    }
    if (schemaFlags.get('payments.pop_url')?.ok && updates.popUrl !== undefined) {
      row.pop_url = updates.popUrl ?? null
    }
    if (schemaFlags.get('payments.pop_description')?.ok && updates.popDescription !== undefined) {
      row.pop_description = updates.popDescription ?? null
    }
    const { ok, data, error } = await sb('payments', 'write',
      () => supabase.from('payments').update(row).eq('id', id).select(paymentSelect_).single(),
    )
    if (ok && data) {
      const result = toPayment(data)
      if (updates.status === 'completed' && !wasAlreadyCompleted) void applyCompletedPaymentToPolicy(result.policyId, result.amount)
      return { data: result, error: null }
    }
    return writeFailed('payments', error)
  },
}

// ── AGRICULTURE ASSESSMENTS ─────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toClaimAssessment(r: any): ClaimAssessment {
  return {
    id:                 r.id,
    claimId:            r.claim_id,
    claimNumber:        r.claims?.claim_number ?? '',
    assessorId:         r.assessor_id ?? '',
    assessorName:       r.profiles?.name ?? '',
    descriptionOfLoss:  r.description_of_loss ?? '',
    photos:             (r.photos as AssessmentPhoto[]) ?? [],
    assessorComments:   r.assessor_comments ?? '',
    farmerStatement:    r.farmer_statement ?? undefined,
    gpsLat:             r.gps_lat ?? undefined,
    gpsLng:             r.gps_lng ?? undefined,
    cropPopulation:     r.crop_population ?? undefined,
    cropStage:          r.crop_stage ?? undefined,
    barnCapacity:       r.barn_capacity ?? undefined,
    hectares:           r.hectares ?? undefined,
    leavesExpected:     r.leaves_expected ?? undefined,
    damagedLeaves:      r.damaged_leaves ?? undefined,
    barnStrings:        r.barn_strings ?? undefined,
    leavesPerString:    r.leaves_per_string ?? undefined,
    leavesLost:         r.leaves_lost ?? undefined,
    percentageLoss:     r.percentage_loss ?? undefined,
    grossLoss:          r.gross_loss ?? undefined,
    handlingExpenses:   r.handling_expenses ?? undefined,
    excessAmount:       r.excess_amount ?? undefined,
    claimPayable:       r.claim_payable ?? undefined,
    farmerSignature:    r.farmer_signature ?? undefined,
    assessorSignature:  r.assessor_signature ?? undefined,
    farmerSelfie:       r.farmer_selfie ?? undefined,
    submittedAt:        r.submitted_at ?? undefined,
    syncStatus:         r.sync_status ?? 'synced',
    createdAt:          r.created_at,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toPolicyAssessment(r: any): PolicyAssessment {
  return {
    id:               r.id,
    policyId:         r.policy_id,
    policyNumber:     r.policies?.policy_number ?? '',
    clientName:       r.policies?.clients?.name ?? undefined,
    assessorId:       r.assessor_id ?? '',
    assessorName:     r.profiles?.name ?? '',
    subjectType:      r.subject_type ?? 'agriculture',
    cropType:         r.crop_type ?? undefined,
    cropPopulation:   r.crop_population ?? undefined,
    plantDate:        r.plant_date ?? undefined,
    registrationNumber: r.registration_number ?? undefined,
    vehicleMake:      r.vehicle_make ?? undefined,
    vehicleModel:     r.vehicle_model ?? undefined,
    odometerReading:  r.odometer_reading ?? undefined,
    existingDamage:   r.existing_damage ?? undefined,
    photos:           (r.photos as AssessmentPhoto[]) ?? [],
    notes:            r.notes ?? '',
    gpsLat:           r.gps_lat ?? undefined,
    gpsLng:           r.gps_lng ?? undefined,
    barnHooks:        r.barn_hooks ?? undefined,
    barnTiers:        r.barn_tiers ?? undefined,
    barnBays:         r.barn_bays ?? undefined,
    barnOwnership:    r.barn_ownership ?? undefined,
    barnUsage:        r.barn_usage ?? undefined,
    farmerSignature:  r.farmer_signature ?? undefined,
    assessorSignature: r.assessor_signature ?? undefined,
    syncStatus:       r.sync_status ?? 'synced',
    createdAt:        r.created_at,
  }
}

const CLAIM_ASSESSMENT_SELECT = `
  id, claim_id, assessor_id, description_of_loss, photos, assessor_comments, farmer_statement,
  gps_lat, gps_lng, crop_population, crop_stage, barn_capacity,
  hectares, leaves_expected, damaged_leaves, barn_strings, leaves_per_string, leaves_lost,
  percentage_loss, gross_loss, handling_expenses, excess_amount, claim_payable,
  farmer_signature, assessor_signature, farmer_selfie, submitted_at, sync_status, created_at,
  claims!claim_id(claim_number),
  profiles!assessor_id(name)
`
const POLICY_ASSESSMENT_SELECT = `
  id, policy_id, assessor_id, subject_type, crop_type, crop_population, plant_date,
  registration_number, vehicle_make, vehicle_model, odometer_reading, existing_damage,
  photos, notes, gps_lat, gps_lng, farmer_signature, assessor_signature, sync_status, created_at,
  barn_hooks, barn_tiers, barn_bays, barn_ownership, barn_usage,
  policies!policy_id(policy_number, clients!client_id(name)),
  profiles!assessor_id(name)
`

export const claimAssessments = {
  async listForClaim(claimId: string) {
    const { ok, data } = await sb('claim_assessments', 'read',
      () => supabase.from('claim_assessments').select(CLAIM_ASSESSMENT_SELECT).eq('claim_id', claimId).order('created_at', { ascending: false }),
      d => Array.isArray(d),
    )
    if (ok && data) return { data: (data as unknown[]).map(toClaimAssessment), error: null }
    return { data: [], error: null }
  },

  async create(a: Omit<ClaimAssessment, 'id' | 'claimNumber' | 'assessorName' | 'createdAt'>) {
    const row = {
      claim_id: a.claimId, assessor_id: a.assessorId || null,
      description_of_loss: a.descriptionOfLoss, photos: a.photos,
      assessor_comments: a.assessorComments, farmer_statement: a.farmerStatement ?? null,
      gps_lat: a.gpsLat ?? null, gps_lng: a.gpsLng ?? null,
      crop_population: a.cropPopulation ?? null, crop_stage: a.cropStage ?? null, barn_capacity: a.barnCapacity ?? null,
      hectares: a.hectares ?? null, leaves_expected: a.leavesExpected ?? null,
      damaged_leaves: a.damagedLeaves ?? null, barn_strings: a.barnStrings ?? null,
      leaves_per_string: a.leavesPerString ?? null, leaves_lost: a.leavesLost ?? null,
      percentage_loss: a.percentageLoss ?? null, gross_loss: a.grossLoss ?? null,
      handling_expenses: a.handlingExpenses ?? null, excess_amount: a.excessAmount ?? null,
      claim_payable: a.claimPayable ?? null,
      farmer_signature: a.farmerSignature ?? null, assessor_signature: a.assessorSignature ?? null,
      farmer_selfie: a.farmerSelfie ?? null, submitted_at: a.submittedAt ?? null, sync_status: a.syncStatus,
    }
    const { data, error } = await supabase.from('claim_assessments').insert(row).select(CLAIM_ASSESSMENT_SELECT).single()
    if (error) return { data: null, error: error.message }
    return { data: toClaimAssessment(data), error: null }
  },
}

export const policyAssessments = {
  async listForPolicy(policyId: string) {
    const { ok, data } = await sb('policy_assessments', 'read',
      () => supabase.from('policy_assessments').select(POLICY_ASSESSMENT_SELECT).eq('policy_id', policyId).order('created_at', { ascending: false }),
      d => Array.isArray(d),
    )
    if (ok && data) return { data: (data as unknown[]).map(toPolicyAssessment), error: null }
    return { data: [], error: null }
  },

  /** Every pre-loss assessment across every policy — powers the dedicated
   *  Pre-Loss Assessments management page (there was previously no way to
   *  browse this history at all, only record a new one from inside a
   *  policy). */
  async listAll() {
    const { ok, data } = await sb('policy_assessments', 'read',
      () => supabase.from('policy_assessments').select(POLICY_ASSESSMENT_SELECT).order('created_at', { ascending: false }).limit(500),
      d => Array.isArray(d),
    )
    if (ok && data) return { data: (data as unknown[]).map(toPolicyAssessment), error: null }
    return { data: [], error: null }
  },

  async create(a: Omit<PolicyAssessment, 'id' | 'policyNumber' | 'assessorName' | 'createdAt'>) {
    const row = {
      policy_id: a.policyId, assessor_id: a.assessorId || null, subject_type: a.subjectType,
      crop_type: a.cropType ?? null, crop_population: a.cropPopulation ?? null, plant_date: a.plantDate || null,
      registration_number: a.registrationNumber ?? null, vehicle_make: a.vehicleMake ?? null,
      vehicle_model: a.vehicleModel ?? null, odometer_reading: a.odometerReading ?? null,
      existing_damage: a.existingDamage ?? null,
      photos: a.photos, notes: a.notes, gps_lat: a.gpsLat ?? null, gps_lng: a.gpsLng ?? null,
      barn_hooks: a.barnHooks ?? null, barn_tiers: a.barnTiers ?? null, barn_bays: a.barnBays ?? null,
      barn_ownership: a.barnOwnership ?? null, barn_usage: a.barnUsage ?? null,
      farmer_signature: a.farmerSignature ?? null, assessor_signature: a.assessorSignature ?? null,
      sync_status: a.syncStatus,
    }
    const { data, error } = await supabase.from('policy_assessments').insert(row).select(POLICY_ASSESSMENT_SELECT).single()
    if (error) return { data: null, error: error.message }
    return { data: toPolicyAssessment(data), error: null }
  },
}

// ── CUSTOM ROLES ──────────────────────────────────────────────────
export const customRoles = {
  async list() {
    const { ok, data } = await sb('custom_roles', 'read',
      () => supabase.from('custom_roles').select('*').order('name'),
      d => Array.isArray(d),
    )
    if (ok && data) return { data: (data as Record<string, unknown>[]).map(toCustomRole), error: null }
    return { data: [], error: null }
  },

  async create(role: { name: string; description?: string; permissions: string[] }) {
    const { data: { user } } = await supabase.auth.getUser()
    const row = { name: role.name, description: role.description ?? null, permissions: role.permissions, created_by: user?.id ?? null }
    const { data, error } = await supabase.from('custom_roles').insert(row).select().single()
    if (error) return { data: null, error: error.code === '23505' ? 'A role with that name already exists.' : error.message }
    return { data: toCustomRole(data as Record<string, unknown>), error: null }
  },

  async update(id: string, updates: { name?: string; description?: string; permissions?: string[] }) {
    const row: Record<string, unknown> = {}
    if (updates.name !== undefined) row.name = updates.name
    if (updates.description !== undefined) row.description = updates.description
    if (updates.permissions !== undefined) row.permissions = updates.permissions
    const { data, error } = await supabase.from('custom_roles').update(row).eq('id', id).select().single()
    if (error) return { data: null, error: error.code === '23505' ? 'A role with that name already exists.' : error.message }
    return { data: toCustomRole(data as Record<string, unknown>), error: null }
  },

  /** Deleting a role clears custom_role_id on any staff it's assigned to
   *  (ON DELETE SET NULL) rather than failing — their permissions array is
   *  unaffected since it was only ever a snapshot copied at assignment time. */
  async remove(id: string) {
    const { error } = await supabase.from('custom_roles').delete().eq('id', id)
    if (error) return { error: error.message }
    return { error: null }
  },
}

// ── TICKETS ───────────────────────────────────────────────────────
export const tickets = {
  async list() {
    const { ok, data } = await sb('tickets', 'read',
      () => supabase.from('tickets').select(TICKET_SELECT).order('created_at', { ascending: false }),
      d => Array.isArray(d),
    )
    if (ok && data) {
      const mapped = (data as unknown[]).map(toTicket)
      cacheSet('tickets', mapped)
      return { data: mapped, error: null }
    }
    const cached = cacheGet<Ticket>('tickets')
    if (cached) { local('tickets', 'read'); return { data: cached.data, error: null } }
    return { data: [] as Ticket[], error: 'Could not load tickets.' }
  },

  async create(ticket: Omit<Ticket, 'id'>) {
    const row = {
      ticket_number: ticket.ticketNumber, client_id: ticket.clientId,
      subject: ticket.subject, description: ticket.description,
      status: ticket.status, priority: ticket.priority, category: ticket.category,
      messages: ticket.messages,
    }
    const { ok, data, error } = await sb('tickets', 'write',
      () => supabase.from('tickets').insert(row).select(TICKET_SELECT).single(),
    )
    if (ok && data) return { data: toTicket(data), error: null }
    return writeFailed('tickets', error)
  },

  async update(id: string, updates: Partial<Ticket>) {
    const row: Record<string, unknown> = {}
    if (updates.status     !== undefined) row.status      = updates.status
    if (updates.assignedTo !== undefined) row.assigned_to = updates.assignedTo ?? null
    if (updates.messages   !== undefined) row.messages    = updates.messages
    row.updated_at = new Date().toISOString()
    const { ok, data, error } = await sb('tickets', 'write',
      () => supabase.from('tickets').update(row).eq('id', id).select(TICKET_SELECT).single(),
    )
    if (ok && data) return { data: toTicket(data), error: null }
    return writeFailed('tickets', error)
  },
}

// ── EMAILS ────────────────────────────────────────────────────────
export const emails = {
  async list(folder?: 'inbox' | 'sent') {
    const { ok, data } = await sb('emails', 'read',
      () => {
        let q = supabase.from('emails').select('*').order('created_at', { ascending: false })
        if (folder) q = q.eq('folder', folder)
        return q
      },
      d => Array.isArray(d),
    )
    if (ok && data) return { data: (data as unknown[]).map(toEmail), error: null }
    return { data: [] as EmailMessage[], error: 'Could not load the mailbox.' }
  },

  async create(email: Omit<EmailMessage, 'id' | 'timestamp'>) {
    const row = {
      from_address: email.from, from_name: email.fromName, to_address: email.to,
      subject: email.subject, body: email.body, read: email.read,
      folder: email.folder, linked_to: email.linkedTo ?? null,
    }
    const { ok, data, error } = await sb('emails', 'write',
      () => supabase.from('emails').insert(row).select().single(),
    )
    if (ok && data) return { data: toEmail(data), error: null }
    return writeFailed('emails', error)
  },

  async update(id: string, updates: Partial<EmailMessage>) {
    const row: Record<string, unknown> = {}
    if (updates.read    !== undefined) row.read    = updates.read
    if (updates.starred !== undefined) row.starred = updates.starred
    if (updates.folder  !== undefined) row.folder  = updates.folder
    const { ok, data, error } = await sb('emails', 'write',
      () => supabase.from('emails').update(row).eq('id', id).select().single(),
    )
    if (ok && data) return { data: toEmail(data), error: null }
    return writeFailed('emails', error)
  },

  async markRead(id: string) {
    await sb('emails', 'write', () => supabase.from('emails').update({ read: true }).eq('id', id))
  },

  async delete(id: string) {
    await sb('emails', 'delete', () => supabase.from('emails').delete().eq('id', id))
  },
}

// ── LEADS ─────────────────────────────────────────────────────────
export const leads = {
  async list() {
    const { ok, data } = await sb('leads', 'read',
      () => supabase.from('leads').select('*').order('created_at', { ascending: false }),
      d => Array.isArray(d),
    )
    if (ok && data) {
      const mapped = (data as unknown[]).map(toLead)
      cacheSet('leads', mapped)
      return { data: mapped, error: null }
    }
    const cached = cacheGet<Lead>('leads')
    if (cached) { local('leads', 'read'); return { data: cached.data, error: null } }
    return { data: [] as Lead[], error: 'Could not load leads.' }
  },

  async create(lead: Omit<Lead, 'id'>) {
    const row = {
      name: lead.name, email: lead.email ?? null, phone: lead.phone,
      source: lead.source, product_interest: lead.productInterest,
      status: lead.status, intent_score: lead.intentScore, assigned_to: lead.assignedTo ?? null,
    }
    const start = Date.now()
    const { data, error } = await supabase.from('leads').insert(row).select().single()
    health.record({ ts: Date.now(), type: 'write', table: 'leads', success: !error, duration: Date.now() - start, source: 'supabase', detail: error ? String(error.message) : undefined })
    if (error) return { data: null, error: error.message }
    return { data: toLead(data), error: null }
  },

  async update(id: string, updates: Partial<Lead>) {
    const row: Record<string, unknown> = {}
    if (updates.status      !== undefined) row.status       = updates.status
    if (updates.notes       !== undefined) row.notes        = updates.notes ?? null
    if (updates.lastContact !== undefined) row.last_contact = updates.lastContact ?? null
    if (updates.assignedTo  !== undefined) row.assigned_to  = updates.assignedTo ?? null
    const { ok, data, error } = await sb('leads', 'write',
      () => supabase.from('leads').update(row).eq('id', id).select().single(),
    )
    if (ok && data) return { data: toLead(data), error: null }
    return writeFailed('leads', error)
  },
}

// ── STAFF / PROFILES ──────────────────────────────────────────────
export const staff = {
  // No local-storage fallback here — unlike most list() methods, a stale
  // mock roster standing in for real staff/system accounts is actively
  // dangerous: it looks real enough to act on (edit, delete) but its IDs
  // don't exist in the real profiles table, so e.g. a delete against it
  // fails with a confusing 404 instead of the real account ever being
  // touched. Better to surface the load failure than to risk that.
  async list() {
    // profiles holds every signed-in identity, not just staff -- a client's
    // own portal login (role='policyholder', created automatically on their
    // first purchase) and an API partner's login-disabled identity
    // (role='api_partner') both live here too. Filtered to STAFF_ROLES so
    // neither can surface as an assignable agent, a claim reviewer, or a row
    // on the Staff Management page itself.
    const { ok, data } = await sb('profiles', 'read',
      () => supabase.from('profiles').select('*, custom_roles!profiles_custom_role_id_fkey(name)').in('role', STAFF_ROLES).order('name'),
      d => Array.isArray(d),
    )
    if (ok && data) return { data: (data as Record<string,unknown>[]).map(toProfile), error: null }
    return { data: null, error: 'Could not load the staff list from the server. Please check your connection and try again.' }
  },

  /**
   * Creates a real Supabase Auth user + profiles row via a server-side /api function
   * (api/create-account.ts), which alone holds the service-role
   * key needed for account creation. Unlike every other method in this
   * module, there is no local-storage fallback here — a "staff member"
   * that only exists in browser state was never real, so a failure must be
   * surfaced as an error rather than silently faked.
   */
  async create(input: { name: string; username?: string; email: string; password: string; phone?: string; role: string; department: string; customRoleId?: string; permissions?: string[] }) {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return { data: null, error: 'Not signed in.' }
    try {
      const res = await fetch('/api/create-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
        body: JSON.stringify(input),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) return { data: null, error: body?.error ?? `Failed to create staff account (HTTP ${res.status}).` }
      return { data: toProfile(body.profile as Record<string, unknown>), error: null }
    } catch (e) {
      return { data: null, error: `Could not reach the server: ${e}` }
    }
  },

  // No local-storage fallback — a profile edit (name/phone especially) that
  // only "succeeds" into localStorage looks fine in the moment but reverts
  // the next time real data loads, which is exactly what was reported.
  async update(id: string, updates: Partial<AppUser>) {
    const row: Record<string, unknown> = {}
    if (updates.name        !== undefined) row.name        = updates.name
    if (updates.username    !== undefined) row.username    = updates.username?.trim() || null
    // Sign-in identity is the full name: any edit that changes the name
    // without an explicit username keeps the two identical.
    else if (updates.name   !== undefined) row.username    = updates.name?.trim() || null
    if (updates.role        !== undefined) row.role        = updates.role
    if (updates.department  !== undefined) row.department  = updates.department
    if (updates.phone       !== undefined) row.phone       = updates.phone ?? null
    if (updates.active      !== undefined) row.active      = updates.active
    if (updates.permissions !== undefined) row.permissions = updates.permissions
    if (updates.customRoleId !== undefined) row.custom_role_id = updates.customRoleId || null
    const start = Date.now()
    const { data, error } = await supabase.from('profiles').update(row).eq('id', id).select('*, custom_roles!profiles_custom_role_id_fkey(name)').single()
    health.record({ ts: Date.now(), type: 'write', table: 'profiles', success: !error, duration: Date.now() - start, source: 'supabase', detail: error ? String(error.message) : undefined })
    if (error) return { data: null, error: error.code === '23505' ? 'A user with that full name already exists — sign-in names must be unique.' : error.message }
    return { data: toProfile(data as Record<string,unknown>), error: null }
  },

  /**
   * Permanently deletes a staff member via delete-staff.ts (service-role
   * only — removes the Supabase Auth identity itself, not just the
   * profiles row, so the account can no longer sign in at all). No
   * local-storage fallback, same reasoning as create(): a "deleted" staff
   * member that only disappeared from browser state was never really gone.
   */
  async remove(staffId: string) {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return { error: 'Not signed in.' }
    try {
      const res = await fetch('/api/delete-staff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
        body: JSON.stringify({ staffId }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) return { error: body?.error ?? `Failed to delete staff account (HTTP ${res.status}).` }
      return { error: null }
    } catch (e) {
      return { error: `Could not reach the server: ${e}` }
    }
  },

  /**
   * Creates a Super Admin / Admin / Tech Support account — same
   * api/create-account.ts endpoint as staff.create() (Staff Management,
   * work roles only), which branches on whether body.role falls into the
   * system-role or work-role list. Super Admin caller only, enforced both
   * here and again by the DB trigger.
   */
  async createSystemUser(input: { name: string; username?: string; email: string; password: string; phone?: string; role: string; department: string }) {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return { data: null, error: 'Not signed in.' }
    try {
      const res = await fetch('/api/create-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
        body: JSON.stringify(input),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) return { data: null, error: body?.error ?? `Failed to create account (HTTP ${res.status}).` }
      return { data: toProfile(body.profile as Record<string, unknown>), error: null }
    } catch (e) {
      return { data: null, error: `Could not reach the server: ${e}` }
    }
  },

  /**
   * Sets a new password for a staff member via reset-staff-password.ts
   * (service-role only). Replaces the "Not editable here" dead end that
   * used to be the only thing shown for an existing staff member's
   * password — an admin helping a locked-out colleague has no way to
   * supply that colleague's CURRENT password, so self-service Change
   * Password isn't an option for them.
   */
  async resetPassword(staffId: string, newPassword: string) {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return { error: 'Not signed in.' }
    try {
      const res = await fetch('/api/reset-staff-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
        body: JSON.stringify({ staffId, newPassword }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) return { error: body?.error ?? `Failed to reset password (HTTP ${res.status}).` }
      return { error: null }
    } catch (e) {
      return { error: `Could not reach the server: ${e}` }
    }
  },
}

// ── FRAUD CASES ───────────────────────────────────────────────────
export const fraudCases = {
  async list() {
    const { ok, data } = await sb('fraud_cases', 'read',
      () => supabase.from('fraud_cases').select(FRAUD_SELECT).order('created_at', { ascending: false }),
      d => Array.isArray(d),
    )
    if (ok && data) {
      const mapped = (data as unknown[]).map(toFraudCase)
      cacheSet('fraud_cases', mapped)
      return { data: mapped, error: null }
    }
    const cached = cacheGet<FraudCase>('fraud_cases')
    if (cached) { local('fraud_cases', 'read'); return { data: cached.data, error: null } }
    return { data: [] as FraudCase[], error: 'Could not load fraud cases.' }
  },

  async update(id: string, updates: Partial<FraudCase>) {
    const row: Record<string, unknown> = {}
    if (updates.status     !== undefined) row.status      = updates.status
    if (updates.assignedTo !== undefined) row.assigned_to = updates.assignedTo ?? null
    if (updates.notes      !== undefined) row.notes       = updates.notes ?? null
    if (updates.resolvedAt !== undefined) row.resolved_at = updates.resolvedAt ?? null
    const { ok, data, error } = await sb('fraud_cases', 'write',
      () => supabase.from('fraud_cases').update(row).eq('id', id).select(FRAUD_SELECT).single(),
    )
    if (ok && data) return { data: toFraudCase(data), error: null }
    return writeFailed('fraud_cases', error)
  },

  /** Auto-opened when a newly submitted claim's AI fraud score clears the review threshold. */
  async create(claimId: string, fraudScore: number, signals: string[]) {
    const row = { claim_id: claimId, fraud_score: fraudScore, signals, status: 'open' }
    const { data, error } = await supabase.from('fraud_cases').insert(row).select(FRAUD_SELECT).single()
    if (error) return { data: null, error: error.message }
    return { data: toFraudCase(data), error: null }
  },
}

// ── REMINDERS ─────────────────────────────────────────────────────
export const reminders = {
  async list() {
    const select = await reminderSelect()
    const { ok, data } = await sb('reminders', 'read',
      () => supabase.from('reminders').select(select).order('due_date'),
      d => Array.isArray(d),
    )
    if (ok && data) return { data: (data as unknown[]).map(toReminder), error: null }
    return { data: [] as Reminder[], error: 'Could not load reminders.' }
  },

  /** Records the verbatim SMS text alongside the sent flag so the log can
   *  show the client exactly what their phone received. Tolerant of a
   *  database that hasn't run add_reminder_sms_body.sql yet. */
  async markSent(id: string, smsBody?: string) {
    const payload = smsBody ? { sent: true, sms_body: smsBody } : { sent: true }
    const { ok } = await sb('reminders', 'write', () => supabase.from('reminders').update(payload).eq('id', id))
    if (!ok && smsBody) await sb('reminders', 'write', () => supabase.from('reminders').update({ sent: true }).eq('id', id))

  },

  async markAllSent(ids: string[]) {
    await sb('reminders', 'write', () => supabase.from('reminders').update({ sent: true }).in('id', ids))

  },

  /** Has a reminder tagged with this stage already been logged for this
   *  policy+due date? Dedup lives in the database (not localStorage) so it
   *  holds regardless of how many staff browsers have the app open —
   *  otherwise every logged-in staff member's hourly check would re-send
   *  the same reminder independently. */
  async existsForStage(policyId: string, dueDateISO: string, stageTag: string): Promise<boolean> {
    const { data, error } = await supabase
      .from('reminders').select('id').eq('policy_id', policyId).eq('due_date', dueDateISO)
      .like('message', `${stageTag}%`).limit(1)
    if (error) return false // fail open: better to risk a rare duplicate than silently stop all reminders
    return (data?.length ?? 0) > 0
  },

  async create(reminder: Omit<Reminder, 'id'>) {
    const select = await reminderSelect()
    const row = {
      type: reminder.type, client_id: reminder.clientId, policy_id: reminder.policyId ?? null,
      due_date: reminder.dueDate, message: reminder.message, sent: reminder.sent, channel: reminder.channel,
    }
    let { data, error } = await supabase.from('reminders')
      .insert((reminder.smsBody ? { ...row, sms_body: reminder.smsBody } : row) as Record<string, unknown>)
      .select(select).single()
    if (error && reminder.smsBody) {
      // sms_body missing (migration not run) — still log the reminder.
      const retry = await supabase.from('reminders').insert(row).select(select).single()
      data = retry.data; error = retry.error
    }
    if (error) return { data: null, error: error.message }
    return { data: toReminder(data), error: null }
  },
}

// ── CAUTION FLAGS ─────────────────────────────────────────────────
// Real table (not localStorage) so a flag raised by one staff member's
// browser is visible to every other staff member, including whoever
// reviews claims — a caution flag is meant to trigger extra scrutiny there.
export const cautionFlags = {
  async listActive() {
    const { data, error } = await supabase.from('caution_flags').select('*').eq('cleared', false).order('flagged_at', { ascending: false })
    if (error) return { data: [] as CautionFlag[], error: error.message }
    return { data: (data ?? []).map(toCautionFlag), error: null }
  },

  async get(policyId: string) {
    const { data, error } = await supabase.from('caution_flags').select('*').eq('policy_id', policyId).maybeSingle()
    if (error || !data) return { data: null, error: error?.message ?? null }
    return { data: toCautionFlag(data), error: null }
  },

  async set(flag: CautionFlag) {
    const row = {
      policy_id: flag.policyId, policy_number: flag.policyNumber, client_id: flag.clientId,
      client_name: flag.clientName, agent_id: flag.agentId ?? null, days_overdue: flag.daysOverdue,
      flagged_at: flag.flaggedAt, months_defaulted: flag.monthsDefaulted, cleared: flag.cleared,
      cleared_at: flag.clearedAt ?? null,
    }
    const { error } = await supabase.from('caution_flags').upsert(row, { onConflict: 'policy_id' })
    return { error: error?.message ?? null }
  },

  async clear(policyId: string) {
    const { error } = await supabase.from('caution_flags')
      .update({ cleared: true, cleared_at: new Date().toISOString() }).eq('policy_id', policyId)
    return { error: error?.message ?? null }
  },
}

// ── EXCHANGE RATES ────────────────────────────────────────────────

function toExchangeRate(row: Record<string, unknown>): ExchangeRate {
  return {
    id: String(row.id),
    currency: 'ZWG',
    rate: Number(row.rate),
    effectiveDate: String(row.effective_date),
    source: row.source === 'estimate' ? 'estimate' : 'manual',
    note: (row.note as string) ?? undefined,
    setBy: (row.set_by as string) ?? undefined,
    createdAt: String(row.created_at),
  }
}

export const exchangeRates = {
  /** The rate in force: the newest effective_date on record. */
  async current(currency: 'ZWG' = 'ZWG') {
    const { data, error } = await supabase.from('exchange_rates')
      .select('*').eq('currency', currency)
      .order('effective_date', { ascending: false }).limit(1).maybeSingle()
    if (error || !data) return { data: null, error: error?.message ?? null }
    return { data: toExchangeRate(data), error: null }
  },

  /** Newest first, for the history table and the trend chart. */
  async history(currency: 'ZWG' = 'ZWG', limit = 60) {
    const { data, error } = await supabase.from('exchange_rates')
      .select('*').eq('currency', currency)
      .order('effective_date', { ascending: false }).limit(limit)
    if (error) return { data: [] as ExchangeRate[], error: error.message }
    return { data: (data ?? []).map(toExchangeRate), error: null }
  },

  /**
   * Records a rate. One row per day: setting a rate twice on the same date
   * replaces that day's figure rather than adding a second one, so the
   * history stays one reading per effective date.
   */
  async set(input: {
    rate: number
    effectiveDate: string
    source?: 'manual' | 'estimate'
    note?: string
    setBy?: string
    currency?: 'ZWG'
  }) {
    const row = {
      currency: input.currency ?? 'ZWG',
      rate: input.rate,
      effective_date: input.effectiveDate,
      source: input.source ?? 'manual',
      note: input.note ?? null,
      set_by: input.setBy ?? null,
    }
    const { data, error } = await supabase.from('exchange_rates')
      .upsert(row, { onConflict: 'currency,effective_date' }).select('*').single()
    if (error || !data) return { data: null, error: error?.message ?? 'Could not save the rate.' }
    return { data: toExchangeRate(data), error: null }
  },
}

// ── DEVELOPER API ─────────────────────────────────────────────────
export interface ApiDeveloper {
  id: string
  agentProfileId: string
  companyName: string
  contactEmail: string
  contactPhone?: string
  status: 'active' | 'suspended' | 'terminated'
  commissionOverridePercent?: number
  termsAcceptedAt?: string
  termsVersion?: string
  terminatedAt?: string
  terminationReason?: string
  createdAt: string
  /** Money this Digital Agent has on deposit with us. A policy can only
   *  be issued through the API against this float — enforced server-side
   *  in api/v1.ts, never trusted from the client. */
  walletBalance: number
}

export interface ApiKeyRow {
  id: string
  developerId: string
  keyPrefix: string
  /** Safe to display/copy at any time — identifies the key without
   *  granting access on its own (mirrors Stripe's pk_/sk_ pattern). */
  publishableKey: string
  environment: 'sandbox' | 'live'
  scopes: string[]
  status: 'active' | 'paused' | 'revoked'
  rateLimitPerMin: number
  createdAt: string
  lastUsedAt?: string
}

export interface ApiRequestLogRow {
  id: string
  keyId: string
  keyPrefix?: string
  endpoint: string
  statusCode: number
  ts: string
}

export interface ApiUsageStats {
  requestsToday: number
  requests7d: number
  requestsTotal: number
  lastRequestAt?: string
  errorRate7d: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toApiDeveloper(r: any): ApiDeveloper {
  return {
    id: r.id, agentProfileId: r.agent_profile_id, companyName: r.company_name,
    contactEmail: r.contact_email, contactPhone: r.contact_phone ?? undefined,
    status: r.status, commissionOverridePercent: r.commission_override_percent ?? undefined,
    termsAcceptedAt: r.terms_accepted_at ?? undefined, termsVersion: r.terms_version ?? undefined,
    terminatedAt: r.terminated_at ?? undefined, terminationReason: r.termination_reason ?? undefined,
    createdAt: r.created_at,
    walletBalance: Number(r.wallet_balance) || 0,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toApiKeyRow(r: any): ApiKeyRow {
  return {
    id: r.id, developerId: r.developer_id, keyPrefix: r.key_prefix,
    publishableKey: r.publishable_key ?? '', environment: (r.environment as 'sandbox' | 'live') ?? 'live',
    scopes: r.scopes ?? [],
    status: r.status, rateLimitPerMin: r.rate_limit_per_min, createdAt: r.created_at,
    lastUsedAt: r.last_used_at ?? undefined,
  }
}

export const developerApi = {
  async listDevelopers() {
    const { data, error } = await supabase.from('api_developers').select('*').order('created_at', { ascending: false })
    if (error) return { data: [] as ApiDeveloper[], error: error.message }
    return { data: (data ?? []).map(toApiDeveloper), error: null }
  },

  async listKeys(developerId: string) {
    const { data, error } = await supabase.from('api_keys').select('*').eq('developer_id', developerId).order('created_at', { ascending: false })
    if (error) return { data: [] as ApiKeyRow[], error: error.message }
    return { data: (data ?? []).map(toApiKeyRow), error: null }
  },

  /** Only ever raises the float, and only by a Super Admin/Admin action
   *  here -- never automatically from anything the API itself reports,
   *  since a Digital Agent's own claim of having been paid is not a
   *  trustworthy signal to credit its own spending limit. The developer's
   *  own settlement (paying us back) happens off-system; this is staff
   *  recording that it happened. */
  async topUpWallet(developerId: string, amount: number, note: string, createdBy?: string) {
    if (!Number.isFinite(amount) || amount <= 0) return { data: null, error: 'Amount must be a positive number.' }
    const { data: dev, error: devError } = await supabase.from('api_developers').select('wallet_balance').eq('id', developerId).single()
    if (devError || !dev) return { data: null, error: devError?.message ?? 'Developer not found.' }
    const newBalance = Math.round((Number(dev.wallet_balance) + amount) * 100) / 100
    const { data, error } = await supabase.from('api_developers').update({ wallet_balance: newBalance }).eq('id', developerId).select('*').single()
    if (error || !data) return { data: null, error: error?.message ?? 'Failed to update wallet.' }
    await supabase.from('api_wallet_transactions').insert({
      developer_id: developerId, type: 'topup', amount, balance_after: newBalance, note: note || null, created_by: createdBy ?? null,
    })
    return { data: toApiDeveloper(data), error: null }
  },

  async listWalletTransactions(developerId: string, limit = 50) {
    const { data, error } = await supabase
      .from('api_wallet_transactions').select('*')
      .eq('developer_id', developerId).order('created_at', { ascending: false }).limit(limit)
    if (error) return { data: [], error: error.message }
    return {
      data: (data ?? []).map(r => ({
        id: r.id as string, type: r.type as string, amount: Number(r.amount), balanceAfter: Number(r.balance_after),
        note: (r.note as string) ?? undefined, createdBy: (r.created_by as string) ?? undefined, createdAt: r.created_at as string,
      })),
      error: null,
    }
  },

  /** Calls api-partners.ts (action=create-developer, routed by a vercel.json
   *  rewrite from this URL) — needs the service-role key to create the
   *  partner's login-disabled identity. */
  async createDeveloper(input: { companyName: string; contactEmail: string; contactPhone?: string; termsVersion: string }) {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return { data: null, error: 'Not signed in.' }
    try {
      // termsAccepted is hardcoded true here — the only caller (DeveloperApi
      // page) already gates the Register button on the acceptance checkbox,
      // so by the time this fires the admin has confirmed it on the client's
      // behalf. termsVersion still travels through from the caller so the
      // stored record reflects exactly what was shown at registration time.
      const res = await fetch('/api/create-api-developer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
        body: JSON.stringify({ ...input, termsAccepted: true }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) return { data: null, error: body?.error ?? `Failed to register developer (HTTP ${res.status}).` }
      return { data: toApiDeveloper(body.developer), error: null }
    } catch (e) {
      return { data: null, error: `Could not reach the server: ${e}` }
    }
  },

  /** Calls api-partners.ts (action=create-key, routed by a vercel.json
   *  rewrite from this URL). Returns the raw secret key ONCE — it is never
   *  stored or retrievable again. The publishable key is safe to fetch and
   *  display again later (it's just a display/lookup id, not a credential). */
  async issueKey(developerId: string, opts?: { scopes?: string[]; rateLimitPerMin?: number; environment?: 'sandbox' | 'live' }) {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return { data: null, error: 'Not signed in.' }
    try {
      const res = await fetch('/api/create-api-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
        body: JSON.stringify({ developerId, scopes: opts?.scopes, rateLimitPerMin: opts?.rateLimitPerMin, environment: opts?.environment ?? 'live' }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) return { data: null, error: body?.error ?? `Failed to issue key (HTTP ${res.status}).` }
      return { data: { ...toApiKeyRow(body.key), rawKey: body.key.rawKey as string }, error: null }
    } catch (e) {
      return { data: null, error: `Could not reach the server: ${e}` }
    }
  },

  async revokeKey(keyId: string) {
    const { error } = await supabase.from('api_keys').update({ status: 'revoked' }).eq('id', keyId)
    return { error: error?.message ?? null }
  },

  /** Reversible, unlike revoke — a paused key can be resumed. Rejected by
   *  the external API exactly like a revoked one in the meantime (only
   *  status = 'active' is accepted there). */
  async pauseKey(keyId: string) {
    const { error } = await supabase.from('api_keys').update({ status: 'paused' }).eq('id', keyId)
    return { error: error?.message ?? null }
  },

  async resumeKey(keyId: string) {
    const { error } = await supabase.from('api_keys').update({ status: 'active' }).eq('id', keyId)
    return { error: error?.message ?? null }
  },

  /** Recent raw request log for one developer's keys — the audit trail
   *  behind the usage stats below. */
  async listRequestLog(developerId: string, limit = 100): Promise<{ data: ApiRequestLogRow[]; error: string | null }> {
    const { data: keys } = await supabase.from('api_keys').select('id, key_prefix').eq('developer_id', developerId)
    const keyIds = (keys ?? []).map(k => k.id)
    if (keyIds.length === 0) return { data: [], error: null }
    const prefixById = new Map((keys ?? []).map(k => [k.id, k.key_prefix as string]))
    const { data, error } = await supabase
      .from('api_request_log')
      .select('id, key_id, endpoint, status_code, ts')
      .in('key_id', keyIds)
      .order('ts', { ascending: false })
      .limit(limit)
    if (error) return { data: [], error: error.message }
    return {
      data: (data ?? []).map(r => ({
        id: r.id, keyId: r.key_id, keyPrefix: prefixById.get(r.key_id), endpoint: r.endpoint, statusCode: r.status_code, ts: r.ts,
      })),
      error: null,
    }
  },

  /** Aggregate usage counts for one developer across all their keys —
   *  today, last 7 days, all-time, and a rough error rate so a suspiciously
   *  high failure/rate-limit ratio is visible at a glance. */
  async getUsageStats(developerId: string): Promise<{ data: ApiUsageStats; error: string | null }> {
    const empty: ApiUsageStats = { requestsToday: 0, requests7d: 0, requestsTotal: 0, errorRate7d: 0 }
    const { data: keys } = await supabase.from('api_keys').select('id').eq('developer_id', developerId)
    const keyIds = (keys ?? []).map(k => k.id)
    if (keyIds.length === 0) return { data: empty, error: null }

    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0)
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000)

    const [todayRes, weekRes, totalRes, lastRes] = await Promise.all([
      supabase.from('api_request_log').select('*', { count: 'exact', head: true }).in('key_id', keyIds).gte('ts', startOfToday.toISOString()),
      supabase.from('api_request_log').select('status_code').in('key_id', keyIds).gte('ts', sevenDaysAgo.toISOString()),
      supabase.from('api_request_log').select('*', { count: 'exact', head: true }).in('key_id', keyIds),
      supabase.from('api_request_log').select('ts').in('key_id', keyIds).order('ts', { ascending: false }).limit(1).maybeSingle(),
    ])

    const weekRows = (weekRes.data ?? []) as { status_code: number }[]
    const errors7d = weekRows.filter(r => r.status_code >= 400).length

    return {
      data: {
        requestsToday: todayRes.count ?? 0,
        requests7d: weekRows.length,
        requestsTotal: totalRes.count ?? 0,
        lastRequestAt: (lastRes.data as { ts: string } | null)?.ts,
        errorRate7d: weekRows.length > 0 ? Math.round((errors7d / weekRows.length) * 100) : 0,
      },
      error: null,
    }
  },

  async setDeveloperStatus(developerId: string, status: 'active' | 'suspended') {
    const { error } = await supabase.from('api_developers').update({ status }).eq('id', developerId)
    return { error: error?.message ?? null }
  },

  /**
   * Permanent — unlike suspend, there is no reactivate path back from this.
   * Revokes every active key for the developer in the same action, since a
   * terminated developer should lose access immediately, not just be
   * blocked from issuing new keys.
   */
  async terminateDeveloper(developerId: string, reason: string) {
    const { error: devError } = await supabase.from('api_developers').update({
      status: 'terminated', terminated_at: new Date().toISOString(), termination_reason: reason,
    }).eq('id', developerId)
    if (devError) return { error: devError.message }
    const { error: keysError } = await supabase.from('api_keys').update({ status: 'revoked' })
      .eq('developer_id', developerId).eq('status', 'active')
    return { error: keysError?.message ?? null }
  },

  async setCommissionOverride(developerId: string, pct: number | null) {
    const { error } = await supabase.from('api_developers').update({ commission_override_percent: pct }).eq('id', developerId)
    return { error: error?.message ?? null }
  },
}

// ── LOGIN ATTEMPTS ────────────────────────────────────────────────
// Real brute-force signal for System Health — previously that page had
// no security data at all, only DB latency stats.
export const loginAttempts = {
  /** Failed attempts in the last N minutes, grouped by email, for staff-only viewing. */
  async recentFailures(minutes = 15) {
    const since = new Date(Date.now() - minutes * 60000).toISOString()
    const { data, error } = await supabase
      .from('login_attempts').select('email, ts').eq('success', false).gte('ts', since).order('ts', { ascending: false })
    if (error || !data) return { data: [] as { email: string; count: number; lastAttempt: string }[], error: error?.message ?? null }
    const byEmail = new Map<string, { email: string; count: number; lastAttempt: string }>()
    for (const row of data as { email: string; ts: string }[]) {
      const existing = byEmail.get(row.email)
      if (existing) existing.count += 1
      else byEmail.set(row.email, { email: row.email, count: 1, lastAttempt: row.ts })
    }
    return { data: [...byEmail.values()].sort((a, b) => b.count - a.count), error: null }
  },

  /** Real sign-in history for one account — powers Profile > Audit Log,
   *  which used to show hardcoded sample rows regardless of who was
   *  actually logged in or what they'd actually done. */
  async historyFor(email: string, limit = 50): Promise<{ data: { success: boolean; ts: string }[]; error: string | null }> {
    const { data, error } = await supabase
      .from('login_attempts')
      .select('success, ts')
      .eq('email', email.toLowerCase())
      .order('ts', { ascending: false })
      .limit(limit)
    if (error) return { data: [], error: error.message }
    return { data: (data ?? []) as { success: boolean; ts: string }[], error: null }
  },
}

// ── APP SETTINGS ──────────────────────────────────────────────────
// Generic shared key/value settings store (notification config, gateway
// credentials, commission rates, …). Writable by admin/super_admin only
// (enforced by RLS) so a setting one Super Admin configures is what every
// staff browser actually uses, instead of each browser's own localStorage.
export const settings = {
  async get<T>(key: string): Promise<T | null> {
    const { data, error } = await supabase.from('app_settings').select('value').eq('key', key).maybeSingle()
    if (error || !data) return null
    return data.value as T
  },

  async set(key: string, value: unknown): Promise<{ error: string | null }> {
    const { data: { user } } = await supabase.auth.getUser()
    const { error } = await supabase.from('app_settings')
      .upsert({ key, value, updated_by: user?.id ?? null, updated_at: new Date().toISOString() }, { onConflict: 'key' })
    return { error: error?.message ?? null }
  },
}

// ── DASHBOARD STATS ──────────────────────────────────────────────
// Dashboard.tsx used to fetch every row of policies/claims/payments/leads/
// fraud_cases (each with embedded client/product/profile joins) just to
// compute a handful of counts and a 5-row "recent" table — the single
// heaviest set of queries in the app, re-run on every dashboard visit.
// This replaces that with count-only queries (near-zero payload) and
// narrow column selects, falling back to the old full-fetch-and-compute
// approach only if the lightweight path fails.

export interface DashboardStats {
  activePolicies: number
  pendingClaims: number
  totalPremiums: number
  newLeads: number
  fraudAlerts: number
  lapseRate: number
  totalClients: number
  /** Invoices issued but not yet paid — billed money still outstanding. */
  unpaidInvoices: number
  unpaidInvoiceAmount: number
  /** Clients on the register with NO policy of any status against them —
   *  the uncovered set the reconciliation sweep keeps finding after
   *  registration (or payment) happened with no cover written. The count
   *  is the full set; the array is capped at the 5 the dashboard notice
   *  names. */
  clientsNoPolicyCount: number
  clientsNoPolicy: { id: string; name: string; phone: string; createdAt: string }[]
  productBreakdown: { category: string; count: number }[]
  recentPolicies: Policy[]
  latestClaim: { claimNumber: string; clientName: string; at: string } | null
  latestPayment: { clientName: string; amount: number; at: string } | null
  latestLead: { name: string; source: string; at: string } | null
  latestFraud: { claimNumber: string; fraudScore: number; at: string } | null
  latestClient: { name: string; at: string } | null
}

async function loadDashboardStatsLight(): Promise<DashboardStats | null> {
  const recentPolicySelect = await policySelect()
  const [
    activeRes, pendingRes, leadsRes, fraudRes, lapsedRes, totalRes, premiumsRes, categoryRes, recentRes,
    latestClaimRes, latestPaymentRes, latestLeadRes, latestFraudRes, clientsCountRes, latestClientRes,
    unpaidInvoicesRes, noPolicyRes,
  ] = await Promise.all([
    supabase.from('policies').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('claims').select('*', { count: 'exact', head: true }).in('status', ['pending', 'under_review']),
    supabase.from('leads').select('*', { count: 'exact', head: true }).eq('status', 'new'),
    supabase.from('fraud_cases').select('*', { count: 'exact', head: true }).eq('status', 'open'),
    supabase.from('policies').select('*', { count: 'exact', head: true }).in('status', ['lapsed', 'defaulted']),
    supabase.from('policies').select('*', { count: 'exact', head: true }),
    supabase.from('payments').select('amount').eq('status', 'completed').limit(5000),
    supabase.from('policies').select('products!product_id(category)').limit(5000),
    supabase.from('policies').select(recentPolicySelect).order('created_at', { ascending: false }).limit(5),
    supabase.from('claims').select('claim_number, created_at, policies!policy_id(clients!client_id(name))').order('created_at', { ascending: false }).limit(1),
    supabase.from('payments').select('amount, payment_date, policies!policy_id(clients!client_id(name))').order('payment_date', { ascending: false }).limit(1),
    supabase.from('leads').select('name, source, created_at').order('created_at', { ascending: false }).limit(1),
    supabase.from('fraud_cases').select('fraud_score, created_at, claims!claim_id(claim_number)').order('created_at', { ascending: false }).limit(1),
    supabase.from('clients').select('*', { count: 'exact', head: true }),
    supabase.from('clients').select('name, created_at').order('created_at', { ascending: false }).limit(1),
    // Invoices are optional (table lands with add_invoices.sql) — queried
    // apart from the error gate so a missing table degrades to zero, not
    // a dashboard that refuses to load.
    supabase.from('invoices').select('amount').eq('status', 'issued').limit(5000),
    // Clients with no policy rows at all — the embedded policies(id)
    // left join returns NULL children exactly where cover was never
    // written. Optional like invoices: an error degrades to zero, not a
    // dashboard that refuses to load.
    supabase.from('clients')
      .select('id, name, phone, created_at, policies(id)', { count: 'exact' })
      .is('policies.id', null)
      .order('created_at', { ascending: false })
      .limit(5),
  ])

  const anyError = activeRes.error || pendingRes.error || leadsRes.error || fraudRes.error
    || lapsedRes.error || totalRes.error || premiumsRes.error || categoryRes.error || recentRes.error
    || latestClaimRes.error || latestPaymentRes.error || latestLeadRes.error || latestFraudRes.error
    || clientsCountRes.error || latestClientRes.error
  if (anyError) return null

  const unpaidInvoicesRows = unpaidInvoicesRes.error ? [] : (unpaidInvoicesRes.data ?? []) as { amount: number }[]
  const noPolicyRows = noPolicyRes.error ? [] : (noPolicyRes.data ?? []) as { id: string; name: string; phone: string | null; created_at: string }[]
  const clientsNoPolicyCount = noPolicyRes.error ? 0 : (noPolicyRes.count ?? noPolicyRows.length)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = latestClaimRes.data?.[0] as any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = latestPaymentRes.data?.[0] as any
  const l = latestLeadRes.data?.[0] as { name: string; source: string; created_at: string } | undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const f = latestFraudRes.data?.[0] as any
  const cl = latestClientRes.data?.[0] as { name: string; created_at: string } | undefined

  const totalPremiums = ((premiumsRes.data ?? []) as { amount: number }[]).reduce((s, p) => s + p.amount, 0)

  const categoryCounts = new Map<string, number>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const row of (categoryRes.data ?? []) as any[]) {
    const cat = row.products?.category ?? 'other'
    categoryCounts.set(cat, (categoryCounts.get(cat) ?? 0) + 1)
  }

  const total = totalRes.count ?? 0
  const lapsed = lapsedRes.count ?? 0

  return {
    activePolicies: activeRes.count ?? 0,
    pendingClaims: pendingRes.count ?? 0,
    totalPremiums,
    newLeads: leadsRes.count ?? 0,
    fraudAlerts: fraudRes.count ?? 0,
    lapseRate: total > 0 ? Number((lapsed / total * 100).toFixed(1)) : 0,
    totalClients: clientsCountRes.count ?? 0,
    unpaidInvoices: unpaidInvoicesRows.length,
    unpaidInvoiceAmount: Math.round(unpaidInvoicesRows.reduce((s, r) => s + (Number(r.amount) || 0), 0) * 100) / 100,
    clientsNoPolicyCount,
    clientsNoPolicy: noPolicyRows.map(r => ({ id: r.id, name: r.name, phone: r.phone ?? '', createdAt: r.created_at })),
    productBreakdown: [...categoryCounts.entries()].map(([category, count]) => ({ category, count })),
    recentPolicies: ((recentRes.data ?? []) as unknown[]).map(toPolicy),
    latestClaim: c ? { claimNumber: c.claim_number, clientName: c.policies?.clients?.name ?? '', at: c.created_at } : null,
    latestPayment: p ? { clientName: p.policies?.clients?.name ?? '', amount: p.amount, at: p.payment_date } : null,
    latestLead: l ? { name: l.name, source: l.source ?? '', at: l.created_at } : null,
    latestFraud: f ? { claimNumber: f.claims?.claim_number ?? '', fraudScore: f.fraud_score, at: f.created_at } : null,
    latestClient: cl ? { name: cl.name, at: cl.created_at } : null,
  }
}

async function loadDashboardStatsFallback(): Promise<DashboardStats> {
  const [{ data: allPolicies }, { data: allClaims }, { data: allPayments }, { data: allLeads }, { data: allFraud }, { data: allClients }, { data: allInvoices }] = await Promise.all([
    policies.list(), claims.list(), payments.list(), leads.list(), fraudCases.list(), clients.list(), invoices.list(),
  ])
  const pol = allPolicies ?? [], cla = allClaims ?? [], pay = allPayments ?? [], lea = allLeads ?? [], fra = allFraud ?? [], cli = allClients ?? []
  const uncovered = cli.filter(c => (c.policyCount ?? 0) === 0)
  const unpaid = (allInvoices ?? []).filter(i => i.status === 'issued')
  const total = pol.length
  const lapsed = pol.filter(p => p.status === 'lapsed' || p.status === 'defaulted').length
  const categoryCounts = new Map<string, number>()
  // Bucketed by product category, matching the primary query above — this
  // fallback used to bucket by product NAME, so the dashboard's category
  // breakdown listed individual packages as though they were categories.
  for (const p of pol) {
    const cat = p.productCategory ?? 'other'
    categoryCounts.set(cat, (categoryCounts.get(cat) ?? 0) + 1)
  }
  return {
    activePolicies: pol.filter(p => p.status === 'active').length,
    pendingClaims: cla.filter(c => c.status === 'pending' || c.status === 'under_review').length,
    totalPremiums: pay.filter(p => p.status === 'completed').reduce((s, p) => s + p.amount, 0),
    newLeads: lea.filter(l => l.status === 'new').length,
    fraudAlerts: fra.filter(f => f.status === 'open').length,
    lapseRate: total > 0 ? Number((lapsed / total * 100).toFixed(1)) : 0,
    totalClients: cli.length,
    unpaidInvoices: unpaid.length,
    unpaidInvoiceAmount: Math.round(unpaid.reduce((s, i) => s + i.amount, 0) * 100) / 100,
    clientsNoPolicyCount: uncovered.length,
    clientsNoPolicy: uncovered.slice(0, 5).map(c => ({ id: c.id, name: c.name, phone: c.phone, createdAt: c.createdAt })),
    productBreakdown: [...categoryCounts.entries()].map(([category, count]) => ({ category, count })),
    recentPolicies: [...pol].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5),
    latestClaim: cla[0] ? { claimNumber: cla[0].claimNumber, clientName: cla[0].clientName, at: cla[0].dateSubmitted } : null,
    latestPayment: pay[0] ? { clientName: pay[0].clientName, amount: pay[0].amount, at: pay[0].date } : null,
    latestLead: lea[0] ? { name: lea[0].name, source: lea[0].source, at: lea[0].createdAt } : null,
    latestFraud: fra[0] ? { claimNumber: fra[0].claimNumber, fraudScore: fra[0].fraudScore, at: fra[0].createdAt } : null,
    latestClient: cli[0] ? (() => { const c = [...cli].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]; return { name: c.name, at: c.createdAt } })() : null,
  }
}

// ── NOTIFICATION LOG ────────────────────────────────────────────────
// The audit table api/_lib/notify.ts writes every delivery attempt into.
// Read by the admin dashboard so a failed SMS/email/WhatsApp surfaces as
// a banner instead of pretending health is 100%. Tolerant by design: the
// table only exists after database/add_notifications.sql runs, and a
// missing table must read as "no failures to show", not a page error.
export interface NotificationFailure {
  id?: string
  event: string
  channel: string
  recipient: string
  ref: string | null
  detail: string | null
  at: string
  status?: string
}

export const notificationLog = {
  async recentFailures(hours = 24): Promise<NotificationFailure[]> {
    try {
      const { data, error } = await supabase
        .from('notification_log')
        .select('event, channel, recipient, ref, detail, created_at')
        .eq('status', 'failed')
        // Cleared failures stay in the delivery log — they just stop
        // raising the banner.
        .is('dismissed_at', null)
        .gte('created_at', new Date(Date.now() - hours * 3600000).toISOString())
        .order('created_at', { ascending: false })
        .limit(50)
      if (error) return []
      return (data ?? []).map(r => ({
        event: r.event, channel: r.channel, recipient: r.recipient,
        ref: r.ref, detail: r.detail, at: r.created_at,
      }))
    } catch { return [] }
  },
  /** Clear the banner: every undismissed failure is stamped, keeping
   *  the row's 'failed' truth for the delivery log. New failures after
   *  this point still raise the banner — they're not dismissed. */
  async dismissFailures(): Promise<{ error: string | null }> {
    try {
      const { error } = await supabase
        .from('notification_log')
        .update({ dismissed_at: new Date().toISOString() })
        .eq('status', 'failed')
        .is('dismissed_at', null)
      return { error: error ? 'Could not clear the notifications.' : null }
    } catch { return { error: 'Could not clear the notifications.' } }
  },

  /** Browse the delivery log — every recorded notification attempt,
   *  newest first, filterable by channel, status, a date window, and free
   *  text across recipient/ref/detail/event (so "263780086175", "TOB0540"
   *  or "502" all find their rows). This is the view support opens when a
   *  client says a text never arrived. */
  async search(opts: {
    channel?: string
    status?: string
    text?: string
    from?: string
    to?: string
    limit?: number
  } = {}): Promise<NotificationFailure[]> {
    try {
      let q = supabase
        .from('notification_log')
        .select('event, channel, recipient, ref, detail, status, created_at')
        .order('created_at', { ascending: false })
        .limit(opts.limit ?? 300)
      if (opts.channel) q = q.eq('channel', opts.channel)
      if (opts.status) q = q.eq('status', opts.status)
      if (opts.from) q = q.gte('created_at', opts.from)
      if (opts.to) q = q.lte('created_at', opts.to)
      const text = opts.text?.trim()
      if (text) {
        // PostgREST .or() commas split filters — strip them (and a couple
        // of other syntax-significant chars) so a pasted number or ref
        // can't corrupt the query.
        const esc = text.replace(/[%,().]/g, ' ').replace(/\s+/g, ' ').trim()
        if (esc) q = q.or(`recipient.ilike.%${esc}%,ref.ilike.%${esc}%,detail.ilike.%${esc}%,event.ilike.%${esc}%`)
      }
      const { data, error } = await q
      if (error) return []
      return (data ?? []).map(r => ({
        event: r.event, channel: r.channel, recipient: r.recipient,
        ref: r.ref, detail: r.detail, at: r.created_at, status: r.status,
      }))
    } catch { return [] }
  },

  /** WhatsApp messages parked for a staff member to send by hand — the
   *  outbox the wa.me links in `detail` are tapped from. Bounded to 48h
   *  like the SMS outbox: a link older than that carries the wording it
   *  was queued with, so an ancient tap sends yesterday's format, not
   *  today's. */
  async whatsappOutbox(): Promise<NotificationFailure[]> {
    try {
      const { data, error } = await supabase
        .from('notification_log')
        .select('id, event, channel, recipient, ref, detail, created_at')
        .eq('channel', 'whatsapp')
        .eq('status', 'queued')
        .gte('created_at', new Date(Date.now() - 48 * 3600000).toISOString())
        .order('created_at', { ascending: false })
        .limit(100)
      if (error) return []
      return (data ?? []).map(r => ({
        id: r.id, event: r.event, channel: r.channel, recipient: r.recipient,
        ref: r.ref, detail: r.detail, at: r.created_at,
      }))
    } catch { return [] }
  },

  /** A staff member tapped a queued wa.me link — record the hand-delivery
   *  so the row leaves EVERY staff member's outbox, not just this
   *  browser's. The .eq('status','queued') guard keeps a second tapper
   *  from overwriting a colleague's 'sent' marker. */
  async markSentByHand(row: NotificationFailure): Promise<void> {
    if (!row.id) return
    try {
      await supabase
        .from('notification_log')
        .update({ status: 'sent', detail: `${row.detail ?? ''} — sent by hand` })
        .eq('id', row.id)
        .eq('status', 'queued')
    } catch { /**/ }
  },
}

export const dashboardStats = {
  async load(): Promise<{ data: DashboardStats; error: null }> {
    const start = Date.now()
    const light = await loadDashboardStatsLight()
    if (light) {
      health.record({ ts: Date.now(), type: 'read', table: 'dashboard_stats', success: true, duration: Date.now() - start, source: 'supabase' })
      return { data: light, error: null }
    }
    return { data: await loadDashboardStatsFallback(), error: null }
  },
}

// ── SIDEBAR COUNTS ────────────────────────────────────────────────
// The sidebar nav badges used to be hardcoded numbers (e.g. "1,284"
// policies, "892" clients) baked into the nav config — real counts,
// live, cheap COUNT-only queries.
export interface SidebarCounts {
  policies: number
  claimsPending: number
  clients: number
  remindersDue: number
  emailUnread: number
  ticketsOpen: number
  chatQueued: number
  /** Website manual payments (bank transfer / merchant pay) awaiting
   *  staff verification — the Payment Verifications badge. */
  pendingVerifications: number
}

export const sidebarCounts = {
  async load(): Promise<SidebarCounts> {
    const [pol, claimsRes, cli, rem, mail, tix, chatQ, verifs] = await Promise.all([
      supabase.from('policies').select('*', { count: 'exact', head: true }),
      supabase.from('claims').select('*', { count: 'exact', head: true }).in('status', ['pending', 'under_review']),
      supabase.from('clients').select('*', { count: 'exact', head: true }).eq('status', 'active'),
      supabase.from('reminders').select('*', { count: 'exact', head: true }).eq('sent', false),
      supabase.from('emails').select('*', { count: 'exact', head: true }).eq('folder', 'inbox').eq('read', false),
      supabase.from('tickets').select('*', { count: 'exact', head: true }).in('status', ['open', 'in_progress']),
      supabase.from('chat_sessions').select('*', { count: 'exact', head: true }).eq('status', 'queued'),
      supabase.from('checkout_sessions').select('*', { count: 'exact', head: true }).eq('status', 'pending_verification'),
    ])
    return {
      policies: pol.count ?? 0,
      claimsPending: claimsRes.count ?? 0,
      clients: cli.count ?? 0,
      remindersDue: rem.count ?? 0,
      emailUnread: mail.count ?? 0,
      ticketsOpen: tix.count ?? 0,
      chatQueued: chatQ.count ?? 0,
      pendingVerifications: verifs.count ?? 0,
    }
  },
}

// ── POLICY CARDS (member IDs + RFID) ──────────────────────────────

function toPolicyCard(r: Record<string, unknown>): PolicyCard {
  return {
    id: r.id as string,
    memberNumber: r.member_number as string,
    policyId: r.policy_id as string,
    policyNumber: r.policy_number as string,
    memberPosition: Number(r.member_position ?? 0),
    memberName: r.member_name as string,
    holderName: r.holder_name as string,
    clientId: (r.client_id as string) ?? '',
    rfidTag: (r.rfid_tag as string) ?? undefined,
    status: r.status as PolicyCard['status'],
    issuedAt: r.issued_at as string,
    issuedByName: (r.profiles as { name?: string } | null)?.name,
    expiresAt: (r.expires_at as string) ?? undefined,
    notes: (r.notes as string) ?? undefined,
    createdAt: r.created_at as string,
  }
}

const POLICY_CARD_SELECT = '*, profiles!issued_by(name)'

export const policyCards = {
  async list() {
    const { ok, data } = await sb('policy_cards', 'read',
      () => supabase.from('policy_cards').select(POLICY_CARD_SELECT).order('created_at', { ascending: false }),
      d => Array.isArray(d),
    )
    if (ok && data) return { data: (data as Record<string, unknown>[]).map(toPolicyCard), error: null }
    return { data: [] as PolicyCard[], error: null }
  },

  /** Issues (or re-issues) the card for one member. The member number is
   *  unique, so re-issuing updates the existing row rather than leaving two
   *  cards claiming to be the same person. */
  async issue(card: Omit<PolicyCard, 'id' | 'createdAt' | 'issuedAt' | 'issuedByName'> & { issuedBy?: string }) {
    const row = {
      member_number: card.memberNumber,
      policy_id: card.policyId,
      policy_number: card.policyNumber,
      member_position: card.memberPosition,
      member_name: card.memberName,
      holder_name: card.holderName,
      client_id: card.clientId || null,
      rfid_tag: card.rfidTag || null,
      status: card.status,
      issued_by: card.issuedBy || null,
      expires_at: card.expiresAt || null,
      notes: card.notes || null,
      issued_at: new Date().toISOString(),
    }
    const { data, error } = await supabase
      .from('policy_cards')
      .upsert(row, { onConflict: 'member_number' })
      .select(POLICY_CARD_SELECT)
      .single()
    if (error) {
      return {
        data: null,
        error: error.code === '23505'
          ? 'That RFID tag is already assigned to another member.'
          : error.message,
      }
    }
    return { data: toPolicyCard(data), error: null }
  },

  async update(id: string, updates: Partial<Pick<PolicyCard, 'rfidTag' | 'status' | 'expiresAt' | 'notes'>>) {
    const row: Record<string, unknown> = {}
    if (updates.rfidTag   !== undefined) row.rfid_tag  = updates.rfidTag || null
    if (updates.status    !== undefined) row.status    = updates.status
    if (updates.expiresAt !== undefined) row.expires_at = updates.expiresAt || null
    if (updates.notes     !== undefined) row.notes     = updates.notes || null
    const { data, error } = await supabase.from('policy_cards').update(row).eq('id', id).select(POLICY_CARD_SELECT).single()
    if (error) {
      return {
        data: null,
        error: error.code === '23505' ? 'That RFID tag is already assigned to another member.' : error.message,
      }
    }
    return { data: toPolicyCard(data), error: null }
  },

  /** What a card reader asks: this tag just presented itself, who is it and
   *  is the card still good? An unknown or non-active tag resolves to
   *  nothing usable, which is the whole point of keeping lost cards on file. */
  async findByRfid(tag: string) {
    const { data, error } = await supabase
      .from('policy_cards').select(POLICY_CARD_SELECT).eq('rfid_tag', tag.trim()).maybeSingle()
    if (error) return { data: null, error: error.message }
    return { data: data ? toPolicyCard(data) : null, error: null }
  },

  async findByMemberNumber(memberNumber: string) {
    const { data, error } = await supabase
      .from('policy_cards').select(POLICY_CARD_SELECT).eq('member_number', memberNumber.trim().toUpperCase()).maybeSingle()
    if (error) return { data: null, error: error.message }
    return { data: data ? toPolicyCard(data) : null, error: null }
  },
}

// ── GROUPS (corporate & group cover) ──────────────────────────────
// An organisation — company, church, union, club — that holds ONE policy
// covering its member roster. The organisation is the policyholder but is
// not itself a billed head; only roster members are (see premium.ts).
export const groups = {
  async get(id: string) {
    const { data, error } = await supabase.from('groups').select('*').eq('id', id).maybeSingle()
    if (error || !data) return { data: null, error: error?.message ?? 'Group not found.' }
    return { data: toGroup(data as Record<string, unknown>, 0), error: null }
  },

  // See policies.list() above — read-through cache of real rows only.
  async list() {
    // A missing groups table is a pending migration, not a connectivity
    // problem — returning an empty list keeps New Policy's scope picker
    // and the Groups page quiet instead of flashing an offline warning.
    if (!(await hasColumn('groups', 'id'))) return { data: [] as Group[], error: null }
    const { ok, data } = await sb('groups', 'read',
      () => supabase.from('groups').select('*').order('name'),
      d => Array.isArray(d),
    )
    if (ok && data) {
      // memberCount is the ACTIVE roster size — a filtered
      // group_members(count) embed would drop groups whose members are all
      // removed, so the count is tallied in a second query instead. A
      // failed tally is not worth failing the whole list over.
      const { data: memberRows } = await supabase
        .from('group_members').select('group_id').eq('status', 'active')
      const counts = new Map<string, number>()
      for (const m of (memberRows ?? []) as { group_id: string }[]) {
        counts.set(m.group_id, (counts.get(m.group_id) ?? 0) + 1)
      }
      const mapped = (data as Record<string, unknown>[]).map(r => toGroup(r, counts.get(r.id as string) ?? 0))
      cacheSet('groups', mapped)
      return { data: mapped, error: null }
    }
    const cached = cacheGet<Group>('groups')
    if (cached) { local('groups', 'read'); return { data: cached.data, error: null } }
    local('groups', 'read')
    return { data: [], error: 'Could not load groups — connect to the internet at least once to cache them for offline use.' }
  },

  async create(input: Omit<Group, 'id' | 'memberCount' | 'createdAt' | 'active'>) {
    const name = input.name?.trim()
    if (!name) return { data: null, error: 'A group name is required.' }
    const row = {
      name,
      group_type: input.groupType,
      registration_number: input.registrationNumber ?? null,
      custom_type: input.groupType === 'other' ? (input.customType?.trim() || null) : null,
      // expected_members deliberately not written — the roster is the
      // count; a stored "expected" figure was fiction.

      description: input.description?.trim() || null,
      org_phone: input.orgPhone ?? null,
      org_email: input.orgEmail ?? null,
      contact_name: input.contactName ?? null,
      contact_email: input.contactEmail ?? null,
      contact_phone: input.contactPhone ?? null,
      address: input.address ?? null,
      active: true,
    }
    // Someone who ran add_group_cover.sql before the extended columns
    // (custom_type, expected_members, description, org_*) existed has the
    // table but not the columns — insert what the schema supports rather
    // than erroring on unknown keys; the extended fields are null there
    // until the migration is re-run.
    if (!(await hasColumn('groups', 'custom_type'))) {
      delete (row as Record<string, unknown>).custom_type
      delete (row as Record<string, unknown>).description
      delete (row as Record<string, unknown>).org_phone
      delete (row as Record<string, unknown>).org_email
    }
    const { ok, data, error } = await sb('groups', 'write',
      () => supabase.from('groups').insert(row).select().single(),
    )
    if (ok && data) return { data: toGroup(data as Record<string, unknown>, 0), error: null }
    return writeFailed('groups', error)
  },

  async update(id: string, updates: Partial<Group>) {
    const row: Record<string, unknown> = {}
    if (updates.name !== undefined)                row.name                = updates.name
    if (updates.groupType !== undefined)           row.group_type          = updates.groupType
    if (updates.registrationNumber !== undefined)  row.registration_number = updates.registrationNumber ?? null
    // 'other' carries the registrant's own label; switching to a named
    // type must clear it or reports show a stale custom label.
    if (updates.groupType !== undefined && updates.groupType !== 'other') row.custom_type = null
    else if (updates.customType !== undefined)                          row.custom_type = updates.customType?.trim() || null
    if (updates.description !== undefined)         row.description        = updates.description ?? null
    if (updates.orgPhone !== undefined)            row.org_phone          = updates.orgPhone ?? null
    if (updates.orgEmail !== undefined)            row.org_email          = updates.orgEmail ?? null
    if (updates.contactName !== undefined)         row.contact_name        = updates.contactName ?? null
    if (updates.contactEmail !== undefined)        row.contact_email       = updates.contactEmail ?? null
    if (updates.contactPhone !== undefined)        row.contact_phone       = updates.contactPhone ?? null
    if (updates.address !== undefined)             row.address             = updates.address ?? null
    if (updates.active !== undefined)              row.active              = updates.active
    if (!(await hasColumn('groups', 'custom_type'))) {
      for (const k of ['custom_type', 'description', 'org_phone', 'org_email']) delete row[k]
    }
    const { ok, data, error } = await sb('groups', 'write',
      () => supabase.from('groups').update(row).eq('id', id).select().single(),
    )
    if (ok && data) return { data: toGroup(data as Record<string, unknown>), error: null }
    return writeFailed('groups', error)
  },

  /**
   * Hard delete — group_members cascade, so the roster goes with the
   * group. policies.group_id does NOT cascade (an issued group policy is a
   * financial record, same reasoning as claims/payments on clients.remove),
   * so deleting a group that still has policies fails 23503 and is
   * surfaced as a friendly message — deactivate it (active:false) instead.
   */
  async remove(id: string) {
    const { error } = await supabase.from('groups').delete().eq('id', id)
    if (error) {
      return { error: error.code === '23503' ? 'This group still has policies issued to it and cannot be deleted — mark it inactive instead.' : error.message }
    }
    return { error: null }
  },
}

/** A group policy's dependants array IS what gets invoiced per head —
 *  the billed roster. When the organisation's roster changes, every live
 *  group policy on it re-derives dependants from group_members, or the
 *  next invoice charges for people who left and misses people who
 *  joined. Best-effort per write: a failed sync is logged to health,
 *  never blocks the member operation (the roster write is the truth;
 *  the next roster change re-runs the sync). */
async function syncGroupRosterToPolicies(groupId: string) {
  const { data: mrows, error: mErr } = await supabase.from('group_members')
    .select('full_name, national_id, dob, phone, position, premium, cover_amount')
    .eq('group_id', groupId).eq('status', 'active')
  if (mErr) {
    health.record({ ts: Date.now(), type: 'read', table: 'group_members', success: false, duration: 0, source: 'supabase', detail: `roster sync read: ${mErr.message}` })
    return
  }
  const { data: prows, error: pErr } = await supabase.from('policies')
    .select('id, cover_scope, product_id, products!product_id(name, premium, cover_amount)')
    .eq('group_id', groupId)
    .in('cover_scope', ['corporate', 'group', 'team'])
    .in('status', ['active', 'waiting_period', 'lapsed', 'defaulted'])
  if (pErr || !prows) {
    health.record({ ts: Date.now(), type: 'read', table: 'policies', success: false, duration: 0, source: 'supabase', detail: `roster sync read: ${pErr?.message ?? 'no rows'}` })
    return
  }
  for (const p of prows as Array<{ id: string; cover_scope: string; product_id: string; products: { name?: string; premium?: number; cover_amount?: number } | null }>) {
    const prod = p.products
    const deps = (mrows ?? []).map(m => ({
      name: m.full_name,
      relationship: p.cover_scope === 'corporate' ? 'Employee'
        : p.cover_scope === 'team' ? ((m.position as string | null)?.trim() || 'Team Member')
        : 'Member',
      dob: m.dob ?? '', nationalId: m.national_id ?? '', phone: m.phone ?? undefined,
      productId: p.product_id, productName: prod?.name ?? '',
      // Negotiated per member — their agreed premium/sum assured, with
      // the product figure only as the fallback for rosters captured
      // before per-member pricing existed.
      premium: m.premium != null ? Number(m.premium) : (Number(prod?.premium) || 0),
      coverAmount: m.cover_amount != null ? Number(m.cover_amount) : (prod?.cover_amount ?? null),
    }))
    await sb('policies', 'write',
      () => supabase.from('policies').update({ dependants: deps }).eq('id', p.id),
    )
  }
}

// ── GROUP MEMBERS (the roster a group policy covers) ────────────────
export const groupMembers = {
  /** All members of a group — 'active' rows first (status sorts before
   *  'removed' alphabetically), then each band alphabetically by name.
   *  Removed members are returned too because historical claims may
   *  reference them; callers filter on status where only live members
   *  matter. */
  async list(groupId: string) {
    const { ok, data } = await sb('group_members', 'read',
      () => supabase.from('group_members').select('*').eq('group_id', groupId)
        .order('status').order('full_name'),
      d => Array.isArray(d),
    )
    if (ok && data) return { data: (data as Record<string, unknown>[]).map(toGroupMember), error: null }
    return { data: [] as GroupMember[], error: 'Could not load the group roster.' }
  },

  async add(input: Omit<GroupMember, 'id' | 'createdAt' | 'status'>) {
    const fullName = input.fullName?.trim()
    if (!fullName) return { data: null, error: 'A member name is required.' }
    const row = {
      group_id: input.groupId,
      full_name: fullName,
      national_id: input.nationalId ?? null,
      dob: input.dob || null,
      phone: input.phone ?? null,
      position: input.position ?? null,
      member_no: input.memberNo ?? null,
      premium: input.premium ?? null,
      cover_amount: input.coverAmount ?? null,
    }
    const { ok, data, error } = await sb('group_members', 'write',
      () => supabase.from('group_members').insert(row).select().single(),
    )
    if (ok && data) {
      void syncGroupRosterToPolicies(input.groupId)
      return { data: toGroupMember(data as Record<string, unknown>), error: null }
    }
    return writeFailed('group_members', error)
  },

  async update(id: string, updates: Partial<GroupMember>) {
    const row: Record<string, unknown> = {}
    if (updates.fullName !== undefined)   row.full_name   = updates.fullName
    if (updates.nationalId !== undefined) row.national_id = updates.nationalId ?? null
    if (updates.dob !== undefined)        row.dob         = updates.dob || null
    if (updates.phone !== undefined)      row.phone       = updates.phone ?? null
    if (updates.position !== undefined)   row.position    = updates.position ?? null
    if (updates.memberNo !== undefined)   row.member_no   = updates.memberNo ?? null
    if (updates.premium !== undefined)    row.premium     = updates.premium ?? null
    if (updates.coverAmount !== undefined) row.cover_amount = updates.coverAmount ?? null
    if (updates.status !== undefined)     row.status      = updates.status
    const { ok, data, error } = await sb('group_members', 'write',
      () => supabase.from('group_members').update(row).eq('id', id).select().single(),
    )
    if (ok && data) {
      // A name/position/status edit changes what the billed roster says —
      // re-sync the group's policies the same way an add/remove does.
      void syncGroupRosterToPolicies((data as Record<string, unknown>).group_id as string)
      return { data: toGroupMember(data as Record<string, unknown>), error: null }
    }
    return writeFailed('group_members', error)
  },

  /** Soft delete — sets status='removed' rather than deleting the row,
   *  because historical claims and certificates may still reference the
   *  member and a vanished roster entry would orphan them. */
  async remove(id: string) {
    const { data, error } = await supabase.from('group_members')
      .update({ status: 'removed' }).eq('id', id).select('group_id').single()
    if (!error && data?.group_id) void syncGroupRosterToPolicies(data.group_id as string)
    return { error: error?.message ?? null }
  },
}

// ── AGENT PROFILES (the agent file — commission intermediaries, not staff) ──
export const agentProfiles = {
  async list() {
    const { ok, data } = await sb('agent_profiles', 'read',
      () => supabase.from('agent_profiles').select('*'),
      d => Array.isArray(d),
    )
    if (!ok || !data) return { data: [] as AgentProfile[], error: 'Could not load agent profiles — run database/add_agent_profiles.sql if the table is missing.' }
    return { data: (data as Record<string, unknown>[]).map(toAgentProfile), error: null }
  },

  async get(profileId: string) {
    const { ok, data } = await sb('agent_profiles', 'read',
      () => supabase.from('agent_profiles').select('*').eq('profile_id', profileId).maybeSingle(),
    )
    return { data: ok && data ? toAgentProfile(data as Record<string, unknown>) : null, error: null }
  },

  async upsert(input: AgentProfile) {
    const row = {
      profile_id: input.profileId,
      national_id: input.nationalId ?? null,
      territory: input.territory ?? null,
      contract_start: input.contractStart || null,
      commission_pct: input.commissionPct ?? null,
      bank_name: input.bankName ?? null,
      bank_account: input.bankAccount ?? null,
      ecocash_number: input.ecocashNumber ?? null,
      notes: input.notes ?? null,
      updated_at: new Date().toISOString(),
    }
    const { ok, data, error } = await sb('agent_profiles', 'write',
      () => supabase.from('agent_profiles').upsert(row).select().single(),
    )
    if (ok && data) return { data: toAgentProfile(data as Record<string, unknown>), error: null }
    return writeFailed('agent_profiles', error)
  },

  /** An agent's book of business — clients registered and policies
   *  written under their referral, plus premium carried. Two light
   *  column-only reads, not the full joined policy list. */
  async bookStats(profileIds: string[]) {
    if (profileIds.length === 0) return { data: new Map<string, { clients: number; policies: number; premium: number }>(), error: null }
    const [clientsRes, policiesRes] = await Promise.all([
      supabase.from('clients').select('agent_id').in('agent_id', profileIds),
      supabase.from('policies').select('agent_id, premium').in('agent_id', profileIds),
    ])
    const stats = new Map<string, { clients: number; policies: number; premium: number }>()
    for (const c of (clientsRes.data ?? []) as { agent_id: string }[]) {
      const s = stats.get(c.agent_id) ?? { clients: 0, policies: 0, premium: 0 }
      s.clients++; stats.set(c.agent_id, s)
    }
    for (const p of (policiesRes.data ?? []) as { agent_id: string; premium: number }[]) {
      const s = stats.get(p.agent_id) ?? { clients: 0, policies: 0, premium: 0 }
      s.policies++; s.premium += Number(p.premium) || 0; stats.set(p.agent_id, s)
    }
    return { data: stats, error: null }
  },
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toAgentProfile(r: any): AgentProfile {
  return {
    profileId: r.profile_id, nationalId: r.national_id ?? undefined,
    territory: r.territory ?? undefined, contractStart: r.contract_start ?? undefined,
    commissionPct: r.commission_pct != null ? Number(r.commission_pct) : undefined,
    bankName: r.bank_name ?? undefined, bankAccount: r.bank_account ?? undefined,
    ecocashNumber: r.ecocash_number ?? undefined, notes: r.notes ?? undefined,
  }
}

// ── REALTIME ──────────────────────────────────────────────────────
export function subscribeToTable(table: string, callback: () => void) {
  const channel = supabase
    .channel(`rt:${table}`)
    .on('postgres_changes', { event: '*', schema: 'public', table }, callback)
    .subscribe()
  return () => { supabase.removeChannel(channel) }
}

// ── INVOICES ──────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toInvoice(r: any): Invoice {
  return {
    id:            r.id,
    invoiceNumber: r.invoice_number,
    policyId:      r.policy_id,
    policyNumber:  r.policies?.policy_number ?? '',
    clientId:      r.client_id,
    clientName:    r.clients?.name ?? '',
    groupId:       r.group_id ?? undefined,
    groupName:     r.groups?.name ?? undefined,
    period:        r.period,
    heads:         r.heads,
    amount:        r.amount,
    status:        r.status as InvoiceStatus,
    dueDate:       r.due_date ? date(r.due_date) : undefined,
    issuedAt:      r.issued_at,
    paidAt:        r.paid_at ?? undefined,
    createdBy:     r.created_by ?? undefined,
  }
}

const INVOICE_SELECT = `
  id, invoice_number, policy_id, client_id, group_id, period, heads, amount,
  status, due_date, issued_at, paid_at, created_by,
  policies!policy_id(policy_number),
  clients!client_id(name),
  groups!group_id(name)
`

export const invoices = {
  async list() {
    const { ok, data } = await sb('invoices', 'read',
      () => supabase.from('invoices').select(INVOICE_SELECT).order('issued_at', { ascending: false }),
      d => Array.isArray(d),
    )
    if (ok && data) return { data: (data as unknown[]).map(toInvoice), error: null }
    return { data: [] as Invoice[], error: 'Could not load invoices — the invoices table may not exist yet (run database/add_invoices.sql).' }
  },

  /**
   * Issues the invoice for one policy + billing period. The
   * (policy_id, period) unique index is the dedupe — a second call for the
   * same month returns the already-issued invoice, never a duplicate.
   * created:'false' means the invoice already existed and nothing new was
   * issued (callers use it to decide whether to notify).
   */
  async create(policy: Policy, period: string, createdBy: string): Promise<{ data: Invoice | null; error: string | null; created: boolean }> {
    const heads = billableHeadCount(policy, policy.productCategory)
    const amount = policyBillablePremium(policy, policy.productCategory)
    if (amount <= 0) return { data: null, error: 'Nothing to bill — the policy has no payable premium.', created: false }

    // Due on the last day of the invoiced month, same deadline the
    // reminder schedule already teaches clients to expect.
    const [yr, mo] = period.split('-').map(Number)
    const dueDate = new Date(yr, mo, 0).toISOString().split('T')[0]

    const { data: existing } = await supabase.from('invoices')
      .select(INVOICE_SELECT).eq('policy_id', policy.id).eq('period', period)
      .neq('status', 'cancelled').maybeSingle()
    if (existing) return { data: toInvoice(existing), error: null, created: false }

    // Invoice numbers run per period: INV-202610-001, -002, … The unique
    // index on invoice_number closes the tiny race if two staff generate
    // at the same instant — the loser retries with the next sequence.
    const { data: last } = await supabase.from('invoices')
      .select('invoice_number').like('invoice_number', `INV-${period.replace('-', '')}-%`)
      .order('invoice_number', { ascending: false }).limit(1)
    const lastSeq = Number(((last?.[0]?.invoice_number ?? '').match(/-(\d+)$/)?.[1]) ?? 0)

    for (let attempt = 1; attempt <= 3; attempt++) {
      const invoiceNumber = `INV-${period.replace('-', '')}-${String(lastSeq + attempt).padStart(3, '0')}`
      const { data, error } = await supabase.from('invoices').insert({
        invoice_number: invoiceNumber,
        policy_id: policy.id, client_id: policy.clientId, group_id: policy.groupId ?? null,
        period, heads, amount, due_date: dueDate, created_by: createdBy,
      }).select(INVOICE_SELECT).single()
      if (!error && data) return { data: toInvoice(data), error: null, created: true }
      if (error?.code === '23505') {
        if (attempt < 3) continue
        const { data: winner } = await supabase.from('invoices')
          .select(INVOICE_SELECT).eq('policy_id', policy.id).eq('period', period)
          .neq('status', 'cancelled').maybeSingle()
        return { data: winner ? toInvoice(winner) : null, error: winner ? null : 'Invoice number collision — try again.', created: false }
      }
      return { data: null, error: error?.message?.includes('invoices') && error.message.includes('not find')
        ? 'The invoices table does not exist yet — run database/add_invoices.sql in the Supabase SQL editor.'
        : error?.message ?? 'Failed to create invoice.', created: false }
    }
    return { data: null, error: 'Failed to create invoice.', created: false }
  },

  async markPaid(id: string) {
    const { data, error } = await supabase.from('invoices')
      .update({ status: 'paid', paid_at: new Date().toISOString() }).eq('id', id)
      .select(INVOICE_SELECT).single()
    if (error || !data) return { data: null, error: error?.message ?? 'Failed to mark invoice paid.' }
    return { data: toInvoice(data), error: null }
  },

  async cancel(id: string) {
    const { error } = await supabase.from('invoices').update({ status: 'cancelled' }).eq('id', id)
    return { error: error?.message ?? null }
  },
}

// ── MARKETING MODULE ────────────────────────────────────────────────

function toMarketingContact(r: Record<string, unknown>): MarketingContact {
  return {
    id: r.id as string,
    name: r.name as string,
    phone: r.phone as string,
    normalizedPhone: r.normalized_phone as string,
    email: (r.email as string | null) ?? undefined,
    insuranceInterest: (r.insurance_interest as string | null) ?? undefined,
    source: (r.source as string | null) ?? undefined,
    marketingPermission: r.marketing_permission as boolean,
    optedOut: r.opted_out as boolean,
    optedOutAt: (r.opted_out_at as string | null) ?? undefined,
    optOutReason: (r.opt_out_reason as string | null) ?? undefined,
    optOutChannel: (r.opt_out_channel as 'sms' | 'email' | null) ?? undefined,
    leadId: (r.lead_id as string | null) ?? undefined,
    notes: (r.notes as string | null) ?? undefined,
    createdBy: (r.created_by as string | null) ?? undefined,
    createdByName: ((r.creator as { name?: string } | null | undefined)?.name as string | null) ?? undefined,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  }
}

function toMarketingTemplate(r: Record<string, unknown>): MarketingTemplate {
  return {
    id: r.id as string,
    name: r.name as string,
    title: (r.title as string | null) ?? undefined,
    description: r.description as string,
    category: (r.category as string | null) ?? undefined,
    active: r.active as boolean,
    createdBy: (r.created_by as string | null) ?? undefined,
    createdByName: ((r.creator as { name?: string } | null | undefined)?.name as string | null) ?? undefined,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  }
}

function toMarketingCampaign(r: Record<string, unknown>): MarketingCampaign {
  return {
    id: r.id as string,
    name: r.name as string,
    title: (r.title as string | null) ?? undefined,
    description: r.description as string,
    channel: r.channel as MarketingCampaign['channel'],
    recipientCount: r.recipient_count as number,
    smsSegmentCount: r.sms_segment_count as number,
    estimatedSmsCost: r.estimated_sms_cost != null ? Number(r.estimated_sms_cost) : undefined,
    status: r.status as MarketingCampaign['status'],
    scheduledFor: (r.scheduled_for as string | null) ?? undefined,
    sentAt: (r.sent_at as string | null) ?? undefined,
    createdBy: (r.created_by as string | null) ?? undefined,
    createdByName: ((r.creator as { name?: string } | null | undefined)?.name as string | null) ?? undefined,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  }
}

function toCampaignRecipient(r: Record<string, unknown>): CampaignRecipient {
  return {
    id: r.id as string,
    campaignId: r.campaign_id as string,
    contactId: r.contact_id as string,
    contactName: ((r.contacts as { name?: string } | null | undefined)?.name as string | null) ?? undefined,
    phone: (r.phone as string | null) ?? undefined,
    email: (r.email as string | null) ?? undefined,
    smsStatus: (r.sms_status as CampaignRecipient['smsStatus'] | null) ?? undefined,
    emailStatus: (r.email_status as CampaignRecipient['emailStatus'] | null) ?? undefined,
    smsMessageId: (r.sms_message_id as string | null) ?? undefined,
    emailMessageId: (r.email_message_id as string | null) ?? undefined,
    errorMessage: (r.error_message as string | null) ?? undefined,
    sentAt: (r.sent_at as string | null) ?? undefined,
    deliveredAt: (r.delivered_at as string | null) ?? undefined,
    createdAt: r.created_at as string,
  }
}

/** Zimbabwe MSISDN normalization for marketing contacts */
function normalizeMsisdn(raw: string): string {
  let digits = raw.replace(/\D/g, '')
  if (digits.startsWith('0')) digits = '263' + digits.slice(1)
  else if (digits.startsWith('2630')) digits = '263' + digits.slice(4)
  else if (!digits.startsWith('263')) digits = '263' + digits
  return digits
}

const CONTACT_SELECT = `
  id, name, phone, normalized_phone, email, insurance_interest, source,
  marketing_permission, opted_out, opted_out_at, opt_out_reason, opt_out_channel,
  lead_id, notes, created_by, created_at, updated_at,
  creator:profiles!created_by(id, name)
`

const TEMPLATE_SELECT = `
  id, name, title, description, category, active, created_by, created_at, updated_at,
  creator:profiles!created_by(id, name)
`

const CAMPAIGN_SELECT = `
  id, name, title, description, channel, recipient_count, sms_segment_count,
  estimated_sms_cost, status, scheduled_for, sent_at, created_by, created_at, updated_at,
  creator:profiles!created_by(id, name)
`

const RECIPIENT_SELECT = `
  id, campaign_id, contact_id, phone, email, sms_status, email_status,
  sms_message_id, email_message_id, error_message, sent_at, delivered_at, created_at,
  contacts!contact_id(name)
`

export const marketingContacts = {
  async list() {
    const { ok, data, error } = await sb('marketing_contacts', 'read',
      () => supabase.from('marketing_contacts').select(CONTACT_SELECT).order('created_at', { ascending: false }),
      d => Array.isArray(d),
    )
    if (ok && data) return { data: (data as unknown[]).map((r: unknown) => toMarketingContact(r as Record<string, unknown>)), error: null }
    return { data: [], error }
  },

  async get(id: string) {
    const { ok, data, error } = await sb('marketing_contacts', 'read',
      () => supabase.from('marketing_contacts').select(CONTACT_SELECT).eq('id', id).single(),
    )
    if (ok && data) return { data: toMarketingContact(data as Record<string, unknown>), error: null }
    return { data: null, error: error ?? 'Contact not found.' }
  },

  async create(contact: Omit<MarketingContact, 'id' | 'createdByName' | 'createdAt' | 'updatedAt' | 'normalizedPhone'>) {
    const normalized = normalizeMsisdn(contact.phone)
    const { data: { session } } = await supabase.auth.getSession()
    const row = {
      name: contact.name,
      phone: contact.phone,
      normalized_phone: normalized,
      email: contact.email ?? null,
      insurance_interest: contact.insuranceInterest ?? null,
      source: contact.source ?? null,
      marketing_permission: contact.marketingPermission,
      opted_out: contact.optedOut,
      opted_out_at: contact.optedOutAt ?? null,
      opt_out_reason: contact.optOutReason ?? null,
      opt_out_channel: contact.optOutChannel ?? null,
      lead_id: contact.leadId ?? null,
      notes: contact.notes ?? null,
      created_by: session?.user?.id ?? null,
    }
    const { data, error } = await supabase.from('marketing_contacts').insert(row).select(CONTACT_SELECT).single()
    if (!error && data) return { data: toMarketingContact(data), error: null }
    if (error?.code === '23505') return { data: null, error: 'A contact with this phone number already exists.' }
    return writeFailed('marketing_contacts', error?.message ?? null)
  },

  async update(id: string, updates: Partial<MarketingContact>) {
    const row: Record<string, unknown> = {}
    if (updates.name) row.name = updates.name
    if (updates.phone) { row.phone = updates.phone; row.normalized_phone = normalizeMsisdn(updates.phone) }
    if (updates.email !== undefined) row.email = updates.email || null
    if (updates.insuranceInterest !== undefined) row.insurance_interest = updates.insuranceInterest || null
    if (updates.source !== undefined) row.source = updates.source || null
    if (updates.marketingPermission !== undefined) row.marketing_permission = updates.marketingPermission
    if (updates.optedOut !== undefined) row.opted_out = updates.optedOut
    if (updates.optedOutAt !== undefined) row.opted_out_at = updates.optedOutAt || null
    if (updates.optOutReason !== undefined) row.opt_out_reason = updates.optOutReason || null
    if (updates.optOutChannel !== undefined) row.opt_out_channel = updates.optOutChannel || null
    if (updates.leadId !== undefined) row.lead_id = updates.leadId || null
    if (updates.notes !== undefined) row.notes = updates.notes || null

    const { data, error } = await supabase.from('marketing_contacts').update(row).eq('id', id).select(CONTACT_SELECT).single()
    if (!error && data) return { data: toMarketingContact(data), error: null }
    if (error?.code === '23505') return { data: null, error: 'A contact with this phone number already exists.' }
    return writeFailed('marketing_contacts', error?.message ?? null)
  },

  async delete(id: string) {
    const { error } = await supabase.from('marketing_contacts').delete().eq('id', id)
    return { error: error?.message ?? null }
  },

  async importCSV(contacts: Array<{ name: string; phone: string; email?: string; insuranceInterest?: string; source?: string }>) {
    const { data: { session } } = await supabase.auth.getSession()
    const results = { imported: 0, duplicates: 0, errors: 0 }
    const errors: string[] = []

    for (const contact of contacts) {
      const normalized = normalizeMsisdn(contact.phone)
      const row = {
        name: contact.name,
        phone: contact.phone,
        normalized_phone: normalized,
        email: contact.email || null,
        insurance_interest: contact.insuranceInterest || null,
        source: contact.source || null,
        marketing_permission: true,
        opted_out: false,
        created_by: session?.user?.id ?? null,
      }

      const { error } = await supabase.from('marketing_contacts').insert(row)
      if (!error) {
        results.imported++
      } else if (error.code === '23505') {
        results.duplicates++
      } else {
        results.errors++
        errors.push(`${contact.name}: ${error.message}`)
      }
    }

    return { results, errors }
  },
}

export const marketingTemplates = {
  async list() {
    const { ok, data, error } = await sb('marketing_templates', 'read',
      () => supabase.from('marketing_templates').select(TEMPLATE_SELECT).order('created_at', { ascending: false }),
      d => Array.isArray(d),
    )
    if (ok && data) return { data: (data as unknown[]).map((r: unknown) => toMarketingTemplate(r as Record<string, unknown>)), error: null }
    return { data: [], error }
  },

  async get(id: string) {
    const { ok, data, error } = await sb('marketing_templates', 'read',
      () => supabase.from('marketing_templates').select(TEMPLATE_SELECT).eq('id', id).single(),
    )
    if (ok && data) return { data: toMarketingTemplate(data as Record<string, unknown>), error: null }
    return { data: null, error: error ?? 'Template not found.' }
  },

  async create(template: Omit<MarketingTemplate, 'id' | 'createdByName' | 'createdAt' | 'updatedAt'>) {
    const { data: { session } } = await supabase.auth.getSession()
    const row = {
      name: template.name,
      title: template.title || null,
      description: template.description,
      category: template.category || null,
      active: template.active,
      created_by: session?.user?.id ?? null,
    }
    const { data, error } = await supabase.from('marketing_templates').insert(row).select(TEMPLATE_SELECT).single()
    if (!error && data) return { data: toMarketingTemplate(data), error: null }
    return writeFailed('marketing_templates', error?.message ?? null)
  },

  async update(id: string, updates: Partial<MarketingTemplate>) {
    const row: Record<string, unknown> = {}
    if (updates.name) row.name = updates.name
    if (updates.title !== undefined) row.title = updates.title || null
    if (updates.description) row.description = updates.description
    if (updates.category !== undefined) row.category = updates.category || null
    if (updates.active !== undefined) row.active = updates.active

    const { data, error } = await supabase.from('marketing_templates').update(row).eq('id', id).select(TEMPLATE_SELECT).single()
    if (!error && data) return { data: toMarketingTemplate(data), error: null }
    return writeFailed('marketing_templates', error?.message ?? null)
  },

  async delete(id: string) {
    const { error } = await supabase.from('marketing_templates').delete().eq('id', id)
    return { error: error?.message ?? null }
  },
}

export const marketingCampaigns = {
  async list() {
    const { ok, data, error } = await sb('marketing_campaigns', 'read',
      () => supabase.from('marketing_campaigns').select(CAMPAIGN_SELECT).order('created_at', { ascending: false }),
      d => Array.isArray(d),
    )
    if (ok && data) return { data: (data as unknown[]).map((r: unknown) => toMarketingCampaign(r as Record<string, unknown>)), error: null }
    return { data: [], error }
  },

  async get(id: string) {
    const { ok, data, error } = await sb('marketing_campaigns', 'read',
      () => supabase.from('marketing_campaigns').select(CAMPAIGN_SELECT).eq('id', id).single(),
    )
    if (ok && data) return { data: toMarketingCampaign(data as Record<string, unknown>), error: null }
    return { data: null, error: error ?? 'Campaign not found.' }
  },

  async create(campaign: Omit<MarketingCampaign, 'id' | 'createdByName' | 'createdAt' | 'updatedAt'>) {
    const { data: { session } } = await supabase.auth.getSession()
    const row = {
      name: campaign.name,
      title: campaign.title || null,
      description: campaign.description,
      channel: campaign.channel,
      recipient_count: campaign.recipientCount,
      sms_segment_count: campaign.smsSegmentCount,
      estimated_sms_cost: campaign.estimatedSmsCost || null,
      status: campaign.status,
      scheduled_for: campaign.scheduledFor || null,
      created_by: session?.user?.id ?? null,
    }
    const { data, error } = await supabase.from('marketing_campaigns').insert(row).select(CAMPAIGN_SELECT).single()
    if (!error && data) return { data: toMarketingCampaign(data), error: null }
    return writeFailed('marketing_campaigns', error?.message ?? null)
  },

  async update(id: string, updates: Partial<MarketingCampaign>) {
    const row: Record<string, unknown> = {}
    if (updates.name) row.name = updates.name
    if (updates.title !== undefined) row.title = updates.title || null
    if (updates.description) row.description = updates.description
    if (updates.channel) row.channel = updates.channel
    if (updates.recipientCount !== undefined) row.recipient_count = updates.recipientCount
    if (updates.smsSegmentCount !== undefined) row.sms_segment_count = updates.smsSegmentCount
    if (updates.estimatedSmsCost !== undefined) row.estimated_sms_cost = updates.estimatedSmsCost || null
    if (updates.status) row.status = updates.status
    if (updates.scheduledFor !== undefined) row.scheduled_for = updates.scheduledFor || null
    if (updates.sentAt !== undefined) row.sent_at = updates.sentAt || null

    const { data, error } = await supabase.from('marketing_campaigns').update(row).eq('id', id).select(CAMPAIGN_SELECT).single()
    if (!error && data) return { data: toMarketingCampaign(data), error: null }
    return writeFailed('marketing_campaigns', error?.message ?? null)
  },

  async delete(id: string) {
    const { error } = await supabase.from('marketing_campaigns').delete().eq('id', id)
    return { error: error?.message ?? null }
  },

  async getRecipients(campaignId: string) {
    const { ok, data, error } = await sb('marketing_campaign_recipients', 'read',
      () => supabase.from('marketing_campaign_recipients').select(RECIPIENT_SELECT).eq('campaign_id', campaignId),
      d => Array.isArray(d),
    )
    if (ok && data) return { data: (data as unknown[]).map((r: unknown) => toCampaignRecipient(r as Record<string, unknown>)), error: null }
    return { data: [], error }
  },
}

export const campaignRecipients = {
  async create(recipients: Array<{ campaignId: string; contactId: string; phone?: string; email?: string }>) {
    const rows = recipients.map(r => ({
      campaign_id: r.campaignId,
      contact_id: r.contactId,
      phone: r.phone || null,
      email: r.email || null,
      sms_status: 'pending',
      email_status: 'pending',
    }))
    const { data, error } = await supabase.from('marketing_campaign_recipients').insert(rows).select()
    if (!error && data) return { data: (data as unknown[]).map((r: unknown) => toCampaignRecipient(r as Record<string, unknown>)), error: null }
    return { data: [], error: error?.message ?? null }
  },

  async updateStatus(id: string, updates: { smsStatus?: CampaignRecipient['smsStatus']; emailStatus?: CampaignRecipient['emailStatus']; messageId?: string; errorMessage?: string; sentAt?: string; deliveredAt?: string }) {
    const row: Record<string, unknown> = {}
    if (updates.smsStatus) row.sms_status = updates.smsStatus
    if (updates.emailStatus) row.email_status = updates.emailStatus
    if (updates.messageId && updates.smsStatus) row.sms_message_id = updates.messageId
    if (updates.messageId && updates.emailStatus) row.email_message_id = updates.messageId
    if (updates.errorMessage) row.error_message = updates.errorMessage
    if (updates.sentAt) row.sent_at = updates.sentAt
    if (updates.deliveredAt) row.delivered_at = updates.deliveredAt

    const { data, error } = await supabase.from('marketing_campaign_recipients').update(row).eq('id', id).select(RECIPIENT_SELECT).single()
    if (!error && data) return { data: toCampaignRecipient(data), error: null }
    return { data: null, error: error?.message ?? null }
  },
}

// ── EXPORT ────────────────────────────────────────────────────────
export const db = {
  policies, clients, products, claims, payments,
  tickets, emails, leads, staff, fraudCases, reminders, cautionFlags, settings, loginAttempts, developerApi,
  exchangeRates,
  customRoles, claimAssessments, policyAssessments, photoHashes, cropTypes, fraudSignalRules, heroSlides,
  policyCards, groups, groupMembers, agentProfiles,
  dashboardStats, sidebarCounts, notificationLog, invoices,
  marketingContacts, marketingTemplates, marketingCampaigns, campaignRecipients,
  subscribeToTable,
}
