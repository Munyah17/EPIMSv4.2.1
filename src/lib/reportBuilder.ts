/**
 * Report Builder
 *
 * One engine behind the whole Reports page. Every entity (policy, claim,
 * payment, client) is normalised into a flat `Fact` — a record with a
 * canonical set of dimensions (date, agent, product, category, status,
 * source, method) plus two measures (amount, heads). All filtering and
 * grouping then happens on facts alone, so "report by agent / by product /
 * by source / by month / by status" is the same code path for every report.
 *
 * Detail reports (policies, clients, claims, payments) can additionally be
 * grouped into aggregates; the four aggregate datasets (agents, digital
 * agents, products, sources) are aggregations by definition.
 */
import type { Policy, Claim, Payment, Client, Product, AppUser } from '../types'
import type { ApiDeveloper } from './db'
import { policyBillablePremium, billableHeadCount } from './premium'
import { policySourceLabel } from './policySources'

// ── Public types ────────────────────────────────────────────────────

export type ReportDataset =
  | 'policies' | 'clients' | 'claims' | 'payments'
  | 'agents' | 'digital_agents' | 'products' | 'sources'

export type GroupBy =
  | 'none' | 'agent' | 'product' | 'category' | 'status'
  | 'source' | 'method' | 'client' | 'month'

export type CellKind = 'text' | 'number' | 'money'

export interface ReportFilters {
  from?: string
  to?: string
  agentId?: string
  productId?: string
  category?: string
  status?: string
  source?: string
  method?: string
}

export interface ReportData {
  policies: Policy[]
  claims: Claim[]
  payments: Payment[]
  clients: Client[]
  staff: AppUser[]
  products: Product[]
  developers: ApiDeveloper[]
}

export interface ReportColumn {
  label: string
  kind: CellKind
}

export interface ReportResult {
  title: string
  /** Column definitions; `kind` drives cell formatting and sort order. */
  columns: ReportColumn[]
  /** Raw cell values — money/number cells stay numeric so Excel keeps
   *  real numbers and sorting stays correct. Format with formatCell. */
  rows: (string | number)[][]
  stats: { label: string; value: string }[]
  /** Series for the bar/donut chart — mirrors the grouped breakdown. */
  chart: { label: string; value: number }[]
  /** Monthly series for the trend line, oldest → newest. */
  trend: { label: string; value: number }[]
}

// ── Dataset metadata ────────────────────────────────────────────────

export const DATASETS: { value: ReportDataset; label: string }[] = [
  { value: 'policies',       label: 'Policies' },
  { value: 'clients',        label: 'Clients' },
  { value: 'claims',         label: 'Claims' },
  { value: 'payments',       label: 'Payments' },
  { value: 'agents',         label: 'Agent Performance' },
  { value: 'digital_agents', label: 'Digital Agents (API)' },
  { value: 'products',       label: 'Products' },
  { value: 'sources',        label: 'Channels / Sources' },
]

/** Which groupings make sense per detail dataset. */
export const GROUP_OPTIONS: Record<string, { value: GroupBy; label: string }[]> = {
  policies: [
    { value: 'none', label: 'No grouping — list each policy' },
    { value: 'agent', label: 'By Agent' },
    { value: 'product', label: 'By Product' },
    { value: 'category', label: 'By Category' },
    { value: 'status', label: 'By Status' },
    { value: 'source', label: 'By Channel / Source' },
    { value: 'client', label: 'By Client' },
    { value: 'month', label: 'By Month Registered' },
  ],
  claims: [
    { value: 'none', label: 'No grouping — list each claim' },
    { value: 'agent', label: 'By Agent' },
    { value: 'product', label: 'By Product' },
    { value: 'category', label: 'By Category' },
    { value: 'status', label: 'By Status' },
    { value: 'month', label: 'By Month Submitted' },
  ],
  payments: [
    { value: 'none', label: 'No grouping — list each payment' },
    { value: 'method', label: 'By Method' },
    { value: 'agent', label: 'By Agent' },
    { value: 'status', label: 'By Status' },
    { value: 'month', label: 'By Month' },
  ],
  clients: [
    { value: 'none', label: 'No grouping — list each client' },
    { value: 'agent', label: 'By Agent' },
    { value: 'status', label: 'By Status' },
    { value: 'month', label: 'By Month Registered' },
  ],
}

