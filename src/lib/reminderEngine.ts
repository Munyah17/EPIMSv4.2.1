/**
 * Billing Reminder Engine
 *
 * Premiums are due on the 1st of each month. Reminder schedule (the same
 * calendar api/cron-reminders.ts runs):
 *   R1: 20th of the month
 *   R2: 25th of the month (same message)
 *   R3: 1st of the next month (same message)
 *   Lapse notice: 10th — unpaid policies lapse after the grace window
 * Client texts only ever go out between 08:00 and 16:00 local time, and
 * only to policies that have not paid — nextPaymentDate past the due
 * date means the period is already settled and the holder hears nothing
 * but their payment confirmation.
 *
 * Agriculture is out of scope: its premium is a once-a-year stop order
 * settled by the farmer's association, so a monthly "your premium is due"
 * text to the farmer would be wrong twice over -- wrong cadence, wrong
 * payer. Farmers are contacted only when a policy is registered for them
 * and when a claim moves.
 *
 * Runs client-side (hourly, from whichever staff member has the app open)
 * against real policies/clients. Dedup is tracked in the `reminders` table
 * itself (not localStorage) so it holds regardless of how many staff
 * browsers are open at once — otherwise each one would independently
 * re-send the same reminder. For guaranteed delivery even when no staff
 * are logged in, migrate this to the Vercel Cron job (api/cron-reminders.ts) that
 * calls the same dispatch logic server-side.
 */
import type { Policy, Client, Reminder } from '../types'
import { db } from './db'
import { MAILBOXES } from './mailboxes'
import { sendEmail, getNotifSettings, getSmsRecipientsForEvent } from './mailService'
import { notifyPhone } from './notify'
import { premiumReminderSms, policyLapsedSms, smsDate } from './smsText'
import { NETONE_SUSPENDED } from './claimNotifications'
import { supabase } from './supabase'
import { resolveSmsText, smsVarMoney } from './smsTemplates'
import { policyBillablePremium } from './premium'
import { formatDate, toIsoDate } from './dateUtils'

const CHECK_KEY = 'tqfy_reminder_last_check'

/** Where a reminder email sends someone to actually pay -- the client
 *  portal, logged in, is the only place "pay this policy online" already
 *  exists (My Policies -> Pay Online), so this is that, not a new
 *  unauthenticated payment page invented for the email alone. */
const PAY_ONLINE_URL = 'https://portal.motions.co.zw/login'

/** What the client actually owes this cycle. Premiums are per head, so this
 *  is the policyholder plus every dependant — quoting policy.premium here
 *  asked a family to pay one person's share. */
function amountDue(policy: Policy): number {
  return policyBillablePremium(policy)
}

// ── Billing date helpers ───────────────────────────────────────────

/** Last day of the current month */
export function lastDayOfMonth(d = new Date()): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0)
}

/** First day of the current month */
export function firstDayOfMonth(d = new Date()): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

/** Next due date for a policy (last day of current month, or next if already past) */
export function getNextDueDate(_policy: Policy): Date {
  const today = new Date()
  const lastDay = lastDayOfMonth(today)
  if (today > lastDay) {
    return lastDayOfMonth(new Date(today.getFullYear(), today.getMonth() + 1, 1))
  }
  return lastDay
}

/** Days between two dates (positive = future, negative = past) */
function daysDiff(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86400000)
}

// ── Stage tags (dedup markers stored in reminders.message) ────────

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

// ── Email templates ────────────────────────────────────────────────

function buildReminderEmail(policy: Policy, type: ReminderType, dueDate: Date, sig: string): string {
  const due = dueDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
  // The three renewal reminders carry the SAME message — only the lapse
  // notice differs.
  if (type === 'lapse') {
    return `Dear ${policy.clientName},

NOTICE: Your policy ${policy.policyNumber} (${policy.productName}) has LAPSED.

Your premium of $${amountDue(policy).toFixed(2)}, due on ${due}, was not paid within the grace period (to the 10th). Cover is suspended and no claim can be paid while the policy is lapsed.

You can reinstate the policy by paying the outstanding premium — a lapse of more than 3 months closes the policy.

Payment methods: EcoCash | Paynow | Zipit | Cash at office | Online: ${PAY_ONLINE_URL}

${sig}`
  }
  return `Dear ${policy.clientName},

This is a reminder that your insurance premium of $${amountDue(policy).toFixed(2)} for policy ${policy.policyNumber} (${policy.productName}) is due on ${due}.

Please pay by ${due} to keep your cover. You can pay via EcoCash, Paynow, Zipit, at any of our offices, or online: ${PAY_ONLINE_URL}

${sig}`
}

