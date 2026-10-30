import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from './paged.js'

/**
 * Staff-editable SMS templates for automatic notifications.
 *
 * Where a notification text used to be set in stone inside smsText.ts,
 * a row in `sms_templates` can now override it — per notification type,
 * and optionally per product. Resolution order for every send:
 *
 *   1. active template for (event_type, product_id) — the product's own
 *   2. active template for (event_type, NULL)       — the type default
 *   3. the built-in smsText.ts builder              — unchanged wording
 *
 * Deliberately import-free at runtime (like smsText.ts): api/ serverless
 * functions consume this file too, so it cannot pull in browser modules.
 * The Supabase client is passed in by the caller — `supabase` in the app,
 * the service client in api/ functions.
 */

export type SmsTemplateEvent =
  | 'registration_confirmation'
  | 'client_registered'
  | 'group_registered'
  | 'payment_received'
  | 'payment_failed'
  | 'premium_reminder'
  | 'policy_lapsed'
  | 'invoice_issued'
  | 'claim_update'
  | 'ticket_update'

/** The shape of a row in public.sms_templates (snake_case, as stored). */
export interface SmsTemplateRow {
  id: string
  event_type: SmsTemplateEvent
  /** NULL means "this notification type, any product". */
  product_id: string | null
  body: string
  active: boolean
  created_at?: string
  updated_at?: string
}

export type SmsTemplateVars = Record<string, string | number | null | undefined>

export interface SmsTemplateEventDef {
  event: SmsTemplateEvent
  label: string
  /** The current standard wording with placeholders in place — what the
   *  "Add template" form pre-fills, so staff start from approved text
   *  rather than a blank box. */
  defaultBody: string
  /** Placeholders this event actually provides — the only names that may
   *  appear in the body. Saving anything else is refused, because a
   *  typo'd {polcyNumber} would otherwise ship to clients silently
   *  rendering as nothing. */
  vars: { name: string; hint: string }[]
  /** Fills the live preview in the editor. */
  sample: Record<string, string>
}

/** "$105" / "$12.50" — whole amounts drop ".00" (segment space), matching
 *  the private smsMoney in smsText.ts. Exported for callers assembling
 *  vars; pass PRE-FORMATTED strings for money values. */
