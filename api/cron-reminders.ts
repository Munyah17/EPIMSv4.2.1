import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { dispatchNotification } from './_lib/notify.js'
import { premiumReminderSms, policyLapsedSms, invoiceIssuedSms } from '../src/lib/smsText.js'
import { resolveSmsText, smsVarMoney } from '../src/lib/smsTemplates.js'

/**
 * Billing reminders, run on the server.
 *
 * These used to run only in the browser: src/lib/reminderEngine.ts starts an
 * hourly setInterval from App.tsx, so reminders, caution flags and
 * waiting-period activations happened only while a staff member happened to
 * have the app open on a screen somewhere. Close the last laptop and the
 * whole notification schedule silently stopped -- which is exactly what
 * "it works while we're building, then nothing happens when I go home"
 * looks like from the outside.
 *
 * Vercel Cron calls this once a day (see vercel.json). It is the same
 * schedule the browser engine implements:
 *
 *   R1   5 days before the last day of the month
 *   R2   1 day before
 *   R3   on the day            (+ SMS/WhatsApp to the client)
 *   O1–O3 days 1–3 after       (daily overdue notices)
 *   DEF  4 days after          (+ caution flag, policy pauses as
 *                               'defaulted' — an Admin/Super Admin or a
 *                               completed payment brings it back)
 *
 * Agriculture policies are skipped entirely: their premium is an annual
 * stop order paid by the sponsoring association, not monthly by the
 * farmer, so farmers get no billing reminders or lapse flags from this
 * run (they only hear from us at registration and on claims).
 *
 * Safe to run alongside the in-app checker: every send is guarded by a
 * dedup row in `reminders` keyed on policy + due date + stage, so whichever
 * runs first wins and the other stands down.
 */

// ── Dates ──────────────────────────────────────────────────────────

function lastDayOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0)
}

/** House date format, day-month-year with a named month, matching
 *  src/lib/dateUtils.ts. Restated here because a serverless function cannot
 *  import from the app bundle — and a bare toLocaleDateString() would
 *  follow whatever locale the server happens to run in, which is how a date
 *  ends up month-first. */
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
function formatDate(d: Date): string {
  return `${String(d.getDate()).padStart(2, '0')}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`
}

/** Whole days from `from` to `to`, comparing dates only. */
function daysDiff(from: Date, to: Date): number {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate())
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate())
  return Math.round((b.getTime() - a.getTime()) / 86400000)
}

type ReminderType = 'r1' | 'r2' | 'r3' | 'lapse'

const STAGE_TAG: Record<ReminderType, string> = {
  r1: '[R1]', r2: '[R2]', r3: '[R3]', lapse: '[LAPSE]',
}
const STAGE_LABEL: Record<ReminderType, string> = {
  r1: '1st Renewal Reminder (20th)',
  r2: '2nd Renewal Reminder (25th)',
  r3: '3rd Renewal Reminder (1st)',
  lapse: 'Policy Lapsed — grace period ended',
}

// ── Rows ───────────────────────────────────────────────────────────

interface PolicyRow {
  id: string
  policy_number: string
  client_id: string
  product_id: string
  premium: number
  status: string
  dependants: { premium?: number }[] | null
  agent_id: string | null
  clients: { name: string; email: string | null; phone: string | null } | null
  products: { name: string; category: string } | null
}

/**
 * What the policy actually bills for one period.
 *
 * Premiums are per head — the policyholder plus one for each dependant —
 * so a reminder must not quote the policyholder's own share and ask a
 * family of four to pay for one. Agriculture is billed once a year on the
 * crop, not per person. Mirrors src/lib/premium.ts.
 */
function billablePremium(policy: PolicyRow): number {
  const own = Number(policy.premium) || 0
  if (policy.products?.category === 'agriculture') return own
  const deps = policy.dependants ?? []
  const total = deps.reduce((sum, d) => {
    const p = Number(d?.premium)
    return sum + (Number.isFinite(p) && p > 0 ? p : own)
  }, own)
  return Math.round(total * 100) / 100
}

// ── Delivery ───────────────────────────────────────────────────────
// Everything goes through api/_lib/notify.ts — Afrosoft SMS, Graph/SMTP
// email, WhatsApp (Cloud API or a queued wa.me link) — and every attempt
// lands in notification_log, so a reminder that never arrived is a row
// to look up rather than a silent drop.