function buildStaffEmail(policy: Policy, type: ReminderType, dueDate: Date, sig: string): string {
  const due = dueDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
  return `Billing Reminder Alert: ${STAGE_LABEL[type]}

Policy: ${policy.policyNumber}
Client: ${policy.clientName}
Product: ${policy.productName}
Premium Due: $${amountDue(policy).toFixed(2)}
Due Date: ${due}
${type === 'lapse' ? '\n⚠ Policy has LAPSED — the grace period ended unpaid. Client and office are notified.\n' : ''}

${sig}`
}

// ── Core dispatch ──────────────────────────────────────────────────

async function dispatchReminder(policy: Policy, client: Client | undefined, type: ReminderType, dueDate: Date) {
  const dueISO = toIsoDate(dueDate)
  const tag = STAGE_TAG[type]

  const already = await db.reminders.existsForStage(policy.id, dueISO, tag)
  if (already) return

  const cfg = getNotifSettings()
  const clientEmail = client?.email ?? ''
  const clientPhone = client?.phone ?? ''

  const allCc = [cfg.insurerEmail, NETONE_SUSPENDED ? '' : cfg.netoneEmail].filter(Boolean).join(', ')
  const sig = cfg.signature

  if (clientEmail) {
    void sendEmail({
      to: clientEmail,
      cc: allCc,
      subject: type === 'lapse'
        ? `Notice: ${policy.policyNumber} has LAPSED`
        : `Premium Reminder: ${policy.policyNumber} due ${formatDate(dueDate)}`,
      body: buildReminderEmail(policy, type, dueDate, sig),
      folder: 'inbox',
      linkedTo: policy.id,
      from: MAILBOXES.noreply,
    })
  }

  const staffBody = buildStaffEmail(policy, type, dueDate, sig)
  const staffSubject = `[Billing Alert] ${policy.policyNumber}: ${policy.clientName}`
  if (cfg.insurerEmail) void sendEmail({ to: cfg.insurerEmail, cc: NETONE_SUSPENDED ? undefined : cfg.netoneEmail, subject: staffSubject, body: staffBody, folder: 'inbox', from: MAILBOXES.noreply })
  if (!NETONE_SUSPENDED && cfg.netoneEmail) void sendEmail({ to: cfg.netoneEmail, subject: staffSubject, body: staffBody, folder: 'inbox', from: MAILBOXES.noreply })

  // Every stage texts the client — a reminder that only ever arrives by
  // email is easy to miss. The text comes from the shared builders so it
  // is byte-identical to what api/cron-reminders.ts would send for this
  // same policy and stage — whichever engine fires first, the wording is
  // the same.
  const reminderInput = {
    clientName: client?.name ?? policy.clientName,
    policyNumber: policy.policyNumber,
    amount: amountDue(policy),
    dueDate,
    clientPhone,
  }
  const smsBody = await resolveSmsText(supabase, type === 'lapse' ? 'policy_lapsed' : 'premium_reminder', {
    productId: policy.productId,
    vars: {
      clientName: reminderInput.clientName,
      policyNumber: policy.policyNumber,
      productName: policy.productName,
      amount: smsVarMoney(reminderInput.amount),
      dueDate: smsDate(dueDate),
    },
    fallback: type === 'lapse' ? policyLapsedSms(reminderInput) : premiumReminderSms(reminderInput),
  })
  if (clientPhone) {
    notifyPhone(clientPhone, smsBody, 'renewal', policy.policyNumber)
  }

  if (type === 'lapse') {
    await db.cautionFlags.set({
      policyId: policy.id,
      policyNumber: policy.policyNumber,
      clientId: policy.clientId,
      clientName: policy.clientName,
      agentId: policy.agentId,
      daysOverdue: 10,
      flaggedAt: new Date().toISOString(),
      monthsDefaulted: 1,
      cleared: false,
    })
    // Unpaid past the 10th's grace deadline lapses the policy; a completed
    // payment reinstates it through a fresh waiting period
    // (applyCompletedPaymentToPolicy), and an Admin can re-enable it.
    if (policy.status !== 'lapsed') {
      await db.policies.update(policy.id, { status: 'lapsed' })
    }
    // The office hears about every lapse the same way it hears about
    // every other money event in the system -- the four fixed lines, not
    // just whoever happens to have Billing & Reminders open.
    const recipients = [...new Set(await getSmsRecipientsForEvent('system'))]
    for (const number of recipients) {
      notifyPhone(number, `RENEWAL: ${smsBody}`, 'renewal', policy.policyNumber)
    }
  }

  // Logged after sending — this row IS the dedup record for this stage.
  await db.reminders.create({
    type: 'payment_due',
    clientId: policy.clientId,
    policyId: policy.id,
    dueDate: dueISO,
    message: `${tag} ${STAGE_LABEL[type]}: ${policy.policyNumber}`,
    smsBody: clientPhone ? smsBody : undefined,
    sent: true,
    channel: 'email',
  } as Omit<Reminder, 'id'>)
}

// ── Engine entry point ─────────────────────────────────────────────