export const STATUS_OPTIONS: Record<string, string[]> = {
  policies: ['active', 'waiting_period', 'pending', 'lapsed', 'cancelled', 'expired'],
  claims: ['pending', 'under_review', 'approved', 'rejected', 'paid'],
  payments: ['completed', 'pending', 'failed'],
  clients: ['active', 'inactive'],
}

const CATEGORIES = ['life', 'funeral', 'health', 'accident', 'motor', 'property', 'agriculture']
export const CATEGORY_OPTIONS = CATEGORIES

// ── Facts ───────────────────────────────────────────────────────────

interface Fact {
  id: string
  /** ISO date the record counts under for date filtering. */
  date: string
  /** Primary money measure: billed premium / claim amount / payment. */
  amount: number
  /** Secondary measure: lives covered on a policy (0 elsewhere). */
  heads: number
  agentId?: string
  agentName?: string
  productId?: string
  productName?: string
  category?: string
  status?: string
  source?: string
  method?: string
  clientId?: string
  clientName?: string
  entity: Policy | Claim | Payment | Client
}

function policyFacts(policies: Policy[]): Fact[] {
  return policies.map(p => ({
    id: p.id,
    date: p.createdAt || p.startDate,
    amount: policyBillablePremium(p),
    heads: billableHeadCount(p),
    agentId: p.agentId, agentName: p.agentName,
    productId: p.productId, productName: p.productName,
    category: p.productCategory, status: p.status, source: p.source,
    clientId: p.clientId, clientName: p.clientName,
    entity: p,
  }))
}

function claimFacts(claims: Claim[], policyById: Map<string, Policy>): Fact[] {
  return claims.map(c => {
    const policy = policyById.get(c.policyId)
    return {
      id: c.id,
      date: c.dateSubmitted,
      amount: c.amount,
      heads: 0,
      agentId: c.agentId ?? policy?.agentId,
      agentName: c.agentName ?? policy?.agentName,
      productId: policy?.productId, productName: c.productName,
      category: c.category ?? policy?.productCategory,
      status: c.status,
      clientId: c.clientId, clientName: c.clientName,
      entity: c,
    }
  })
}

function paymentFacts(payments: Payment[], policyById: Map<string, Policy>): Fact[] {
  return payments.map(p => {
    const policy = policyById.get(p.policyId)
    return {
      id: p.id,
      date: p.date,
      amount: p.amount,
      heads: 0,
      agentId: policy?.agentId, agentName: policy?.agentName,
      productId: policy?.productId, productName: policy?.productName,
      category: policy?.productCategory,
      status: p.status, method: p.method,
      clientName: p.clientName,
      entity: p,
    }
  })
}

function clientFacts(clients: Client[]): Fact[] {
  return clients.map(c => ({
    id: c.id,
    date: c.createdAt,
    amount: 0,
    heads: c.policyCount,
    agentId: c.agentId,
    status: c.status,
    clientId: c.id, clientName: c.name,
    entity: c,
  }))
}

// ── Filtering ───────────────────────────────────────────────────────

function applyFilters(facts: Fact[], f: ReportFilters): Fact[] {
  return facts.filter(x =>
    (!f.from || (x.date && x.date >= f.from)) &&
    (!f.to || (x.date && x.date <= f.to)) &&
    (!f.agentId || x.agentId === f.agentId) &&
    (!f.productId || x.productId === f.productId) &&
    (!f.category || x.category === f.category) &&
    (!f.status || x.status === f.status) &&
    (!f.source || x.source === f.source) &&
    (!f.method || x.method === f.method))
}

// ── Grouping ────────────────────────────────────────────────────────

function groupKeyOf(f: Fact, by: GroupBy): string {
  switch (by) {
    case 'agent': return f.agentId ?? '∅'
    case 'product': return f.productId ?? '∅'
    case 'category': return f.category ?? '∅'
    case 'status': return f.status ?? '∅'
    case 'source': return f.source ?? 'web_app'
    case 'method': return f.method ?? '∅'
    case 'client': return f.clientId ?? f.clientName ?? '∅'
    case 'month': return (f.date || '').slice(0, 7) || '∅'
    default: return '∅'
  }
}