const SIGNATURE = 'Regards,\nMotions Microinsurance\nwww.motions.co.zw'

// ── Reminder bodies ────────────────────────────────────────────────

function clientEmailBody(policy: PolicyRow, type: ReminderType, due: string, amount: string): string {
  const name = policy.clients?.name ?? 'Client'
  const product = policy.products?.name ?? 'your policy'
  // The three renewal reminders carry the SAME message — only the lapse
  // notice differs.
  if (type === 'lapse') {
    return `Dear ${name},\n\nNOTICE: Your policy ${policy.policy_number} (${product}) has LAPSED.\n\nYour premium of $${amount}, due on ${due}, was not paid within the grace period (to the 10th). Cover is suspended and no claim can be paid while the policy is lapsed.\n\nYou can reinstate the policy by paying the outstanding premium — a lapse of more than 3 months closes the policy.\n\nPayment methods: EcoCash | Paynow | Zipit | Cash at office\n\n${SIGNATURE}`
  }
  return `Dear ${name},\n\nThis is a reminder that your insurance premium of $${amount} for policy ${policy.policy_number} (${product}) is due on ${due}.\n\nPlease pay by ${due} to keep your cover. You can pay via EcoCash, Paynow, Zipit, or at any of our offices.\n\n${SIGNATURE}`
}

/** The ONE reminder text — built by the shared builders in smsText.ts so
 *  the in-browser engine (src/lib/reminderEngine.ts) and this cron send a
 *  client byte-identical wording whichever fires first. A saved template
 *  (Bulk SMS → Templates) overrides it — the resolver itself is shared, so
 *  browser and cron still agree on whatever the current wording is. */
async function clientSmsBody(admin: SupabaseClient, policy: PolicyRow, type: ReminderType, dueDate: Date): Promise<string> {
  const input = {
    clientName: policy.clients?.name ?? 'Client',
    policyNumber: policy.policy_number,
    amount: billablePremium(policy),
    dueDate,
    clientPhone: policy.clients?.phone,
  }
  return resolveSmsText(admin, type === 'lapse' ? 'policy_lapsed' : 'premium_reminder', {
    productId: policy.product_id,
    vars: {
      clientName: input.clientName,
      policyNumber: policy.policy_number,
      productName: policy.products?.name ?? '',
      amount: smsVarMoney(input.amount),
      dueDate: formatDate(dueDate),
    },
    fallback: type === 'lapse' ? policyLapsedSms(input) : premiumReminderSms(input),
  })
}

// ── One policy ─────────────────────────────────────────────────────

interface RunStats { considered: number; sent: number; failed: number; flagged: number; skipped: number }