export async function runReminderCheck() {
  const today = new Date()
  // Same calendar as api/cron-reminders.ts: the 20th, 25th, 1st and 10th,
  // client texts only inside 08:00–16:00 local time.
  const day = today.getDate()
  const type: ReminderType | null =
    day === 20 ? 'r1' : day === 25 ? 'r2' : day === 1 ? 'r3' : day === 10 ? 'lapse' : null
  const hour = today.getHours()
  if (!type || hour < 8 || hour >= 16) { try { localStorage.setItem(CHECK_KEY, today.toISOString()) } catch { /**/ }; return }

  // On the 20th/25th the renewal due the 1st of NEXT month; on the 1st
  // and the 10th, this month's own premium.
  const dueDate = new Date(today.getFullYear(), today.getMonth() + (day >= 20 ? 1 : 0), 1)
  const dueISO = toIsoDate(dueDate)
  const todayISO = toIsoDate(today)

  const [{ data: allPolicies }, { data: allClients }, { data: allProducts }] = await Promise.all([db.policies.list(), db.clients.list(), db.products.list()])
  const categoryByProductId = new Map((allProducts ?? []).map(p => [p.id, p.category]))
  // Only the unpaid hear from us — nextPaymentDate past the due date
  // means the period is settled. Lapse catches anything due before
  // today, the grace window having closed.
  const policies = (allPolicies ?? []).filter(p =>
    (p.status === 'active' || p.status === 'waiting_period' || p.status === 'defaulted')
    && categoryByProductId.get(p.productId) !== 'agriculture'
    && (p.nextPaymentDate
      ? (type === 'lapse' ? p.nextPaymentDate < todayISO : p.nextPaymentDate <= dueISO)
      : true))
  const clientById = new Map((allClients ?? []).map(c => [c.id, c]))

  for (const policy of policies) {
    await dispatchReminder(policy, clientById.get(policy.clientId), type, dueDate)
  }

  try { localStorage.setItem(CHECK_KEY, today.toISOString()) } catch { /**/ }
}

const WAITING_PERIOD_DAYS = 90

/** Lifts a non-agriculture policy out of its waiting period once 90 days
 *  have passed since its start date, as long as payment is current —
 *  agriculture never sits in waiting_period this long since it activates
 *  instantly on first payment (see applyCompletedPaymentToPolicy in db.ts),
 *  so it's excluded here rather than accidentally auto-activated by date. */
export async function checkWaitingPeriodElapsed() {
  const [{ data: allPolicies }, { data: allProducts }] = await Promise.all([db.policies.list(), db.products.list()])
  const categoryByProductId = new Map((allProducts ?? []).map(p => [p.id, p.category]))
  const today = new Date()

  for (const policy of allPolicies ?? []) {
    if (policy.status !== 'waiting_period') continue
    if (categoryByProductId.get(policy.productId) === 'agriculture') continue
    const daysSinceStart = Math.round((today.getTime() - new Date(policy.startDate).getTime()) / 86400000)
    if (daysSinceStart < WAITING_PERIOD_DAYS) continue
    const overdue = policy.nextPaymentDate ? new Date(policy.nextPaymentDate) < today : false
    if (overdue) continue
    await db.policies.update(policy.id, { status: 'active' })
  }
}

/** Policies whose cover term has ended are swept to 'expired' — the
 *  archive state. The active book then holds only live cover (e.g. the
 *  whole tobacco book rolls off on 31 Aug when the season closes), while
 *  an archived policy keeps every record — client, dependants, payments —
 *  and can be restored from the Archive view if the client returns. */
export async function archiveExpiredPolicies() {
  const { data: allPolicies } = await db.policies.list()
  const todayISO = toIsoDate(new Date())
  for (const policy of allPolicies ?? []) {
    if (!policy.endDate || policy.endDate >= todayISO) continue
    if (!['active', 'waiting_period', 'lapsed', 'defaulted'].includes(policy.status)) continue
    await db.policies.update(policy.id, { status: 'expired' })
  }
}

export function getLastCheckTime(): string | null {
  return localStorage.getItem(CHECK_KEY)
}

export function getUpcomingDueCount(): number {
  // Synchronous by design (used for a lightweight badge) — real due-soon
  // counts are shown properly on the Reminders/Billing pages, which fetch
  // real data async. This just answers "is anything due within a week".
  const today = new Date()
  const due = new Date(today.getFullYear(), today.getMonth() + 1, 1)
  const daysToDue = daysDiff(today, due)
  return daysToDue >= 0 && daysToDue <= 7 ? 1 : 0
}

/** Start hourly in-app checker. Call once from App.tsx. */
export function startReminderEngine(): () => void {
  void runReminderCheck()
  void checkWaitingPeriodElapsed()
  void archiveExpiredPolicies()
  const interval = setInterval(() => {
    void runReminderCheck()
    void checkWaitingPeriodElapsed()
    void archiveExpiredPolicies()
  }, 3600000) // every hour
  return () => clearInterval(interval)
}


