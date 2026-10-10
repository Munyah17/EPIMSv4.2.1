import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { dispatchNotification } from './_lib/notify.js'

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

type ReminderType = 'r1_pre5' | 'r2_pre1' | 'r3_due' | 'o1' | 'o2' | 'o3' | 'default'

const STAGE_TAG: Record<ReminderType, string> = {
  r1_pre5: '[R1]', r2_pre1: '[R2]', r3_due: '[R3]', o1: '[O1]', o2: '[O2]', o3: '[O3]', default: '[DEF]',
}
const STAGE_LABEL: Record<ReminderType, string> = {
  r1_pre5: '5-Day Pre-Due Reminder',
  r2_pre1: '1-Day Pre-Due Reminder',
  r3_due: 'Due Date Reminder',
  o1: '1 Day Overdue',
  o2: '2 Days Overdue',
  o3: '3 Days Overdue',
  default: 'OVERDUE: Policy Defaulted & Paused',
}
/** Overdue day count for O stages — used in the messages themselves. */
const OVERDUE_DAYS: Partial<Record<ReminderType, number>> = { o1: 1, o2: 2, o3: 3 }

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
  switch (type) {
    case 'r1_pre5': return `Dear ${name},\n\nThis is a friendly reminder that your insurance premium of $${amount} for policy ${policy.policy_number} (${product}) is due in 5 days on ${due}.\n\nPlease ensure your payment is ready to avoid any lapse in cover.\n\n${SIGNATURE}`
    case 'r2_pre1': return `Dear ${name},\n\nURGENT REMINDER: Your insurance premium of $${amount} for policy ${policy.policy_number} is due TOMORROW, ${due}.\n\nPlease pay immediately to maintain active coverage. You can pay via EcoCash, Paynow, Zipit, or at any of our offices.\n\n${SIGNATURE}`
    case 'r3_due': return `Dear ${name},\n\nYour insurance premium of $${amount} for policy ${policy.policy_number} is DUE TODAY, ${due}.\n\nFailure to pay today may result in your policy lapsing. Please pay now to avoid disruption to your coverage.\n\nPayment methods: EcoCash | Paynow | Zipit | Cash at office\n\n${SIGNATURE}`
    case 'o1': case 'o2': case 'o3': {
      const n = OVERDUE_DAYS[type]
      return `Dear ${name},\n\nOVERDUE NOTICE (${n} day${n! > 1 ? 's' : ''}): Your insurance premium of $${amount} for policy ${policy.policy_number} was due on ${due} and remains unpaid.\n\nYour policy will be PAUSED (defaulted) if payment is not received within 4 days of the due date. Please pay now to keep your cover.\n\nPayment methods: EcoCash | Paynow | Zipit | Cash at office\n\n${SIGNATURE}`
    }
    case 'default': return `Dear ${name},\n\nNOTICE OF OVERDUE PREMIUM: POLICY PAUSED (DEFAULTED)\n\nYour insurance premium for policy ${policy.policy_number} (${product}) was due on ${due} and remains unpaid — 4 days overdue.\n\nYour policy has been moved to DEFAULTED status and is paused. Claims submitted now will not be processed. Please settle $${amount} immediately — payment or an administrator can re-enable your policy.\n\nPayment methods: EcoCash | Paynow | Zipit | Cash at office\n\n${SIGNATURE}`
  }
}