async function dispatch(
  admin: SupabaseClient, policy: PolicyRow, type: ReminderType, dueDate: Date, stats: RunStats,
) {
  const dueISO = dueDate.toISOString().split('T')[0]
  const tag = STAGE_TAG[type]

  // This row IS the dedup record. Checked before anything is sent so a
  // second run today — or the in-app checker — cannot re-send.
  const { data: already } = await admin
    .from('reminders')
    .select('id')
    .eq('policy_id', policy.id)
    .eq('due_date', dueISO)
    .like('message', `${tag}%`)
    .maybeSingle()
  if (already) { stats.skipped++; return }

  const amount = billablePremium(policy).toFixed(2)
  const dueLabel = formatDate(dueDate)
  const name = policy.clients?.name ?? 'Client'
  const product = policy.products?.name ?? 'policy'

  // Every stage, client and office, all three channels — and each attempt
  // is written to notification_log, so a failed send shows up on the
  // dashboard instead of pretending the run was clean.
  const smsBody = await clientSmsBody(admin, policy, type, dueDate)
  const deliveries = await dispatchNotification(admin, {
    event: 'renewal',
    ref: policy.policy_number,
    client: { name, phone: policy.clients?.phone, email: policy.clients?.email },
    smsText: smsBody,
    whatsappText: smsBody,
    emailSubject: type === 'lapse'
      ? `Notice: ${policy.policy_number} has LAPSED`
      : `Premium Reminder: ${policy.policy_number} due ${dueLabel}`,
    emailText: clientEmailBody(policy, type, dueLabel, amount) +
      `\n\n---\nOffice copy — policy ${policy.policy_number}, ${name}, ${product}, $${amount} due. Stage ${tag} ${STAGE_LABEL[type]}.`,
  })
  stats.sent += deliveries.filter(d => d.status === 'sent').length
  stats.failed += deliveries.filter(d => d.status === 'failed').length

  if (type === 'lapse') {
    await admin.from('caution_flags').upsert({
      policy_id: policy.id,
      policy_number: policy.policy_number,
      client_id: policy.client_id,
      client_name: policy.clients?.name ?? '',
      agent_id: policy.agent_id,
      days_overdue: 10,
      flagged_at: new Date().toISOString(),
      months_defaulted: 1,
      cleared: false,
    }, { onConflict: 'policy_id' })
    // Unpaid past the 10th's grace deadline lapses the policy; a
    // completed payment reinstates it through a fresh waiting period
    // (applyCompletedPaymentToPolicy), and an Admin can re-enable it.
    if (policy.status !== 'lapsed') {
      await admin.from('policies').update({ status: 'lapsed' }).eq('id', policy.id)
    }
    stats.flagged++
  }

  // The dedup row carries the verbatim SMS text too — the sent log shows
  // what the client's phone actually received, not just the stage tag.
  const reminderRow = {
    type: 'payment_due',
    client_id: policy.client_id,
    policy_id: policy.id,
    due_date: dueISO,
    message: `${tag} ${STAGE_LABEL[type]}: ${policy.policy_number}`,
    sent: true,
    channel: 'email',
  }
  const { error: insErr } = await admin.from('reminders')
    .insert({ ...reminderRow, sms_body: smsBody })
  if (insErr) {
    // sms_body missing (migration not run) — the dedup row still matters.
    await admin.from('reminders').insert(reminderRow)
  }
}

/** Lifts a non-agriculture policy out of its waiting period once 90 days
 *  have passed and payment is current. Agriculture activates on first
 *  payment instead, so it is excluded rather than auto-activated by date. */
async function liftWaitingPeriods(admin: SupabaseClient): Promise<number> {
  const { data } = await admin
    .from('policies')
    .select('id, start_date, next_payment_date, products!product_id(category)')
    .eq('status', 'waiting_period')
  const today = new Date()
  let lifted = 0
  for (const row of (data ?? []) as unknown as { id: string; start_date: string; next_payment_date: string | null; products: { category: string } | null }[]) {
    if (row.products?.category === 'agriculture') continue
    if (Math.round((today.getTime() - new Date(row.start_date).getTime()) / 86400000) < 90) continue
    if (row.next_payment_date && new Date(row.next_payment_date) < today) continue
    await admin.from('policies').update({ status: 'active' }).eq('id', row.id)
    lifted++
  }
  return lifted
}

/** Cover terms that have ended are swept to 'expired' — the archive
 *  state — so the active book only ever holds live cover (the whole
 *  tobacco book rolls off on 31 Aug when the season closes). Records
 *  stay intact and restorable from the Policies → Archive view. */
async function expireEndedTerms(admin: SupabaseClient): Promise<number> {
  const todayISO = new Date().toISOString().split('T')[0]
  const { data } = await admin
    .from('policies')
    .update({ status: 'expired' })
    .lt('end_date', todayISO)
    .in('status', ['active', 'waiting_period', 'lapsed', 'defaulted'])
    .select('id')
  return data?.length ?? 0
}

// ── Reconciliation: money/registration happened, record didn't ──────
//
// The website (and any channel) can leave partial work behind: a client
// row with no policy, a Paynow transaction that was initiated but never
// confirmed, a payment recorded on a policy that stayed 'pending'. Each
// is the signature of money collected with nothing to show for it — and
// each must be FOUND, not waited for a complaint. Runs inside the daily
// cron; every finding lands in notification_log (once per item — the ref
// carries its id, so an issue is reported once, not daily) and a single
// consolidated office email lists anything new.
//
// Nelson Mweeresani's paid-but-unregistered signup is exactly the first
// case this exists to catch.

