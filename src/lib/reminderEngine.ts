/**
 * Billing Reminder Engine
 *
 * Billing cycle: 1st → last day of each month (configured globally).
 * Reminder schedule per policy:
 *   R1: 5 days before last day of month
 *   R2: 1 day before last day of month
 *   R3: Last day of month (+ 1 SMS via smsService)
 *   R4: 5 days AFTER last day → caution flag applied
 *
 * Tracks sent reminders in localStorage to prevent duplicates.
 * Run via: startReminderEngine() on app boot.
 * Production: wire into scripts/reminder-cron.js for guaranteed delivery.
 */
import type { Policy } from '../types'
import { localStore } from './localStore'
import { sendEmail, getNotifSettings } from './mailService'
import { sendSms } from './smsService'
import { cautionStore } from './cautionStore'

const SENT_KEY = 'tqfy_reminder_sent'
const CHECK_KEY = 'tqfy_reminder_last_check'

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

// ── Sent-reminder dedup ────────────────────────────────────────────

type ReminderType = 'r1_pre5' | 'r2_pre1' | 'r3_due' | 'r4_post5'

function sentKey(policyId: string, month: string, type: ReminderType): string {
  return `${policyId}:${month}:${type}`
}

function getSent(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(SENT_KEY) ?? '[]')) } catch { return new Set() }
}

function markSent(key: string) {
  const s = getSent()
  s.add(key)
  // Keep max 500 keys to avoid bloat
  const arr = Array.from(s).slice(-500)
  try { localStorage.setItem(SENT_KEY, JSON.stringify(arr)) } catch { /**/ }
}

function wasSent(key: string): boolean { return getSent().has(key) }

// ── Email templates ────────────────────────────────────────────────

function buildReminderEmail(policy: Policy, type: ReminderType, dueDate: Date, sig: string): string {
  const due = dueDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
  switch (type) {
    case 'r1_pre5': return `Dear ${policy.clientName},

This is a friendly reminder that your insurance premium of $${policy.premium.toFixed(2)} for policy ${policy.policyNumber} (${policy.productName}) is due in 5 days on ${due}.

Please ensure your payment is ready to avoid any lapse in cover.

${sig}`
    case 'r2_pre1': return `Dear ${policy.clientName},

URGENT REMINDER: Your insurance premium of $${policy.premium.toFixed(2)} for policy ${policy.policyNumber} is due TOMORROW, ${due}.

Please pay immediately to maintain active coverage. You can pay via EcoCash, Paynow, Zipit, or at any of our offices.

${sig}`
    case 'r3_due': return `Dear ${policy.clientName},

Your insurance premium of $${policy.premium.toFixed(2)} for policy ${policy.policyNumber} is DUE TODAY, ${due}.

Failure to pay today may result in your policy lapsing. Please pay now to avoid disruption to your coverage.

Payment methods: EcoCash | Paynow | Zipit | Cash at office

${sig}`
    case 'r4_post5': return `Dear ${policy.clientName},

NOTICE OF OVERDUE PREMIUM — CAUTION FLAG APPLIED

Your insurance premium for policy ${policy.policyNumber} (${policy.productName}) was due on ${due} and remains unpaid as of today (5 days overdue).

⚠ IMPORTANT: Your policy coverage may be at risk. Any claims submitted while your premium is in arrears may be subject to review or rejection.

Please settle $${policy.premium.toFixed(2)} immediately to restore full coverage and remove this caution flag.

Payment methods: EcoCash | Paynow | Zipit | Cash at office

${sig}`
  }
}

function buildStaffEmail(policy: Policy, type: ReminderType, dueDate: Date, sig: string): string {
  const due = dueDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
  const label: Record<ReminderType, string> = {
    r1_pre5: '5-Day Pre-Due Reminder',
    r2_pre1: '1-Day Pre-Due Reminder',
    r3_due: 'Due Date Reminder',
    r4_post5: 'OVERDUE — Caution Flag Applied',
  }
  return `Billing Reminder Alert: ${label[type]}

Policy: ${policy.policyNumber}
Client: ${policy.clientName}
Product: ${policy.productName}
Premium Due: $${policy.premium.toFixed(2)}
Due Date: ${due}
${type === 'r4_post5' ? '\n⚠ Caution flag has been applied to this policy. Client, agent, and insurer are notified.\n' : ''}

${sig}`
}