function clientSmsBody(policy: PolicyRow, type: ReminderType, due: string, amount: string): string {
  const n = OVERDUE_DAYS[type] ?? 0
  switch (type) {
    case 'r1_pre5': return `Motions: Premium of $${amount} for policy ${policy.policy_number} is due in 5 days on ${due}.`
    case 'r2_pre1': return `Motions: URGENT - Premium of $${amount} for policy ${policy.policy_number} is due TOMORROW.`
    case 'r3_due': return `Motions: Premium of $${amount} for policy ${policy.policy_number} is DUE TODAY. Pay now via EcoCash/Paynow to keep your coverage active.`
    case 'o1': case 'o2': case 'o3': return `Motions: Policy ${policy.policy_number} is ${n} day${n > 1 ? 's' : ''} overdue — $${amount} unpaid. It pauses on day 4. Pay now via EcoCash/Paynow.`
    case 'default': return `Motions: Policy ${policy.policy_number} is 4 days overdue and is now PAUSED (defaulted). Pay $${amount} to reinstate your cover.`
  }
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
  const deliveries = await dispatchNotification(admin, {
    event: 'renewal',
    ref: policy.policy_number,
    client: { name, phone: policy.clients?.phone, email: policy.clients?.email },
    smsText: clientSmsBody(policy, type, dueLabel, amount),
    whatsappText: clientSmsBody(policy, type, dueLabel, amount),
    emailSubject: type === 'default'
      ? `Overdue Notice: ${policy.policy_number} PAUSED (Defaulted)`
      : `Premium Reminder: ${policy.policy_number} due ${dueLabel}`,
    emailText: clientEmailBody(policy, type, dueLabel, amount) +
      `\n\n---\nOffice copy — policy ${policy.policy_number}, ${name}, ${product}, $${amount} due. Stage ${tag} ${STAGE_LABEL[type]}.`,
  })
  stats.sent += deliveries.filter(d => d.status === 'sent').length
  stats.failed += deliveries.filter(d => d.status === 'failed').length

  if (type === 'default') {
    await admin.from('caution_flags').upsert({
      policy_id: policy.id,
      policy_number: policy.policy_number,
      client_id: policy.client_id,
      client_name: policy.clients?.name ?? '',
      agent_id: policy.agent_id,
      days_overdue: 4,
      flagged_at: new Date().toISOString(),
      months_defaulted: 1,
      cleared: false,
    }, { onConflict: 'policy_id' })
    // Four days past due pauses the policy as 'defaulted'; a completed
    // payment reinstates it to a fresh waiting period, and an Admin or
    // Super Admin can re-enable it from Policies.
    if (policy.status !== 'defaulted') {
      await admin.from('policies').update({ status: 'defaulted' }).eq('id', policy.id)
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
    .insert({ ...reminderRow, sms_body: clientSmsBody(policy, type, dueLabel, amount) })
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
  const dueDate = lastDayOfMonth(today)
  const daysToLast = daysDiff(today, dueDate)

  const type: ReminderType | null =
    daysToLast === 5 ? 'r1_pre5'
    : daysToLast === 1 ? 'r2_pre1'
    : daysToLast === 0 ? 'r3_due'
    : daysToLast === -1 ? 'o1'
    : daysToLast === -2 ? 'o2'
    : daysToLast === -3 ? 'o3'
    : daysToLast === -4 ? 'default'
    : null

  const lifted = await liftWaitingPeriods(admin)
  const invoiced = await issueMonthlyInvoices(admin, today)

  if (!type) {
    return res.status(200).json({ ran: today.toISOString(), stage: null, note: 'No reminder stage falls on today.', waitingPeriodsLifted: lifted, invoices: invoiced })
  }

  const { data, error } = await admin
    .from('policies')
    .select('id, policy_number, client_id, product_id, premium, status, dependants, agent_id, clients!client_id(name, email, phone), products!product_id(name, category)')
    .in('status', ['active', 'waiting_period'])
  if (error) {
    console.error('cron-reminders: policy query failed', error.message)
    return res.status(500).json({ error: 'Could not load policies for the reminder run.' })
  }

  const policies = ((data ?? []) as unknown as PolicyRow[])
    .filter(p => p.products?.category !== 'agriculture')
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
    invoices: invoiced,
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
      const sms = `Motions: Invoice ${invoiceNumber} issued for ${org} (${policy.policy_number}) — $${amount.toFixed(2)} for ${heads} member(s), period ${period}, due ${formatDate(lastDayOfMonth(today))}.`
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