export function smsVarMoney(amount: number): string {
  const n = Number(amount || 0)
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`
}

const V = {
  clientName: { name: 'clientName', hint: 'The person being texted' },
  policyNumber: { name: 'policyNumber', hint: 'e.g. FCP0012' },
  productName: { name: 'productName', hint: 'e.g. Funeral Cash Plan' },
  coverAmount: { name: 'coverAmount', hint: 'e.g. $5,000' },
  coverLine: { name: 'coverLine', hint: 'Field To Floor: "Barn Fire $500, …"; else the cover amount' },
  coverClause: { name: 'coverClause', hint: 'Whole clause — "Cover: Barn Fire $500, …" or "Cover $5,000"' },
  premium: { name: 'premium', hint: 'e.g. $105' },
  period: { name: 'period', hint: 'e.g. /yr or /mo' },
  premiumWithPeriod: { name: 'premiumWithPeriod', hint: 'e.g. $105/yr' },
  paymentMethod: { name: 'paymentMethod', hint: 'e.g. Paynow' },
  amount: { name: 'amount', hint: 'The money figure for this notice' },
  method: { name: 'method', hint: 'How the money moved' },
  reference: { name: 'reference', hint: 'Payment reference' },
  dueDate: { name: 'dueDate', hint: 'e.g. 01-NOV-2026' },
  claimNumber: { name: 'claimNumber', hint: 'e.g. CLM0042' },
  claimStatus: { name: 'claimStatus', hint: 'Current claim status' },
  event: { name: 'event', hint: 'What happened, e.g. claim submitted' },
  detail: { name: 'detail', hint: 'Extra context, when present' },
  ticketNumber: { name: 'ticketNumber', hint: 'e.g. TKT0017' },
  subject: { name: 'subject', hint: 'The ticket subject line' },
  orgName: { name: 'orgName', hint: 'The organisation' },
  contactName: { name: 'contactName', hint: 'Named contact person' },
  contactPhone: { name: 'contactPhone', hint: 'Their phone number' },
  kind: { name: 'kind', hint: 'The group cover type' },
  invoiceNumber: { name: 'invoiceNumber', hint: 'e.g. INV-202610-003' },
  heads: { name: 'heads', hint: 'Members billed on the invoice' },
  billingPeriod: { name: 'billingPeriod', hint: 'e.g. 2026-10' },
} as const

export const SMS_TEMPLATE_EVENTS: SmsTemplateEventDef[] = [
  {
    event: 'registration_confirmation',
    label: 'Registration Confirmation (policy issued)',
    defaultBody: '{clientName} {policyNumber}. {productName}. {coverClause}. {paymentMethod} {premiumWithPeriod}',
    vars: [V.clientName, V.policyNumber, V.productName, V.coverAmount, V.coverLine, V.coverClause, V.premium, V.period, V.premiumWithPeriod, V.paymentMethod],
    sample: { clientName: 'Demo User', policyNumber: 'FCP0012', productName: 'Funeral Cash Plan', coverAmount: '$5,000', coverLine: '$5,000', coverClause: 'Cover $5,000', premium: '$10', period: '/mo', premiumWithPeriod: '$10/mo.', paymentMethod: 'EcoCash' },
  },
  {
    event: 'client_registered',
    label: 'Client Registered (no policy yet)',
    defaultBody: '{clientName}. No policy yet. Agent will contact you.',
    vars: [V.clientName],
    sample: { clientName: 'Demo User' },
  },
  {
    event: 'group_registered',
    label: 'Group / Organisation Registered',
    defaultBody: '{orgName} {kind} cover. {contactName} {contactPhone}',
    vars: [V.orgName, V.kind, V.contactName, V.contactPhone],
    sample: { orgName: 'Acme Farm', kind: 'company', contactName: 'J. Moyo', contactPhone: '263780086175' },
  },
  {
    event: 'payment_received',
    label: 'Payment Received',
    defaultBody: '{clientName} {policyNumber} paid. {amount} via {method}. Ref {reference}.',
    vars: [V.clientName, V.policyNumber, V.amount, V.method, V.reference],
    sample: { clientName: 'Demo User', policyNumber: 'FCP0012', amount: '$105', method: 'Paynow', reference: 'PAY-8F3K2' },
  },
  {
    event: 'payment_failed',
    label: 'Payment Failed',
    defaultBody: '{clientName} {policyNumber} payment failed. {amount} via {method}. Try again.',
    vars: [V.clientName, V.policyNumber, V.amount, V.method, V.reference],
    sample: { clientName: 'Demo User', policyNumber: 'FCP0012', amount: '$105', method: 'EcoCash', reference: '' },
  },
  {
    event: 'premium_reminder',
    label: 'Premium Due Reminder (R1–R3)',
    defaultBody: '{clientName} {policyNumber} premium {amount} due {dueDate}. Pay to keep cover.',
    vars: [V.clientName, V.policyNumber, V.productName, V.amount, V.dueDate],
    sample: { clientName: 'Demo User', policyNumber: 'FCP0012', productName: 'Funeral Cash Plan', amount: '$105', dueDate: '01-NOV-2026' },
  },
  {
    event: 'policy_lapsed',
    label: 'Policy Lapsed (grace period ended)',
    defaultBody: '{clientName} {policyNumber} LAPSED. {amount} due {dueDate} unpaid. Pay to reinstate.',
    vars: [V.clientName, V.policyNumber, V.productName, V.amount, V.dueDate],
    sample: { clientName: 'Demo User', policyNumber: 'FCP0012', productName: 'Funeral Cash Plan', amount: '$105', dueDate: '01-OCT-2026' },
  },
  {
    event: 'invoice_issued',
    label: 'Group Invoice Issued',
    defaultBody: '{orgName} {policyNumber} invoice {invoiceNumber} issued. {amount} for {heads} member(s), period {billingPeriod}, due {dueDate}.',
    vars: [V.orgName, V.policyNumber, V.invoiceNumber, V.amount, V.heads, V.billingPeriod, V.dueDate],
    sample: { orgName: 'Acme Ltd', policyNumber: 'GRP0004', invoiceNumber: 'INV-202610-003', amount: '$420', heads: '12', billingPeriod: '2026-10', dueDate: '31-OCT-2026' },
  },
  {
    event: 'claim_update',
    label: 'Claim Update (any stage)',
    defaultBody: '{clientName} {claimNumber} {event}.',
    vars: [V.clientName, V.claimNumber, V.policyNumber, V.productName, V.event, V.detail, V.amount, V.claimStatus],
    sample: { clientName: 'Demo User', claimNumber: 'CLM0042', policyNumber: 'FCP0012', productName: 'Funeral Cash Plan', event: 'claim approved', detail: '', amount: '$5,000', claimStatus: 'approved' },
  },
  {
    event: 'ticket_update',
    label: 'Support Ticket Update',
    defaultBody: '{clientName} {ticketNumber} {event}. {detail}.',
    vars: [V.clientName, V.ticketNumber, V.event, V.detail, V.subject],
    sample: { clientName: 'Demo User', ticketNumber: 'TKT0017', event: 'ticket replied', detail: 'Check email', subject: 'Policy query' },
  },
]

export function smsTemplateEventDef(event: SmsTemplateEvent): SmsTemplateEventDef {
  return SMS_TEMPLATE_EVENTS.find(d => d.event === event) as SmsTemplateEventDef
}

// ── Placeholders ────────────────────────────────────────────────────

const PLACEHOLDER_RE = /\{([A-Za-z][A-Za-z0-9_]*)\}/g

export function extractPlaceholders(body: string): string[] {
  const out: string[] = []
  for (const m of body.matchAll(PLACEHOLDER_RE)) if (!out.includes(m[1])) out.push(m[1])
  return out
}

/** Placeholder names in the body that this event does NOT provide.
 *  Saving is refused on any hit — a typo would ship a broken text. */
export function unknownPlaceholders(event: SmsTemplateEvent, body: string): string[] {
  const known = new Set(smsTemplateEventDef(event).vars.map(v => v.name))
  return extractPlaceholders(body).filter(name => !known.has(name))
}

/**
 * Substitutes {placeholders} with the caller's values. A name this event
 * does not know renders as nothing (already blocked at save time — this
 * is only the belt to that suspenders), and the empty string a missing
 * value leaves behind is cleaned up so " paid. " never reads "  paid.".
 */
export function renderSmsTemplate(body: string, vars: SmsTemplateVars): string {
  const known = new Set(Object.keys(vars))
  return body
    .replace(PLACEHOLDER_RE, (_, name: string) => (known.has(name) ? String(vars[name] ?? '') : ''))
    .replace(/\s+([.,!?;:])/g, '$1')       // "name ." -> "name."
    .replace(/\(\s*\)/g, '')               // "()" left by an empty value
    .replace(/\.\s*\./g, '.')              // "a. ." -> "a."
    .replace(/\.{2,}/g, '.')               // "a.." -> "a."
    .replace(/ {2,}/g, ' ')
    .trim()
}

/** Picks the template that governs a send: the product's own first, then
 *  the type-wide default. Inactive rows are ignored by the caller's
 *  query, but filtered again so this stays correct if reused on raw rows. */
export function selectSmsTemplate(
  rows: Pick<SmsTemplateRow, 'event_type' | 'product_id' | 'body' | 'active'>[],
  event: SmsTemplateEvent,
  productId?: string | null,
): string | null {
  const candidates = rows.filter(r => r.event_type === event && r.active !== false)
  const own = productId ? candidates.find(r => r.product_id === productId) : undefined
  return (own ?? candidates.find(r => r.product_id === null))?.body ?? null
}

// ── Resolution with a short cache ───────────────────────────────────
// Templates change rarely; sends are frequent. One fetch per minute per
// tab/worker instead of one per text. invalidateSmsTemplateCache() is
// called by the Templates page after every save so an edit takes effect
// on the very next send.

const CACHE_TTL_MS = 60_000
let cache: { rows: Pick<SmsTemplateRow, 'event_type' | 'product_id' | 'body' | 'active'>[]; fetchedAt: number } | null = null
let inflight: Promise<void> | null = null

export function invalidateSmsTemplateCache(): void {
  cache = null
}

async function ensureTemplateRows(client: SupabaseClient): Promise<void> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const { data, error } = await fetchAllRows(
        () => client
          .from('sms_templates')
          .select('id, event_type, product_id, body, active'),
        { orderBy: 'id' },
      )
      // A missing table (migration not applied yet) reads as "no
      // templates" — the fallback wording keeps every send working.
      cache = { rows: error ? [] : (data ?? []), fetchedAt: Date.now() }
    } catch {
      cache = { rows: [], fetchedAt: Date.now() }
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/**
 * The text to actually send: a matching template rendered with `vars`,
 * or `fallback` untouched when none exists — or on ANY failure, because
 * a template lookup hiccup must never stop a notification going out.
 *
 * Pass `productId` whenever the caller knows it so product-specific
 * templates win; callers without one still get the type default.
 */
export async function resolveSmsText(
  client: SupabaseClient | null,
  event: SmsTemplateEvent,
  opts: { productId?: string | null; vars: SmsTemplateVars; fallback: string },
): Promise<string> {
  try {
    if (!client) return opts.fallback
    await ensureTemplateRows(client)
    const body = selectSmsTemplate(cache?.rows ?? [], event, opts.productId)
    return body ? renderSmsTemplate(body, opts.vars) : opts.fallback
  } catch {
    return opts.fallback
  }
}