async function reconcileBook(admin: SupabaseClient): Promise<{ orphanedClients: number; stalePaynow: number; paidButPending: number; reported: number }> {
  const cutoff = new Date(Date.now() - 24 * 3600e3).toISOString()
  const findings: { kind: string; ref: string; line: string }[] = []

  // 1. Client registered >24h ago with no policy at all.
  const { data: clients } = await admin.from('clients').select('id, name, phone, email, id_number, gender, dob, address, city, created_at').lt('created_at', cutoff)
  const { data: policyClientIds } = await admin.from('policies').select('client_id')
  const covered = new Set((policyClientIds ?? []).map(p => p.client_id))
  for (const c of clients ?? []) {
    if (covered.has(c.id)) continue
    // Fetch any pending dependants for this client
    const { data: deps } = await admin.from('dependants').select('name, relationship, dob, id_number').eq('client_id', c.id)
    const depList = deps && deps.length > 0 
      ? `\n  Dependants (${deps.length}): ${deps.map(d => `${d.name} (${d.relationship})`).join(', ')}` 
      : ''
    // Fetch any payments made by this client (to show if money was taken)
    const { data: payments } = await admin.from('payments').select('reference, amount, currency, status, created_at').eq('client_id', c.id).order('created_at', { ascending: false }).limit(5)
    const paymentList = payments && payments.length > 0
      ? `\n  Recent payments (${payments.length}): ${payments.map(p => `${p.currency} ${Number(p.amount).toFixed(2)} (${p.status}) - ${p.reference}`).join(', ')}`
      : ''
    // Determine likely cause based on payment history
    let likelyCause = 'Unknown - investigate registration flow'
    if (payments && payments.length > 0) {
      const hasCompleted = payments.some(p => p.status === 'completed')
      const hasFailed = payments.some(p => p.status === 'failed')
      if (hasCompleted) likelyCause = 'Payment completed but policy not issued - possible system error or activation failure'
      else if (hasFailed) likelyCause = 'Payment failed - client may have abandoned registration'
      else likelyCause = 'Payment pending - gateway issue or client cancelled'
    } else {
      likelyCause = 'No payment recorded - registration incomplete or abandoned'
    }
    const clientDetails = `Client: ${c.name}\n  ID: ${c.id_number ?? 'not provided'}\n  Phone: ${c.phone ?? 'not provided'}\n  Email: ${c.email ?? 'not provided'}\n  Gender: ${c.gender ?? 'not provided'}\n  DOB: ${c.dob ?? 'not provided'}\n  Address: ${c.address ?? 'not provided'}, ${c.city ?? 'not provided'}\n  Registered: ${new Date(c.created_at).toLocaleDateString('en-GB')}${depList}${paymentList}\n  Status: NO POLICY WRITTEN\n  Likely cause: ${likelyCause}\n  Action: Investigate before close of day`
    findings.push({ kind: 'orphaned_client', ref: c.id, line: clientDetails })
  }

  // 2. Paynow transaction initiated >24h ago, never confirmed or failed.
  const { data: stale } = await admin.from('paynow_transactions')
    .select('reference, policy_id, expected_amount, currency, created_at')
    .eq('status', 'pending').lt('created_at', cutoff)
  for (const t of stale ?? []) {
    findings.push({ kind: 'stale_paynow', ref: t.reference, line: `Paynow ref ${t.reference} (${t.currency} ${Number(t.expected_amount).toFixed(2)}, started ${new Date(t.created_at).toLocaleDateString('en-GB')}) never confirmed — check the gateway and reconcile against the payer.` })
  }

  // 3. A completed payment on a policy still 'pending' — money recorded,
  // cover never activated.
  const { data: paidPending } = await admin.from('policies')
    .select('id, policy_number, client_id, clients!client_id(name, phone)')
    .eq('status', 'pending')
  for (const p of (paidPending ?? []) as unknown as { id: string; policy_number: string; clients: { name: string; phone: string | null } | null }[]) {
    const { data: pays } = await admin.from('payments').select('reference, amount').eq('policy_id', p.id).eq('status', 'completed').limit(1)
    if (!pays?.length) continue
    findings.push({ kind: 'paid_but_pending', ref: p.id, line: `Policy ${p.policy_number} (${p.clients?.name ?? 'client'}) has a completed payment (${pays[0].reference}, $${Number(pays[0].amount).toFixed(2)}) but is still PENDING — activate or refund.` })
  }

  // Report each finding once — notification_log's ref carries the item's
  // id, so a second run sees it was already raised.
  let reported = 0
  const newLines: string[] = []
  for (const f of findings) {
    const { data: seen } = await admin.from('notification_log').select('id').eq('event', 'recon').eq('ref', f.ref).limit(1)
    if (seen?.length) continue
    await admin.from('notification_log').insert({ event: 'recon', channel: 'email', recipient: 'office', ref: f.ref, status: 'flagged', detail: `${f.kind}: ${f.line}` })
    newLines.push(`• ${f.line}`)
    reported++
  }

  if (newLines.length) {
    const body = `The daily reconciliation found ${newLines.length} NEW unmatched record(s) — money or registration may have happened with no corresponding policy:\n\n${newLines.join('\n')}\n\nAction: open Payments/Policies in the portal, find the reference, and either activate the policy or refund the payer. These stay flagged in notification_log until resolved.`
    await dispatchNotification(admin, {
      event: 'recon', ref: 'reconciliation',
      notifyClient: false, notifyOffice: true,
      smsText: `Motions: ${newLines.length} unreconciled record(s) found — possible paid-but-unregistered signup. Check email/portal.`,
      emailSubject: `[RECONCILIATION] ${newLines.length} unmatched record(s) — possible paid-but-unmatched`,
      emailText: body,
    }).catch(e => console.error('cron-reminders: recon notify failed', e))
  }

  return {
    orphanedClients: findings.filter(f => f.kind === 'orphaned_client').length,
    stalePaynow: findings.filter(f => f.kind === 'stale_paynow').length,
    paidButPending: findings.filter(f => f.kind === 'paid_but_pending').length,
    reported,
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Fail closed:
  // this endpoint emails and texts the entire book, so an unset secret must
  // refuse everyone rather than admit everyone. Guarding only when the
  // variable happened to exist left it wide open on any deployment built
  // before it was set.
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return res.status(503).json({ error: 'CRON_SECRET is not configured, so this endpoint is disabled.' })
  }
  if (req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: 'Server is not configured.' })
  const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

  const today = new Date()
  // Zimbabwe keeps UTC+2 year-round — the reminder calendar (20th, 25th,
  // 1st, 10th) and the 08:00–16:00 send window are local business days,
  // not whatever the server's clock is.
  const zw = new Date(today.getTime() + 2 * 3600e3)
  const zwDay = zw.getUTCDate()
  const zwHour = zw.getUTCHours()

  const lifted = await liftWaitingPeriods(admin)
  const expired = await expireEndedTerms(admin)
  const invoiced = await issueMonthlyInvoices(admin, today)
  const recon = await reconcileBook(admin).catch(e => { console.error('cron-reminders: recon failed', e); return null })

  const type: ReminderType | null =
    zwDay === 20 ? 'r1' : zwDay === 25 ? 'r2' : zwDay === 1 ? 'r3' : zwDay === 10 ? 'lapse' : null

  if (!type) {
    return res.status(200).json({ ran: today.toISOString(), stage: null, note: 'No reminder stage falls on today.', waitingPeriodsLifted: lifted, policiesExpired: expired, invoices: invoiced, recon })
  }
  // Reminders are client-facing — only ever inside 08:00–16:00 ZW.
  if (zwHour < 8 || zwHour >= 16) {
    return res.status(200).json({ ran: today.toISOString(), stage: `${STAGE_TAG[type]} ${STAGE_LABEL[type]}`, note: `Outside the 08:00–16:00 send window (ZW ${String(zwHour).padStart(2, '0')}:00) — client texts suppressed; office jobs still ran.`, waitingPeriodsLifted: lifted, policiesExpired: expired, invoices: invoiced, recon })
  }

  // What the reminder is about: on the 20th/25th the renewal due the 1st
  // of NEXT month; on the 1st and the 10th, this month's own premium.
  const dueDate = new Date(zw.getUTCFullYear(), zw.getUTCMonth() + (zwDay >= 20 ? 1 : 0), 1)
  const dueISO = dueDate.toISOString().split('T')[0]
  const todayISO = `${zw.getUTCFullYear()}-${String(zw.getUTCMonth() + 1).padStart(2, '0')}-${String(zwDay).padStart(2, '0')}`

  const { data, error } = await admin
    .from('policies')
    .select('id, policy_number, client_id, product_id, premium, status, dependants, agent_id, next_payment_date, clients!client_id(name, email, phone), products!product_id(name, category)')
    .in('status', ['active', 'waiting_period', 'defaulted'])
  if (error) {
    console.error('cron-reminders: policy query failed', error.message)
    return res.status(500).json({ error: 'Could not load policies for the reminder run.' })
  }

  // Only the unpaid hear from us — next_payment_date says the date cover
  // is paid THROUGH, so anything past the due date means the period is
  // already settled and the policyholder gets nothing but their payment
  // confirmation.
  const policies = ((data ?? []) as unknown as (PolicyRow & { next_payment_date: string | null })[])
    .filter(p => p.products?.category !== 'agriculture')
    // Reminders: still owes the period ending at the due date. Lapse: the
    // premium was due before today — the grace window to the 10th closed.
    .filter(p => p.next_payment_date
      ? (type === 'lapse' ? p.next_payment_date < todayISO : p.next_payment_date <= dueISO)
      : true)
  const stats: RunStats = { considered: policies.length, sent: 0, failed: 0, flagged: 0, skipped: 0 }

  for (const policy of policies) {
    try {
      await dispatch(admin, policy, type, dueDate, stats)
    } catch (e) {
      // One bad policy must not abandon the rest of the book.
      console.error('cron-reminders: policy failed', policy.policy_number, e)
    }
  }

  return res.status(200).json({
    ran: today.toISOString(),
    stage: `${STAGE_TAG[type]} ${STAGE_LABEL[type]}`,
    dueDate: dueDate.toISOString().split('T')[0],
    waitingPeriodsLifted: lifted,
    policiesExpired: expired,
    invoices: invoiced,
    recon,
    ...stats,
  })
}

