import { supabase } from './supabase'
import { health } from './health'
import { localStore } from './localStore'
import type {
  AppUser, Client, Product, Policy, Claim, Payment,
  Ticket, EmailMessage, Lead, FraudCase, Reminder, CautionFlag,
  PolicyStatus, ClaimStatus, PaymentStatus, PaymentMethod,
  TicketStatus, TicketPriority, LeadStatus, FraudCaseStatus, CustomRole,
} from '../types'

// ── helpers ───────────────────────────────────────────────────────
function date(v: string | null | undefined): string { return v?.split('T')[0] ?? '' }
function uid() { return `loc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }

/** Try a Supabase query; record timing/health; return {ok, data}. */
async function sb<T>(
  table: string,
  type: 'read' | 'write' | 'delete',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: () => PromiseLike<{ data: any; error: any }>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  isListOk: (d: any) => boolean = (d) => d !== null,
): Promise<{ ok: boolean; data: T | null }> {
  const start = Date.now()
  try {
    const { data, error } = await query()
    const duration = Date.now() - start
    const ok = !error && isListOk(data)
    health.record({ ts: Date.now(), type, table, success: ok, duration, source: 'supabase',
      detail: error ? String(error) : undefined })
    return { ok, data: ok ? data : null }
  } catch (e) {
    const duration = Date.now() - start
    health.record({ ts: Date.now(), type, table, success: false, duration, source: 'supabase',
      detail: String(e) })
    return { ok: false, data: null }
  }
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
    address:     (r.address as string) ?? '',
    occupation:  r.occupation as string | undefined,
    insurer:     (r.insurer as Client['insurer']) ?? undefined,
    createdAt:   date(r.created_at as string),
    policyCount: (r.policy_count as number) ?? 0,
    status:      r.status as Client['status'],
  }
}

function toProduct(r: Record<string, unknown>): Product {
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
    commissionPct:     r.commission_pct as number,
    active:            r.active as boolean,
    features:          (r.features as string[]) ?? [],
    description:       (r.description as string) ?? '',
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
    premium:         r.premium,
    coverAmount:     r.cover_amount,
    startDate:       date(r.start_date),
    endDate:         date(r.end_date),
    status:          r.status as PolicyStatus,
    dependants:      r.dependants ?? [],
    paymentMethod:   r.payment_method,
    insurer:         r.insurer ?? undefined,
    growerNumber:    r.grower_number ?? undefined,
    agentId:         r.profiles?.id ?? r.agent_id,
    agentName:       r.profiles?.name,
    createdAt:       date(r.created_at),
    nextPaymentDate: r.next_payment_date ? date(r.next_payment_date) : undefined,
    lastPaymentDate: r.last_payment_date ? date(r.last_payment_date) : undefined,
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
    splitPayments: r.split_payments ?? undefined,
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
const POLICY_SELECT = `
  id, policy_number, client_id, product_id, premium, cover_amount,
  start_date, end_date, status, dependants, payment_method, insurer,
  grower_number, agent_id, next_payment_date, last_payment_date, created_at,
  clients!client_id(id, name),
  products!product_id(id, name),
  profiles!agent_id(id, name)
`
const CLAIM_SELECT = `
  id, claim_number, policy_id, claim_type, amount, status,
  stage, assessment_notes, agent_id,
  date_of_event, date_submitted, description, fraud_score,
  assigned_to, documents, notes, resolved_at, created_at,
  policies!policy_id(
    id, policy_number,
    clients!client_id(id, name),
    products!product_id(name)
  ),
  assignee:profiles!assigned_to(id, name),
  agent:profiles!agent_id(id, name)
`
const PAYMENT_SELECT = `
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
    claim_number,
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

// ── POLICIES ──────────────────────────────────────────────────────
export const policies = {
  async list() {
    const { ok, data } = await sb('policies', 'read',
      () => supabase.from('policies').select(POLICY_SELECT).order('created_at', { ascending: false }),
      d => Array.isArray(d),
    )
    if (ok && data) return { data: (data as unknown[]).map(toPolicy), error: null }
    local('policies', 'read')
    return { data: localStore.policies.list(), error: null }
  },

  async get(id: string) {
    const { ok, data } = await sb('policies', 'read',
      () => supabase.from('policies').select(POLICY_SELECT).eq('id', id).single(),
    )
    if (ok && data) return { data: toPolicy(data), error: null }
    local('policies', 'read')
    return { data: localStore.policies.list().find(p => p.id === id) ?? null, error: null }
  },

  async create(policy: Omit<Policy, 'id'>) {
    const row = {
      policy_number: policy.policyNumber, client_id: policy.clientId,
      product_id: policy.productId, premium: policy.premium,
      cover_amount: policy.coverAmount, start_date: policy.startDate,
      end_date: policy.endDate, status: policy.status,
      dependants: policy.dependants, payment_method: policy.paymentMethod,
      insurer: policy.insurer ?? null, grower_number: policy.growerNumber ?? null,
      agent_id: policy.agentId ?? null, next_payment_date: policy.nextPaymentDate ?? null,
    }
    const { ok, data } = await sb('policies', 'write',
      () => supabase.from('policies').insert(row).select(POLICY_SELECT).single(),
    )
    if (ok && data) return { data: toPolicy(data), error: null }
    local('policies', 'write')
    const item = { ...policy, id: uid(), createdAt: new Date().toISOString().split('T')[0] } as Policy
    return { data: localStore.policies.create(item), error: null }
  },

  async update(id: string, updates: Partial<Policy>) {
    const row: Record<string, unknown> = {}
    if (updates.status)                              row.status             = updates.status
    if (updates.paymentMethod)                       row.payment_method     = updates.paymentMethod
    if (updates.insurer !== undefined)               row.insurer            = updates.insurer ?? null
    if (updates.growerNumber !== undefined)          row.grower_number      = updates.growerNumber ?? null
    if (updates.nextPaymentDate !== undefined)        row.next_payment_date  = updates.nextPaymentDate ?? null
    if (updates.dependants)                          row.dependants         = updates.dependants
    if (updates.premium !== undefined)               row.premium            = updates.premium
    if (updates.coverAmount !== undefined)           row.cover_amount       = updates.coverAmount
    if (updates.endDate !== undefined)               row.end_date           = updates.endDate
    if (updates.agentId !== undefined)               row.agent_id           = updates.agentId ?? null
    const { ok, data } = await sb('policies', 'write',
      () => supabase.from('policies').update(row).eq('id', id).select(POLICY_SELECT).single(),
    )
    if (ok && data) return { data: toPolicy(data), error: null }
    local('policies', 'write')
    return { data: localStore.policies.update(id, updates), error: null }
  },

  /** RLS (policies_delete_admin) restricts this to admin/super_admin already;
   *  hasPermission('policies.delete') additionally gates the button itself
   *  so a custom role can hide it from a given admin/staff member too. */
  async remove(id: string) {
    const { error } = await supabase.from('policies').delete().eq('id', id)
    if (error) return { error: error.code === '23503' ? 'This policy has related claims or payments and cannot be deleted.' : error.message }
    return { error: null }
  },
}

// ── CLIENTS ───────────────────────────────────────────────────────
export const clients = {
  async list() {
    const { ok, data } = await sb('clients', 'read',
      () => supabase.from('clients').select('*, policies(count)').order('created_at', { ascending: false }),
      d => Array.isArray(d),
    )
    if (ok && data) return {
      data: (data as Record<string, unknown>[]).map(r =>
        toClient({ ...r, policy_count: (r.policies as {count:number}[])?.[0]?.count ?? 0 })
      ),
      error: null,
    }
    local('clients', 'read')
    return { data: localStore.clients.list(), error: null }
  },

  async get(id: string) {
    const { ok, data } = await sb('clients', 'read',
      () => supabase.from('clients').select('*, policies(count)').eq('id', id).single(),
    )
    if (ok && data) return {
      data: toClient({ ...(data as Record<string, unknown>), policy_count: ((data as Record<string, unknown>).policies as {count:number}[])?.[0]?.count ?? 0 }),
      error: null,
    }
    local('clients', 'read')
    return { data: localStore.clients.list().find(c => c.id === id) ?? null, error: null }
  },

  async create(client: Omit<Client, 'id' | 'policyCount'>) {
    const row = {
      name: client.name, email: client.email, phone: client.phone,
      national_id: client.nationalId, dob: client.dob || null,
      address: client.address, occupation: client.occupation ?? null,
      insurer: client.insurer ?? null, status: client.status,
    }
    const { ok, data } = await sb('clients', 'write',
      () => supabase.from('clients').insert(row).select().single(),
    )
    if (ok && data) return { data: toClient({ ...(data as Record<string,unknown>), policy_count: 0 }), error: null }
    local('clients', 'write')
    const item = { ...client, id: uid(), policyCount: 0, createdAt: new Date().toISOString().split('T')[0] } as Client
    return { data: localStore.clients.create(item), error: null }
  },

  async update(id: string, updates: Partial<Client>) {
    const row: Record<string, unknown> = {}
    if (updates.name       !== undefined) row.name       = updates.name
    if (updates.email      !== undefined) row.email      = updates.email
    if (updates.phone      !== undefined) row.phone      = updates.phone
    if (updates.address    !== undefined) row.address    = updates.address
    if (updates.occupation !== undefined) row.occupation = updates.occupation
    if (updates.insurer    !== undefined) row.insurer    = updates.insurer ?? null
    if (updates.status     !== undefined) row.status     = updates.status
    const { ok, data } = await sb('clients', 'write',
      () => supabase.from('clients').update(row).eq('id', id).select().single(),
    )
    if (ok && data) return { data: toClient({ ...(data as Record<string,unknown>), policy_count: 0 }), error: null }
    local('clients', 'write')
    return { data: localStore.clients.update(id, updates), error: null }
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
  async list() {
    const { ok, data } = await sb('products', 'read',
      () => supabase.from('products').select('*').order('name'),
      d => Array.isArray(d),
    )
    if (ok && data) return { data: (data as Record<string,unknown>[]).map(toProduct), error: null }
    local('products', 'read')
    return { data: localStore.products.list(), error: null }
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
    }
    const start = Date.now()
    const { data, error } = await supabase.from('products').insert(row).select().single()
    health.record({ ts: Date.now(), type: 'write', table: 'products', success: !error, duration: Date.now() - start, source: 'supabase', detail: error ? String(error.message) : undefined })
    if (error) {
      return { data: null, error: error.code === '23505' ? 'That product code is already in use — please choose a different one.' : error.message }
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
    const start = Date.now()
    const { data, error } = await supabase.from('products').update(row).eq('id', id).select().single()
    health.record({ ts: Date.now(), type: 'write', table: 'products', success: !error, duration: Date.now() - start, source: 'supabase', detail: error ? String(error.message) : undefined })
    if (error) {
      return { data: null, error: error.code === '23505' ? 'That product code is already in use — please choose a different one.' : error.message }
    }
    return { data: toProduct(data as Record<string,unknown>), error: null }
  },
}

// ── CLAIMS ────────────────────────────────────────────────────────
export const claims = {
  async list() {
    const { ok, data } = await sb('claims', 'read',
      () => supabase.from('claims').select(CLAIM_SELECT).order('created_at', { ascending: false }),
      d => Array.isArray(d),
    )
    if (ok && data) return { data: (data as unknown[]).map(toClaim), error: null }
    local('claims', 'read')
    return { data: localStore.claims.list(), error: null }
  },

  async create(claim: Omit<Claim, 'id' | 'claimNumber' | 'policyNumber' | 'clientId' | 'clientName' | 'productName'>) {
    const claimNumber = `CLM${new Date().getFullYear()}${String(Date.now()).slice(-4)}`
    const row = {
      claim_number: claimNumber, policy_id: claim.policyId,
      claim_type: claim.claimType, amount: claim.amount, status: claim.status,
      stage: claim.stage ?? 'intake', agent_id: claim.agentId ?? null,
      date_of_event: claim.dateOfEvent, date_submitted: claim.dateSubmitted,
      description: claim.description, fraud_score: claim.fraudScore, documents: claim.documents,
    }
    const { ok, data } = await sb('claims', 'write',
      () => supabase.from('claims').insert(row).select(CLAIM_SELECT).single(),
    )
    if (ok && data) return { data: toClaim(data), error: null }
    local('claims', 'write')
    const pol = localStore.policies.list().find(p => p.id === claim.policyId)
    const item: Claim = {
      ...claim, id: uid(), claimNumber,
      policyNumber: pol?.policyNumber ?? '', clientId: pol?.clientId ?? '',
      clientName: pol?.clientName ?? '', productName: pol?.productName ?? '',
    }
    return { data: localStore.claims.create(item), error: null }
  },

  async update(id: string, updates: Partial<Claim>) {
    const row: Record<string, unknown> = {}
    if (updates.status     !== undefined) row.status      = updates.status
    if (updates.stage      !== undefined) row.stage       = updates.stage
    if (updates.assignedTo !== undefined) row.assigned_to = updates.assignedTo ?? null
    if (updates.assessmentNotes !== undefined) row.assessment_notes = updates.assessmentNotes ?? null
    if (updates.notes      !== undefined) row.notes       = updates.notes ?? null
    if (updates.resolvedAt !== undefined) row.resolved_at = updates.resolvedAt ?? null
    const { ok, data } = await sb('claims', 'write',
      () => supabase.from('claims').update(row).eq('id', id).select(CLAIM_SELECT).single(),
    )
    if (ok && data) return { data: toClaim(data), error: null }
    local('claims', 'write')
    return { data: localStore.claims.update(id, updates), error: null }
  },
}

/**
 * Advances a policy's payment cursor and status whenever a completed
 * payment lands against it — called from every completion path (create or
 * update-to-completed) so the lifecycle stays consistent everywhere rather
 * than being reimplemented per call site. Agriculture goes straight to
 * 'active' on its first payment (no waiting period); a lapsed policy that
 * gets caught up is reinstated to 'waiting_period', not straight to
 * 'active', per the 2026-08 access review. Fire-and-forget — a failure here
 * shouldn't roll back an already-recorded payment.
 */
async function applyCompletedPaymentToPolicy(policyId: string, amountPaid: number): Promise<void> {
  const [{ data: policy }, { data: prods }] = await Promise.all([policies.get(policyId), products.list()])
  if (!policy) return
  const category = prods?.find(p => p.id === policy.productId)?.category ?? ''
  const cycleMonths = category === 'agriculture' ? 12 : 1
  const periodsPaid = Math.max(1, Math.round(amountPaid / (policy.premium || amountPaid)))
  const monthsToAdvance = cycleMonths * periodsPaid

  const today = new Date()
  const base = policy.nextPaymentDate && new Date(policy.nextPaymentDate) > today ? new Date(policy.nextPaymentDate) : today
  const next = new Date(base)
  next.setMonth(next.getMonth() + monthsToAdvance)

  let status = policy.status
  if (policy.status === 'lapsed') status = 'waiting_period'
  else if (category === 'agriculture' && policy.status === 'waiting_period') status = 'active'

  await policies.update(policyId, {
    status,
    lastPaymentDate: today.toISOString().split('T')[0],
    nextPaymentDate: next.toISOString().split('T')[0],
  })
}

// ── PAYMENTS ──────────────────────────────────────────────────────
export const payments = {
  async list() {
    const { ok, data } = await sb('payments', 'read',
      () => supabase.from('payments').select(PAYMENT_SELECT).order('payment_date', { ascending: false }),
      d => Array.isArray(d),
    )
    if (ok && data) return { data: (data as unknown[]).map(toPayment), error: null }
    local('payments', 'read')
    return { data: localStore.payments.list(), error: null }
  },

  async create(payment: Omit<Payment, 'id'>) {
    const row = {
      reference: payment.reference, policy_id: payment.policyId,
      amount: payment.amount, method: payment.method, status: payment.status,
      payment_date: payment.date, split_payments: payment.splitPayments ?? null,
    }
    const { ok, data } = await sb('payments', 'write',
      () => supabase.from('payments').insert(row).select(PAYMENT_SELECT).single(),
    )
    if (ok && data) {
      const result = toPayment(data)
      if (result.status === 'completed') void applyCompletedPaymentToPolicy(result.policyId, result.amount)
      return { data: result, error: null }
    }
    local('payments', 'write')
    const item = { ...payment, id: uid() } as Payment
    return { data: localStore.payments.create(item), error: null }
  },

  /** Marks a captured payment as validated (completed) or otherwise updates
   *  its status — the "payments capturing and validation" split from the
   *  2026-08 access review: capture = record(), validation = this. */
  async update(id: string, updates: Partial<Payment>) {
    const row: Record<string, unknown> = {}
    if (updates.status !== undefined) row.status = updates.status
    if (updates.amount !== undefined) row.amount = updates.amount
    if (updates.method !== undefined) row.method = updates.method
    if (updates.date !== undefined) row.payment_date = updates.date
    if (updates.splitPayments !== undefined) row.split_payments = updates.splitPayments ?? null
    const { ok, data } = await sb('payments', 'write',
      () => supabase.from('payments').update(row).eq('id', id).select(PAYMENT_SELECT).single(),
    )
    if (ok && data) {
      const result = toPayment(data)
      if (updates.status === 'completed') void applyCompletedPaymentToPolicy(result.policyId, result.amount)
      return { data: result, error: null }
    }
    local('payments', 'write')
    return { data: localStore.payments.update(id, updates), error: null }
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
    if (ok && data) return { data: (data as unknown[]).map(toTicket), error: null }
    local('tickets', 'read')
    return { data: localStore.tickets.list(), error: null }
  },

  async create(ticket: Omit<Ticket, 'id'>) {
    const row = {
      ticket_number: ticket.ticketNumber, client_id: ticket.clientId,
      subject: ticket.subject, description: ticket.description,
      status: ticket.status, priority: ticket.priority, category: ticket.category,
      messages: ticket.messages,
    }
    const { ok, data } = await sb('tickets', 'write',
      () => supabase.from('tickets').insert(row).select(TICKET_SELECT).single(),
    )
    if (ok && data) return { data: toTicket(data), error: null }
    local('tickets', 'write')
    const item = { ...ticket, id: uid() } as Ticket
    return { data: localStore.tickets.create(item), error: null }
  },

  async update(id: string, updates: Partial<Ticket>) {
    const row: Record<string, unknown> = {}
    if (updates.status     !== undefined) row.status      = updates.status
    if (updates.assignedTo !== undefined) row.assigned_to = updates.assignedTo ?? null
    if (updates.messages   !== undefined) row.messages    = updates.messages
    row.updated_at = new Date().toISOString()
    const { ok, data } = await sb('tickets', 'write',
      () => supabase.from('tickets').update(row).eq('id', id).select(TICKET_SELECT).single(),
    )
    if (ok && data) return { data: toTicket(data), error: null }
    local('tickets', 'write')
    return { data: localStore.tickets.update(id, updates), error: null }
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
    local('emails', 'read')
    const rows = localStore.emails.list()
    return { data: folder ? rows.filter(e => e.folder === folder) : rows, error: null }
  },

  async create(email: Omit<EmailMessage, 'id' | 'timestamp'>) {
    const row = {
      from_address: email.from, from_name: email.fromName, to_address: email.to,
      subject: email.subject, body: email.body, read: email.read,
      folder: email.folder, linked_to: email.linkedTo ?? null,
    }
    const { ok, data } = await sb('emails', 'write',
      () => supabase.from('emails').insert(row).select().single(),
    )
    if (ok && data) return { data: toEmail(data), error: null }
    local('emails', 'write')
    const item = { ...email, id: uid(), timestamp: new Date().toISOString() } as EmailMessage
    return { data: localStore.emails.create(item), error: null }
  },

  async update(id: string, updates: Partial<EmailMessage>) {
    const row: Record<string, unknown> = {}
    if (updates.read    !== undefined) row.read    = updates.read
    if (updates.starred !== undefined) row.starred = updates.starred
    if (updates.folder  !== undefined) row.folder  = updates.folder
    await sb('emails', 'write', () => supabase.from('emails').update(row).eq('id', id))
    localStore.emails.update(id, updates)
    return { data: localStore.emails.list().find(e => e.id === id) ?? null, error: null }
  },

  async markRead(id: string) {
    await sb('emails', 'write', () => supabase.from('emails').update({ read: true }).eq('id', id))
    localStore.emails.update(id, { read: true } as Partial<EmailMessage>)
  },

  async delete(id: string) {
    await sb('emails', 'delete', () => supabase.from('emails').delete().eq('id', id))
    localStore.emails.delete(id)
  },
}

// ── LEADS ─────────────────────────────────────────────────────────
export const leads = {
  async list() {
    const { ok, data } = await sb('leads', 'read',
      () => supabase.from('leads').select('*').order('created_at', { ascending: false }),
      d => Array.isArray(d),
    )
    if (ok && data) return { data: (data as unknown[]).map(toLead), error: null }
    local('leads', 'read')
    return { data: localStore.leads.list(), error: null }
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
    const { ok, data } = await sb('leads', 'write',
      () => supabase.from('leads').update(row).eq('id', id).select().single(),
    )
    if (ok && data) return { data: toLead(data), error: null }
    local('leads', 'write')
    return { data: localStore.leads.update(id, updates), error: null }
  },
}

// ── STAFF / PROFILES ──────────────────────────────────────────────
export const staff = {
  async list() {
    const { ok, data } = await sb('profiles', 'read',
      () => supabase.from('profiles').select('*, custom_roles!profiles_custom_role_id_fkey(name)').order('name'),
      d => Array.isArray(d),
    )
    if (ok && data) return { data: (data as Record<string,unknown>[]).map(toProfile), error: null }
    local('profiles', 'read')
    return { data: localStore.staff.list(), error: null }
  },

  /**
   * Creates a real Supabase Auth user + profiles row via a Netlify function
   * (netlify/functions/create-staff.ts), which alone holds the service-role
   * key needed for account creation. Unlike every other method in this
   * module, there is no local-storage fallback here — a "staff member"
   * that only exists in browser state was never real, so a failure must be
   * surfaced as an error rather than silently faked.
   */
  async create(input: { name: string; username?: string; email: string; password: string; phone?: string; role: string; department: string; customRoleId?: string; permissions?: string[] }) {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return { data: null, error: 'Not signed in.' }
    try {
      const res = await fetch('/.netlify/functions/create-staff', {
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
    if (updates.role        !== undefined) row.role        = updates.role
    if (updates.department  !== undefined) row.department  = updates.department
    if (updates.phone       !== undefined) row.phone       = updates.phone ?? null
    if (updates.active      !== undefined) row.active      = updates.active
    if (updates.permissions !== undefined) row.permissions = updates.permissions
    if (updates.customRoleId !== undefined) row.custom_role_id = updates.customRoleId || null
    const start = Date.now()
    const { data, error } = await supabase.from('profiles').update(row).eq('id', id).select('*, custom_roles!profiles_custom_role_id_fkey(name)').single()
    health.record({ ts: Date.now(), type: 'write', table: 'profiles', success: !error, duration: Date.now() - start, source: 'supabase', detail: error ? String(error.message) : undefined })
    if (error) return { data: null, error: error.code === '23505' ? 'That username is already taken.' : error.message }
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
      const res = await fetch('/.netlify/functions/delete-staff', {
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
   * Creates a Super Admin / Admin / Tech Support account via
   * create-system-user.ts — the System Access Roles page's counterpart to
   * staff.create() (Staff Management, work roles only). Super Admin caller
   * only, enforced both here and again by the DB trigger.
   */
  async createSystemUser(input: { name: string; username?: string; email: string; password: string; phone?: string; role: string; department: string }) {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return { data: null, error: 'Not signed in.' }
    try {
      const res = await fetch('/.netlify/functions/create-system-user', {
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
      const res = await fetch('/.netlify/functions/reset-staff-password', {
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
    if (ok && data) return { data: (data as unknown[]).map(toFraudCase), error: null }
    local('fraud_cases', 'read')
    return { data: localStore.fraudCases.list(), error: null }
  },

  async update(id: string, updates: Partial<FraudCase>) {
    const row: Record<string, unknown> = {}
    if (updates.status     !== undefined) row.status      = updates.status
    if (updates.assignedTo !== undefined) row.assigned_to = updates.assignedTo ?? null
    if (updates.notes      !== undefined) row.notes       = updates.notes ?? null
    if (updates.resolvedAt !== undefined) row.resolved_at = updates.resolvedAt ?? null
    const { ok, data } = await sb('fraud_cases', 'write',
      () => supabase.from('fraud_cases').update(row).eq('id', id).select(FRAUD_SELECT).single(),
    )
    if (ok && data) return { data: toFraudCase(data), error: null }
    local('fraud_cases', 'write')
    return { data: localStore.fraudCases.update(id, updates), error: null }
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
    const { ok, data } = await sb('reminders', 'read',
      () => supabase.from('reminders').select(REMINDER_SELECT).order('due_date'),
      d => Array.isArray(d),
    )
    if (ok && data) return { data: (data as unknown[]).map(toReminder), error: null }
    local('reminders', 'read')
    return { data: localStore.reminders.list(), error: null }
  },

  async markSent(id: string) {
    await sb('reminders', 'write', () => supabase.from('reminders').update({ sent: true }).eq('id', id))
    localStore.reminders.update(id, { sent: true } as Partial<Reminder>)
  },

  async markAllSent(ids: string[]) {
    await sb('reminders', 'write', () => supabase.from('reminders').update({ sent: true }).in('id', ids))
    ids.forEach(id => localStore.reminders.update(id, { sent: true } as Partial<Reminder>))
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
    const row = {
      type: reminder.type, client_id: reminder.clientId, policy_id: reminder.policyId ?? null,
      due_date: reminder.dueDate, message: reminder.message, sent: reminder.sent, channel: reminder.channel,
    }
    const { data, error } = await supabase.from('reminders').insert(row).select(REMINDER_SELECT).single()
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
}

export interface ApiKeyRow {
  id: string
  developerId: string
  keyPrefix: string
  scopes: string[]
  status: 'active' | 'revoked'
  rateLimitPerMin: number
  createdAt: string
  lastUsedAt?: string
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
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toApiKeyRow(r: any): ApiKeyRow {
  return {
    id: r.id, developerId: r.developer_id, keyPrefix: r.key_prefix, scopes: r.scopes ?? [],
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

  /** Calls create-api-developer.ts — needs the service-role key to create the partner's login-disabled identity. */
  async createDeveloper(input: { companyName: string; contactEmail: string; contactPhone?: string; termsVersion: string }) {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return { data: null, error: 'Not signed in.' }
    try {
      // termsAccepted is hardcoded true here — the only caller (DeveloperApi
      // page) already gates the Register button on the acceptance checkbox,
      // so by the time this fires the admin has confirmed it on the client's
      // behalf. termsVersion still travels through from the caller so the
      // stored record reflects exactly what was shown at registration time.
      const res = await fetch('/.netlify/functions/create-api-developer', {
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

  /** Calls create-api-key.ts. Returns the raw key ONCE — it is never stored or retrievable again. */
  async issueKey(developerId: string, opts?: { scopes?: string[]; rateLimitPerMin?: number }) {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return { data: null, error: 'Not signed in.' }
    try {
      const res = await fetch('/.netlify/functions/create-api-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
        body: JSON.stringify({ developerId, scopes: opts?.scopes, rateLimitPerMin: opts?.rateLimitPerMin }),
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
  productBreakdown: { category: string; count: number }[]
  recentPolicies: Policy[]
  latestClaim: { claimNumber: string; clientName: string } | null
  latestPayment: { clientName: string; amount: number } | null
  latestLead: { name: string; source: string } | null
  latestFraud: { claimNumber: string; fraudScore: number } | null
  latestClient: { name: string } | null
}

async function loadDashboardStatsLight(): Promise<DashboardStats | null> {
  const [
    activeRes, pendingRes, leadsRes, fraudRes, lapsedRes, totalRes, premiumsRes, categoryRes, recentRes,
    latestClaimRes, latestPaymentRes, latestLeadRes, latestFraudRes, clientsCountRes, latestClientRes,
  ] = await Promise.all([
    supabase.from('policies').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('claims').select('*', { count: 'exact', head: true }).in('status', ['pending', 'under_review']),
    supabase.from('leads').select('*', { count: 'exact', head: true }).eq('status', 'new'),
    supabase.from('fraud_cases').select('*', { count: 'exact', head: true }).eq('status', 'open'),
    supabase.from('policies').select('*', { count: 'exact', head: true }).eq('status', 'lapsed'),
    supabase.from('policies').select('*', { count: 'exact', head: true }),
    supabase.from('payments').select('amount').eq('status', 'completed').limit(5000),
    supabase.from('policies').select('products!product_id(category)').limit(5000),
    supabase.from('policies').select(POLICY_SELECT).order('created_at', { ascending: false }).limit(5),
    supabase.from('claims').select('claim_number, policies!policy_id(clients!client_id(name))').order('created_at', { ascending: false }).limit(1),
    supabase.from('payments').select('amount, policies!policy_id(clients!client_id(name))').order('payment_date', { ascending: false }).limit(1),
    supabase.from('leads').select('name, source').order('created_at', { ascending: false }).limit(1),
    supabase.from('fraud_cases').select('fraud_score, claims!claim_id(claim_number)').order('created_at', { ascending: false }).limit(1),
    supabase.from('clients').select('*', { count: 'exact', head: true }),
    supabase.from('clients').select('name').order('created_at', { ascending: false }).limit(1),
  ])

  const anyError = activeRes.error || pendingRes.error || leadsRes.error || fraudRes.error
    || lapsedRes.error || totalRes.error || premiumsRes.error || categoryRes.error || recentRes.error
    || latestClaimRes.error || latestPaymentRes.error || latestLeadRes.error || latestFraudRes.error
    || clientsCountRes.error || latestClientRes.error
  if (anyError) return null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = latestClaimRes.data?.[0] as any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = latestPaymentRes.data?.[0] as any
  const l = latestLeadRes.data?.[0] as { name: string; source: string } | undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const f = latestFraudRes.data?.[0] as any
  const cl = latestClientRes.data?.[0] as { name: string } | undefined

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
    productBreakdown: [...categoryCounts.entries()].map(([category, count]) => ({ category, count })),
    recentPolicies: ((recentRes.data ?? []) as unknown[]).map(toPolicy),
    latestClaim: c ? { claimNumber: c.claim_number, clientName: c.policies?.clients?.name ?? '' } : null,
    latestPayment: p ? { clientName: p.policies?.clients?.name ?? '', amount: p.amount } : null,
    latestLead: l ? { name: l.name, source: l.source ?? '' } : null,
    latestFraud: f ? { claimNumber: f.claims?.claim_number ?? '', fraudScore: f.fraud_score } : null,
    latestClient: cl ? { name: cl.name } : null,
  }
}

async function loadDashboardStatsFallback(): Promise<DashboardStats> {
  const [{ data: allPolicies }, { data: allClaims }, { data: allPayments }, { data: allLeads }, { data: allFraud }, { data: allClients }] = await Promise.all([
    policies.list(), claims.list(), payments.list(), leads.list(), fraudCases.list(), clients.list(),
  ])
  const pol = allPolicies ?? [], cla = allClaims ?? [], pay = allPayments ?? [], lea = allLeads ?? [], fra = allFraud ?? [], cli = allClients ?? []
  const total = pol.length
  const lapsed = pol.filter(p => p.status === 'lapsed').length
  const categoryCounts = new Map<string, number>()
  for (const p of pol) categoryCounts.set(p.productName, (categoryCounts.get(p.productName) ?? 0) + 1)
  return {
    activePolicies: pol.filter(p => p.status === 'active').length,
    pendingClaims: cla.filter(c => c.status === 'pending' || c.status === 'under_review').length,
    totalPremiums: pay.filter(p => p.status === 'completed').reduce((s, p) => s + p.amount, 0),
    newLeads: lea.filter(l => l.status === 'new').length,
    fraudAlerts: fra.filter(f => f.status === 'open').length,
    lapseRate: total > 0 ? Number((lapsed / total * 100).toFixed(1)) : 0,
    totalClients: cli.length,
    productBreakdown: [...categoryCounts.entries()].map(([category, count]) => ({ category, count })),
    recentPolicies: [...pol].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5),
    latestClaim: cla[0] ? { claimNumber: cla[0].claimNumber, clientName: cla[0].clientName } : null,
    latestPayment: pay[0] ? { clientName: pay[0].clientName, amount: pay[0].amount } : null,
    latestLead: lea[0] ? { name: lea[0].name, source: lea[0].source } : null,
    latestFraud: fra[0] ? { claimNumber: fra[0].claimNumber, fraudScore: fra[0].fraudScore } : null,
    latestClient: cli[0] ? { name: [...cli].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0].name } : null,
  }
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
}

export const sidebarCounts = {
  async load(): Promise<SidebarCounts> {
    const [pol, claimsRes, cli, rem, mail, tix] = await Promise.all([
      supabase.from('policies').select('*', { count: 'exact', head: true }),
      supabase.from('claims').select('*', { count: 'exact', head: true }).in('status', ['pending', 'under_review']),
      supabase.from('clients').select('*', { count: 'exact', head: true }).eq('status', 'active'),
      supabase.from('reminders').select('*', { count: 'exact', head: true }).eq('sent', false),
      supabase.from('emails').select('*', { count: 'exact', head: true }).eq('folder', 'inbox').eq('read', false),
      supabase.from('tickets').select('*', { count: 'exact', head: true }).in('status', ['open', 'in_progress']),
    ])
    return {
      policies: pol.count ?? 0,
      claimsPending: claimsRes.count ?? 0,
      clients: cli.count ?? 0,
      remindersDue: rem.count ?? 0,
      emailUnread: mail.count ?? 0,
      ticketsOpen: tix.count ?? 0,
    }
  },
}

// ── REALTIME ──────────────────────────────────────────────────────
export function subscribeToTable(table: string, callback: () => void) {
  const channel = supabase
    .channel(`rt:${table}`)
    .on('postgres_changes', { event: '*', schema: 'public', table }, callback)
    .subscribe()
  return () => { supabase.removeChannel(channel) }
}

// ── EXPORT ────────────────────────────────────────────────────────
export const db = {
  policies, clients, products, claims, payments,
  tickets, emails, leads, staff, fraudCases, reminders, cautionFlags, settings, loginAttempts, developerApi,
  customRoles,
  dashboardStats, sidebarCounts,
  subscribeToTable,
  resetLocalData: () => localStore.reset(),
}