// ── Core dispatch ──────────────────────────────────────────────────

function dispatchReminder(policy: Policy, type: ReminderType, dueDate: Date) {
  const cfg = getNotifSettings()
  const month = `${dueDate.getFullYear()}-${String(dueDate.getMonth() + 1).padStart(2, '0')}`
  const key = sentKey(policy.id, month, type)
  if (wasSent(key)) return

  const clients = localStore.clients.list()
  const client = clients.find(c => c.id === policy.clientId)
  const clientEmail = client?.email ?? ''
  const clientPhone = client?.phone ?? ''

  const allCc = [cfg.insurerEmail, cfg.netoneEmail].filter(Boolean).join(', ')
  const sig = cfg.signature

  // Client email
  if (clientEmail) {
    void sendEmail({
      to: clientEmail,
      cc: allCc,
      subject: type === 'r4_post5'
        ? `⚠ Overdue Notice — ${policy.policyNumber} Caution Flag Applied`
        : `Premium Reminder — ${policy.policyNumber} due ${dueDate.toLocaleDateString('en-GB')}`,
      body: buildReminderEmail(policy, type, dueDate, sig),
      folder: 'inbox',
      linkedTo: policy.id,
    })
  }

  // Insurer + NetOne staff emails
  const staffBody = buildStaffEmail(policy, type, dueDate, sig)
  const staffSubject = `[Billing Alert] ${policy.policyNumber} — ${policy.clientName}`
  if (cfg.insurerEmail) void sendEmail({ to: cfg.insurerEmail, cc: cfg.netoneEmail, subject: staffSubject, body: staffBody, folder: 'inbox' })
  if (cfg.netoneEmail) void sendEmail({ to: cfg.netoneEmail, subject: staffSubject, body: staffBody, folder: 'inbox' })

  // SMS only on due date
  if (type === 'r3_due' && clientPhone) {
    sendSms(clientPhone,
      `Tariqify: Premium of $${policy.premium.toFixed(2)} for policy ${policy.policyNumber} is DUE TODAY. Pay now via EcoCash/Paynow to keep your coverage active.`
    ).catch(() => { /**/ })
  }

  // Apply caution flag after 5 days overdue
  if (type === 'r4_post5') {
    cautionStore.set({
      policyId: policy.id,
      policyNumber: policy.policyNumber,
      clientId: policy.clientId,
      clientName: policy.clientName,
      agentId: policy.agentId,
      daysOverdue: 5,
      flaggedAt: new Date().toISOString(),
      monthsDefaulted: 1,
      cleared: false,
    })
  }

  markSent(key)
}

// ── Engine entry point ─────────────────────────────────────────────

export function runReminderCheck() {
  const today = new Date()
  const lastDue = lastDayOfMonth(today)
  const policies = localStore.policies.list().filter(p => p.status === 'active')

  policies.forEach(policy => {
    const daysToLast = daysDiff(today, lastDue)

    if (daysToLast === 5) dispatchReminder(policy, 'r1_pre5', lastDue)
    else if (daysToLast === 1) dispatchReminder(policy, 'r2_pre1', lastDue)
    else if (daysToLast === 0) dispatchReminder(policy, 'r3_due', lastDue)
    else if (daysToLast === -5) dispatchReminder(policy, 'r4_post5', lastDue)
  })

  try { localStorage.setItem(CHECK_KEY, today.toISOString()) } catch { /**/ }
}

export function getLastCheckTime(): string | null {
  return localStorage.getItem(CHECK_KEY)
}

export function getUpcomingDueCount(): number {
  const today = new Date()
  const lastDue = lastDayOfMonth(today)
  const daysToLast = daysDiff(today, lastDue)
  if (daysToLast < 0 || daysToLast > 7) return 0
  return localStore.policies.list().filter(p => p.status === 'active').length
}

/** Start hourly in-app checker. Call once from App.tsx. */
export function startReminderEngine(): () => void {
  runReminderCheck()
  const interval = setInterval(runReminderCheck, 3600000) // every hour
  return () => clearInterval(interval)
}