// ── Monthly group-policy invoices ─────────────────────────────────
//
// Corporate/group/team policies are billed to the organisation's roster —
// N members × their premium, the org itself is not a charged head. The
// cron issues this month's invoice for every live group policy; the
// (policy_id, period) unique index makes the run idempotent, so it can
// run every day and only the first insert lands.
//
// Group rows do NOT share billablePremium()'s holder+dependants total —
// that function counts the policyholder as a head, and an organisation is
// not one. Members only:

function groupBillable(policy: PolicyRow): { heads: number; amount: number } {
  const own = Number(policy.premium) || 0
  const deps = policy.dependants ?? []
  const amount = Math.round(deps.reduce((sum, d) => {
    const p = Number(d?.premium)
    return sum + (Number.isFinite(p) && p > 0 ? p : own)
  }, 0) * 100) / 100
  return { heads: deps.length, amount }
}

async function issueMonthlyInvoices(admin: SupabaseClient, today: Date) {
  const stats = { issued: 0, skipped: 0, failed: 0 }
  const period = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`
  const dueDate = lastDayOfMonth(today).toISOString().split('T')[0]

  const { data, error } = await admin
    .from('policies')
    .select('id, policy_number, client_id, product_id, premium, status, dependants, agent_id, cover_scope, group_id, clients!client_id(name, email, phone), products!product_id(name, category), groups!group_id(name, contact_name, contact_phone, contact_email)')
    .in('status', ['active', 'waiting_period'])
    .not('cover_scope', 'is', null)
    .neq('cover_scope', 'individual')
  if (error) {
    // cover_scope predates the group-cover migration on some databases —
    // log and skip rather than fail the whole reminder run.
    console.error('cron-reminders: invoice query failed', error.message)
    return stats
  }

  const groupPolicies = (data ?? []) as unknown as Array<PolicyRow & { cover_scope: string; group_id: string | null; groups: { name: string; contact_name: string | null; contact_phone: string | null; contact_email: string | null } | null }>

  // Sequence runs off the highest number already issued this period.
  const { data: lastRows } = await admin
    .from('invoices')
    .select('invoice_number')
    .like('invoice_number', `INV-${period.replace('-', '')}-%`)
    .order('invoice_number', { ascending: false })
    .limit(1)
  let seq = Number(((lastRows?.[0]?.invoice_number ?? '').match(/-(\d+)$/)?.[1]) ?? 0)

  for (const policy of groupPolicies) {
    try {
      const { heads, amount } = groupBillable(policy)
      if (heads === 0 || amount <= 0) { stats.skipped++; continue }

      // Already issued? The unique index says so before we write anything.
      const { data: existing } = await admin
        .from('invoices').select('id').eq('policy_id', policy.id).eq('period', period)
        .neq('status', 'cancelled').maybeSingle()
      if (existing) { stats.skipped++; continue }

      seq++
      const invoiceNumber = `INV-${period.replace('-', '')}-${String(seq).padStart(3, '0')}`
      const { error: insErr } = await admin.from('invoices').insert({
        invoice_number: invoiceNumber,
        policy_id: policy.id, client_id: policy.client_id, group_id: policy.group_id,
        period, heads, amount, due_date: dueDate, created_by: 'cron',
      })
      if (insErr) {
        if (insErr.code === '23505') { stats.skipped++; seq--; continue }
        console.error('cron-reminders: invoice insert failed', policy.policy_number, insErr.message)
        stats.failed++
        continue
      }
      stats.issued++

      // The organisation hears about its bill on every channel — same rule
      // as every billing event: nothing financial is silent.
      const org = policy.groups?.name ?? policy.clients?.name ?? 'Client'
      const sms = await resolveSmsText(admin, 'invoice_issued', {
        productId: policy.product_id,
        vars: {
          orgName: org,
          policyNumber: policy.policy_number,
          invoiceNumber,
          amount: smsVarMoney(amount),
          heads,
          billingPeriod: period,
          dueDate: formatDate(lastDayOfMonth(today)),
        },
        fallback: invoiceIssuedSms({
          orgName: org, policyNumber: policy.policy_number, invoiceNumber,
          amount, heads, period, dueDate: lastDayOfMonth(today),
          clientPhone: policy.clients?.phone,
        }),
      })
      await dispatchNotification(admin, {
        event: 'payment',
        ref: invoiceNumber,
        client: { name: policy.clients?.name, phone: policy.clients?.phone, email: policy.clients?.email },
        smsText: sms,
        whatsappText: sms,
        emailSubject: `Invoice ${invoiceNumber}: ${org} — ${period}`,
        emailText: `Dear ${policy.clients?.name ?? 'Client'},\n\nYour monthly insurance invoice has been issued.\n\nInvoice:      ${invoiceNumber}\nPolicy:       ${policy.policy_number}\nOrganisation: ${org}\nPeriod:       ${period}\nMembers:      ${heads}\nAmount:       $${amount.toFixed(2)}\nDue date:     ${formatDate(lastDayOfMonth(today))}\n\nPlease arrange payment before the due date to keep cover in force.\n\n${SIGNATURE}`,
      })

      // The organisation's named contact person gets the reminder on their
      // own line — the account-holder record and the person who actually
      // pays the invoice are often different people in a company. Same
      // message, no second office alert, and skipped when the contact is
      // the same person (same phone/email) as the account holder.
      const contact = policy.groups
      if (contact && (contact.contact_phone || contact.contact_email)) {
        const samePhone = !!contact.contact_phone && contact.contact_phone.replace(/\D/g, '').slice(-9) === (policy.clients?.phone ?? '').replace(/\D/g, '').slice(-9)
        const sameEmail = !!contact.contact_email && contact.contact_email.toLowerCase() === (policy.clients?.email ?? '').toLowerCase()
        if (!samePhone || !sameEmail) {
          await dispatchNotification(admin, {
            event: 'payment',
            ref: invoiceNumber,
            client: {
              name: contact.contact_name ?? `${org} accounts`,
              phone: samePhone ? null : contact.contact_phone,
              email: sameEmail ? null : contact.contact_email,
            },
            notifyOffice: false,
            smsText: sms,
            whatsappText: sms,
            emailSubject: `Invoice ${invoiceNumber}: ${org} — ${period}`,
            emailText: `Dear ${contact.contact_name ?? 'Sir/Madam'},\n\nAn invoice for ${org}'s group insurance has been issued.\n\nInvoice:      ${invoiceNumber}\nPolicy:       ${policy.policy_number}\nOrganisation: ${org}\nPeriod:       ${period}\nMembers:      ${heads}\nAmount:       $${amount.toFixed(2)}\nDue date:     ${formatDate(lastDayOfMonth(today))}\n\nPlease arrange payment before the due date to keep cover in force.\n\n${SIGNATURE}`,
          })
        }
      }
    } catch (e) {
      console.error('cron-reminders: invoice failed for', policy.policy_number, e)
      stats.failed++
    }
  }
  return stats
}