function groupLabelOf(key: string, by: GroupBy, data: ReportData): string {
  if (key === '∅') return 'Unassigned'
  switch (by) {
    case 'agent': {
      const dev = data.developers.find(d => d.agentProfileId === key)
      if (dev) return `${dev.companyName} (Digital Agent)`
      return data.staff.find(s => s.id === key)?.name ?? 'Unknown agent'
    }
    case 'product': return data.products.find(p => p.id === key)?.name ?? 'Unknown product'
    case 'category':
    case 'status':
    case 'method': return key.replace(/_/g, ' ')
    case 'source': return policySourceLabel(key)
    case 'client': return data.clients.find(c => c.id === key)?.name ?? key
    case 'month': return monthLabel(key)
    default: return key
  }
}

export function monthLabel(ym: string): string {
  const [y, m] = ym.split('-')
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${names[Number(m) - 1] ?? m} ${y}`
}

// ── Cell formatting ─────────────────────────────────────────────────

export function formatCell(value: string | number, kind: CellKind): string {
  if (kind === 'money') {
    const n = typeof value === 'number' ? value : Number(value) || 0
    return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }
  if (kind === 'number') {
    const n = typeof value === 'number' ? value : Number(value) || 0
    return n.toLocaleString('en-US')
  }
  return String(value ?? '')
}

// ── Detail row shapes ───────────────────────────────────────────────

function policyRow(p: Policy): (string | number)[] {
  return [
    p.policyNumber, p.clientName, p.productName, (p.productCategory ?? '').replace(/_/g, ' '),
    policyBillablePremium(p), billableHeadCount(p),
    p.status.replace(/_/g, ' '), p.agentName ?? '', policySourceLabel(p.source),
    p.startDate, p.createdAt,
  ]
}
const POLICY_COLUMNS: ReportColumn[] = [
  { label: 'Policy No.', kind: 'text' }, { label: 'Client', kind: 'text' }, { label: 'Product', kind: 'text' },
  { label: 'Category', kind: 'text' }, { label: 'Billed Premium', kind: 'money' }, { label: 'Lives', kind: 'number' },
  { label: 'Status', kind: 'text' }, { label: 'Agent', kind: 'text' }, { label: 'Channel', kind: 'text' },
  { label: 'Start', kind: 'text' }, { label: 'Registered', kind: 'text' },
]

function claimRow(c: Claim, policyById: Map<string, Policy>, data: ReportData): (string | number)[] {
  const policy = policyById.get(c.policyId)
  const agentId = c.agentId ?? policy?.agentId
  const agent = c.agentName ?? policy?.agentName ?? data.staff.find(s => s.id === agentId)?.name
    ?? data.developers.find(d => d.agentProfileId === agentId)?.companyName ?? ''
  return [
    c.claimNumber, c.clientName, c.policyNumber, c.productName, c.amount, c.claimType,
    c.status.replace(/_/g, ' '), c.stage.replace(/_/g, ' '), `${c.fraudScore}%`, agent, c.dateSubmitted,
  ]
}
const CLAIM_COLUMNS: ReportColumn[] = [
  { label: 'Claim No.', kind: 'text' }, { label: 'Client', kind: 'text' }, { label: 'Policy', kind: 'text' },
  { label: 'Product', kind: 'text' }, { label: 'Amount', kind: 'money' }, { label: 'Type', kind: 'text' },
  { label: 'Status', kind: 'text' }, { label: 'Stage', kind: 'text' }, { label: 'Fraud', kind: 'text' },
  { label: 'Agent', kind: 'text' }, { label: 'Submitted', kind: 'text' },
]

function paymentRow(p: Payment, policyById: Map<string, Policy>, data: ReportData): (string | number)[] {
  const policy = policyById.get(p.policyId)
  const agent = policy?.agentName ?? data.staff.find(s => s.id === policy?.agentId)?.name ?? ''
  return [
    p.reference, p.clientName, p.policyNumber, p.amount,
    (p.method ?? '').replace(/_/g, ' '), p.status, p.date, agent,
  ]
}
const PAYMENT_COLUMNS: ReportColumn[] = [
  { label: 'Reference', kind: 'text' }, { label: 'Client', kind: 'text' }, { label: 'Policy', kind: 'text' },
  { label: 'Amount', kind: 'money' }, { label: 'Method', kind: 'text' }, { label: 'Status', kind: 'text' },
  { label: 'Date', kind: 'text' }, { label: 'Agent', kind: 'text' },
]

function clientRow(c: Client, data: ReportData): (string | number)[] {
  const agent = data.staff.find(s => s.id === c.agentId)?.name
    ?? data.developers.find(d => d.agentProfileId === c.agentId)?.companyName ?? ''
  return [c.name, c.phone, c.nationalId, c.policyCount, c.status, agent, c.createdAt]
}
const CLIENT_COLUMNS: ReportColumn[] = [
  { label: 'Client', kind: 'text' }, { label: 'Phone', kind: 'text' }, { label: 'National ID', kind: 'text' },
  { label: 'Policies', kind: 'number' }, { label: 'Status', kind: 'text' }, { label: 'Referred By', kind: 'text' },
  { label: 'Registered', kind: 'text' },
]

const GROUPED_COLUMNS = (itemLabel: string, amountLabel: string): ReportColumn[] => [
  { label: 'Group', kind: 'text' }, { label: itemLabel, kind: 'number' },
  { label: 'Lives', kind: 'number' }, { label: amountLabel, kind: 'money' },
]

// ── Trend ───────────────────────────────────────────────────────────

function monthlyTrend(facts: Fact[], months = 12): { label: string; value: number }[] {
  const byMonth = new Map<string, number>()
  for (const f of facts) {
    const key = (f.date || '').slice(0, 7)
    if (key) byMonth.set(key, (byMonth.get(key) ?? 0) + f.amount)
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-months)
    .map(([k, v]) => ({ label: monthLabel(k), value: Math.round(v * 100) / 100 }))
}

// ── Aggregate datasets ──────────────────────────────────────────────

/** Aggregates shared by the agent / digital-agent / product / source
 *  reports: billed premium comes from policies, collections from completed
 *  payments joined through the policy, claims from the claim's agent. */
function collectFacts(data: ReportData): { policies: Fact[]; claims: Fact[]; payments: Fact[]; clients: Fact[] } {
  const policyById = new Map(data.policies.map(p => [p.id, p]))
  return {
    policies: policyFacts(data.policies),
    claims: claimFacts(data.claims, policyById),
    payments: paymentFacts(data.payments, policyById),
    clients: clientFacts(data.clients),
  }
}

interface Bucket {
  label: string
  policies: number
  heads: number
  billed: number
  collected: number
  claims: number
  claimsPaid: number
}

function newBucket(label: string): Bucket {
  return { label, policies: 0, heads: 0, billed: 0, collected: 0, claims: 0, claimsPaid: 0 }
}

/** Buckets keyed by an arbitrary dimension across policies, with the
 *  joined collection and claim measures folded in. Collections and claims
 *  are attributed through the policy they belong to: a payment counts for
 *  a bucket only when its policy survives the current filters. */
function aggregate(
  facts: ReturnType<typeof collectFacts>,
  f: ReportFilters,
  keyOf: (policyFact: Fact) => string | undefined,
  labelOf: (key: string) => string,
): Map<string, Bucket> {
  const buckets = new Map<string, Bucket>()
  const bucketFor = (key: string) => {
    let b = buckets.get(key)
    if (!b) { b = newBucket(labelOf(key)); buckets.set(key, b) }
    return b
  }

  const filteredPolicies = applyFilters(facts.policies, f)
  const policyFactById = new Map(filteredPolicies.map(p => [p.id, p]))
  const anyPolicyFactById = new Map(facts.policies.map(p => [p.id, p]))

  for (const p of filteredPolicies) {
    const key = keyOf(p)
    if (key === undefined) continue
    const b = bucketFor(key)
    b.policies += 1
    b.heads += p.heads
    b.billed += p.amount
  }
  // Collections: completed payments in the filtered window, credited to
  // the bucket of the policy they paid — skipped when that policy itself
  // is filtered out (e.g. reporting a single agent's book).
  for (const pay of applyFilters(facts.payments, f)) {
    if (pay.status !== 'completed') continue
    const policyFact = policyFactById.get((pay.entity as Payment).policyId)
    if (!policyFact) continue
    const key = keyOf(policyFact)
    if (key === undefined) continue
    bucketFor(key).collected += pay.amount
  }
  // Claims attribute through their policy too, but keep a fallback to the
  // unfiltered policy map so a claim against a just-lapsed policy still
  // lands in the right bucket.
  for (const c of applyFilters(facts.claims, f)) {
    const policyFact = policyFactById.get((c.entity as Claim).policyId)
      ?? anyPolicyFactById.get((c.entity as Claim).policyId)
    if (!policyFact) continue
    const key = keyOf(policyFact)
    if (key === undefined) continue
    const b = bucketFor(key)
    b.claims += 1
    if (c.status === 'paid') b.claimsPaid += c.amount
  }
  return buckets
}

const MONEY = (n: number) => Math.round(n * 100) / 100

// ── Main entry ──────────────────────────────────────────────────────

export function buildReport(dataset: ReportDataset, data: ReportData, f: ReportFilters, groupBy: GroupBy = 'none'): ReportResult {
  const facts = collectFacts(data)
  const policyById = new Map(data.policies.map(p => [p.id, p]))

  // — Aggregate datasets —
  if (dataset === 'agents' || dataset === 'digital_agents') {
    const devAgentIds = new Set(data.developers.map(d => d.agentProfileId))
    const isDev = (id: string | undefined) => !!id && devAgentIds.has(id)
    const buckets = aggregate(facts, f,
      fact => dataset === 'digital_agents' ? (isDev(fact.agentId) ? fact.agentId! : undefined) : (fact.agentId ?? '∅'),
      key => key === '∅' ? 'Unassigned' : (data.developers.find(d => d.agentProfileId === key)?.companyName ?? data.staff.find(s => s.id === key)?.name ?? 'Unknown agent'))
    const rows = [...buckets.values()].sort((a, b) => b.billed - a.billed)
    const columns: ReportColumn[] = dataset === 'digital_agents'
      ? [
          { label: 'Digital Agent', kind: 'text' }, { label: 'Status', kind: 'text' }, { label: 'Policies', kind: 'number' },
          { label: 'Lives', kind: 'number' }, { label: 'Billed Premium', kind: 'money' }, { label: 'Collected', kind: 'money' },
          { label: 'Wallet Float', kind: 'money' }, { label: 'Claims', kind: 'number' }, { label: 'Claims Paid', kind: 'money' },
        ]
      : [
          { label: 'Agent', kind: 'text' }, { label: 'Role', kind: 'text' }, { label: 'Policies', kind: 'number' },
          { label: 'Lives', kind: 'number' }, { label: 'Billed Premium', kind: 'money' }, { label: 'Collected', kind: 'money' },
          { label: 'Claims', kind: 'number' }, { label: 'Claims Paid', kind: 'money' },
        ]
    return {
      title: dataset === 'agents' ? 'Agent Performance' : 'Digital Agent (API) Performance',
      columns,
      rows: rows.map(b => {
        const key = [...buckets.entries()].find(([, v]) => v === b)![0]
        if (dataset === 'digital_agents') {
          const dev = data.developers.find(d => d.agentProfileId === key)
          return [b.label, dev?.status ?? '', b.policies, b.heads, MONEY(b.billed), MONEY(b.collected), dev ? Number(dev.walletBalance) : 0, b.claims, MONEY(b.claimsPaid)]
        }
        const role = data.staff.find(s => s.id === key)?.role.replace(/_/g, ' ') ?? (key === '∅' ? '' : 'digital agent')
        return [b.label, role, b.policies, b.heads, MONEY(b.billed), MONEY(b.collected), b.claims, MONEY(b.claimsPaid)]
      }),
      stats: [
        { label: dataset === 'agents' ? 'Agents' : 'Digital Agents', value: String(rows.length) },
        { label: 'Policies Written', value: String(rows.reduce((s, b) => s + b.policies, 0)) },
        { label: 'Premium Billed', value: formatCell(rows.reduce((s, b) => s + b.billed, 0), 'money') },
        { label: 'Collected', value: formatCell(rows.reduce((s, b) => s + b.collected, 0), 'money') },
      ],
      chart: rows.map(b => ({ label: b.label, value: MONEY(b.billed) })),
      trend: monthlyTrend(applyFilters(facts.policies, f)),
    }
  }

  if (dataset === 'products' || dataset === 'sources') {
    const buckets = aggregate(facts, f,
      fact => dataset === 'products' ? (fact.productId ?? '∅') : (fact.source ?? 'web_app'),
      key => dataset === 'products'
        ? (data.products.find(p => p.id === key)?.name ?? 'Unknown product')
        : policySourceLabel(key))
    const rows = [...buckets.values()].sort((a, b) => b.billed - a.billed)
    const columns: ReportColumn[] = dataset === 'products'
      ? [
          { label: 'Product', kind: 'text' }, { label: 'Category', kind: 'text' }, { label: 'Policies', kind: 'number' },
          { label: 'Lives', kind: 'number' }, { label: 'Billed Premium', kind: 'money' }, { label: 'Collected', kind: 'money' },
          { label: 'Claims', kind: 'number' }, { label: 'Claims Paid', kind: 'money' },
        ]
      : [
          { label: 'Channel', kind: 'text' }, { label: 'Policies', kind: 'number' }, { label: 'Lives', kind: 'number' },
          { label: 'Billed Premium', kind: 'money' }, { label: 'Collected', kind: 'money' },
          { label: 'Claims', kind: 'number' }, { label: 'Claims Paid', kind: 'money' },
        ]
    return {
      title: dataset === 'products' ? 'Product Performance' : 'Registrations by Channel',
      columns,
      rows: rows.map(b => {
        const key = [...buckets.entries()].find(([, v]) => v === b)![0]
        return dataset === 'products'
          ? [b.label, (data.products.find(p => p.id === key)?.category ?? '').replace(/_/g, ' '), b.policies, b.heads, MONEY(b.billed), MONEY(b.collected), b.claims, MONEY(b.claimsPaid)]
          : [b.label, b.policies, b.heads, MONEY(b.billed), MONEY(b.collected), b.claims, MONEY(b.claimsPaid)]
      }),
      stats: [
        { label: dataset === 'products' ? 'Products' : 'Channels', value: String(rows.length) },
        { label: 'Policies', value: String(rows.reduce((s, b) => s + b.policies, 0)) },
        { label: 'Billed', value: formatCell(rows.reduce((s, b) => s + b.billed, 0), 'money') },
        { label: 'Collected', value: formatCell(rows.reduce((s, b) => s + b.collected, 0), 'money') },
      ],
      chart: rows.map(b => ({ label: b.label, value: MONEY(b.billed) })),
      trend: monthlyTrend(applyFilters(facts.policies, f)),
    }
  }

  // — Detail datasets —
  const spec = {
    policies: { facts: facts.policies, columns: POLICY_COLUMNS, itemLabel: 'Policies', amountLabel: 'Billed Premium',
      row: (x: Fact) => policyRow(x.entity as Policy) },
    claims: { facts: facts.claims, columns: CLAIM_COLUMNS, itemLabel: 'Claims', amountLabel: 'Claimed',
      row: (x: Fact) => claimRow(x.entity as Claim, policyById, data) },
    payments: { facts: facts.payments, columns: PAYMENT_COLUMNS, itemLabel: 'Payments', amountLabel: 'Amount',
      row: (x: Fact) => paymentRow(x.entity as Payment, policyById, data) },
    clients: { facts: facts.clients, columns: CLIENT_COLUMNS, itemLabel: 'Clients', amountLabel: 'Policies',
      row: (x: Fact) => clientRow(x.entity as Client, data) },
  }[dataset] as {
    facts: Fact[]; columns: ReportColumn[]; itemLabel: string; amountLabel: string; row: (x: Fact) => (string | number)[]
  }

  const filtered = applyFilters(spec.facts, f)
  const totalAmount = filtered.reduce((s, x) => s + x.amount, 0)
  const totalHeads = filtered.reduce((s, x) => s + x.heads, 0)

  if (groupBy !== 'none') {
    const groups = new Map<string, Fact[]>()
    for (const x of filtered) {
      const key = groupKeyOf(x, groupBy)
      const arr = groups.get(key) ?? []
      arr.push(x)
      groups.set(key, arr)
    }
    const rows = [...groups.entries()]
      .map(([key, arr]) => [groupLabelOf(key, groupBy, data), arr.length, arr.reduce((s, x) => s + x.heads, 0), MONEY(arr.reduce((s, x) => s + x.amount, 0))])
      .sort((a, b) => (b[3] as number) - (a[3] as number) || String(a[0]).localeCompare(String(b[0])))
    return {
      title: `${cap(dataset)} Report — grouped ${GROUP_OPTIONS[dataset].find(g => g.value === groupBy)?.label.replace(/^By /, 'by ') ?? ''}`,
      columns: GROUPED_COLUMNS(spec.itemLabel, spec.amountLabel),
      rows,
      stats: detailStats(dataset, filtered, totalAmount, totalHeads),
      // Clients carry no money measure — chart their headcount instead of
      // an all-zero amount series.
      chart: rows.map(r => ({ label: String(r[0]), value: dataset === 'clients' ? r[1] as number : r[3] as number })),
      trend: monthlyTrend(filtered),
    }
  }

  const rows = filtered.map(x => spec.row(x))
  return {
    title: `${cap(dataset)} Report`,
    columns: spec.columns,
    rows,
    stats: detailStats(dataset, filtered, totalAmount, totalHeads),
    // An ungrouped detail list still deserves a picture — pick the natural
    // breakdown for each dataset rather than drawing nothing.
    chart: defaultBreakdown(dataset, filtered, data),
    trend: monthlyTrend(filtered),
  }
}

function cap(s: string) { return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ') }

function detailStats(dataset: ReportDataset, filtered: Fact[], totalAmount: number, totalHeads: number): { label: string; value: string }[] {
  switch (dataset) {
    case 'policies': {
      const active = filtered.filter(x => x.status === 'active').length
      return [
        { label: 'Policies', value: String(filtered.length) },
        { label: 'Lives Covered', value: String(totalHeads) },
        { label: 'Premium Billed', value: formatCell(totalAmount, 'money') },
        { label: 'Active', value: `${active} (${filtered.length ? Math.round((active / filtered.length) * 100) : 0}%)` },
      ]
    }
    case 'claims': {
      const paid = filtered.filter(x => x.status === 'paid')
      return [
        { label: 'Claims', value: String(filtered.length) },
        { label: 'Claimed', value: formatCell(totalAmount, 'money') },
        { label: 'Paid Out', value: formatCell(paid.reduce((s, x) => s + x.amount, 0), 'money') },
        { label: 'Paid', value: `${paid.length} of ${filtered.length}` },
      ]
    }
    case 'payments': {
      const completed = filtered.filter(x => x.status === 'completed')
      return [
        { label: 'Payments', value: String(filtered.length) },
        { label: 'Collected', value: formatCell(completed.reduce((s, x) => s + x.amount, 0), 'money') },
        { label: 'Pending', value: formatCell(filtered.filter(x => x.status === 'pending').reduce((s, x) => s + x.amount, 0), 'money') },
        { label: 'Failed', value: String(filtered.filter(x => x.status === 'failed').length) },
      ]
    }
    case 'clients': {
      const active = filtered.filter(x => x.status === 'active').length
      return [
        { label: 'Clients', value: String(filtered.length) },
        { label: 'Active', value: String(active) },
        { label: 'Policies Held', value: String(totalHeads) },
        { label: 'Agent-Referred', value: String(filtered.filter(x => x.agentId).length) },
      ]
    }
    default: return []
  }
}

/** The natural chart for an ungrouped detail report. */
function defaultBreakdown(dataset: ReportDataset, filtered: Fact[], data: ReportData): { label: string; value: number }[] {
  const by: GroupBy = dataset === 'policies' ? 'category'
    : dataset === 'claims' ? 'status'
    : dataset === 'payments' ? 'method'
    : 'status'
  const groups = new Map<string, number>()
  for (const x of filtered) {
    const key = groupKeyOf(x, by)
    groups.set(key, (groups.get(key) ?? 0) + (dataset === 'clients' ? 1 : x.amount || 1))
  }
  return [...groups.entries()]
    .map(([k, v]) => ({ label: groupLabelOf(k, by, data), value: MONEY(v) }))
    .sort((a, b) => b.value - a.value)
}

// Re-exported so the page doesn't need a second premium import.
export { policyBillablePremium }
