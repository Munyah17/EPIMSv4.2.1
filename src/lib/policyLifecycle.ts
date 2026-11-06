import type { Policy } from '../types'
import { toIsoDate } from './dateUtils.js'

/**
 * When a policy actually starts: capture date (today, when staff register
 * it) is not the same as the billing start date. Registering before the
 * 10th of the month starts cover on the 1st of THIS month; on/after the
 * 10th starts it on the 1st of NEXT month, so every policy's billing cycle
 * aligns to the 1st regardless of when it was written up. Super Admin/Admin
 * can still override this manually (see NewPolicyModal).
 */
export function computeAssignedStartDate(registrationDate: Date = new Date()): string {
  const day = registrationDate.getDate()
  const year = registrationDate.getFullYear()
  const month = registrationDate.getMonth()
  const assigned = day < 10 ? new Date(year, month, 1) : new Date(year, month + 1, 1)
  return toIsoDate(assigned)
}

export type PaymentCurrencyStatus = 'current' | 'arrears' | 'prepaid'

/** Derived purely from nextPaymentDate vs today — no separate stored field.
 *  More than ~10 days past due counts as arrears (matches the reminder
 *  engine's own R4/caution-flag threshold); more than one cycle ahead
 *  counts as prepaid (covers the "pay several months/years in advance"
 *  case from the multi-period Pay Online option). */
export function paymentCurrencyStatus(policy: Policy): PaymentCurrencyStatus {
  if (!policy.nextPaymentDate) return 'current'
  const diffDays = (new Date(policy.nextPaymentDate).getTime() - Date.now()) / 86400000
  if (diffDays < 0) return 'arrears'
  if (diffDays > 40) return 'prepaid'
  return 'current'
}

/** Adds whole months to a YYYY-MM-DD date without a timezone round-trip,
 *  clamping to the month's last day (31 Jan + 1 → 28 Feb). */
export function addMonthsIso(iso: string, months: number): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  const lastDay = new Date(y, m - 1 + months + 1, 0).getDate()
  return toIsoDate(new Date(y, m - 1 + months, Math.min(d, lastDay)))
}

/** What a policy owes: every billing period from its paid-up-to date
 *  through today (a period due today counts — same as
 *  paymentCurrencyStatus, which flags arrears on the due date). */
export function arrearsSummary(
  nextPaymentDate: string | undefined, perPeriod: number, cycleMonths: number, today: Date = new Date(),
): { periods: number; amount: number; since?: string } {
  const todayIso = toIsoDate(today)
  if (!nextPaymentDate || nextPaymentDate.slice(0, 10) > todayIso) return { periods: 0, amount: 0 }
  let cursor = nextPaymentDate.slice(0, 10)
  let periods = 0
  while (cursor <= todayIso && periods < 600) {
    cursor = addMonthsIso(cursor, cycleMonths)
    periods++
  }
  return { periods, amount: Math.round(periods * perPeriod * 100) / 100, since: nextPaymentDate.slice(0, 10) }
}

/** Where cover runs to after a payment. Continues from the existing
 *  paid-up-to date — NOT from today — so a client settling missed months
 *  is credited exactly the months they paid for. Only whole periods count;
 *  a part payment is still recorded but doesn't move the date. */
export function paidUntilAfterPayment(
  nextPaymentDate: string | undefined, amount: number, perPeriod: number, cycleMonths: number, today: Date = new Date(),
): { periods: number; paidUntil: string } {
  const base = nextPaymentDate ? nextPaymentDate.slice(0, 10) : toIsoDate(today)
  const periods = perPeriod > 0 && amount > 0 ? Math.floor((amount + 0.005) / perPeriod) : 0
  return { periods, paidUntil: addMonthsIso(base, periods * cycleMonths) }
}

export const PAYMENT_CURRENCY_LABEL: Record<PaymentCurrencyStatus, string> = {
  current: 'Up to Date',
  arrears: 'In Arrears',
  prepaid: 'Prepaid',
}

export const PAYMENT_CURRENCY_CLASS: Record<PaymentCurrencyStatus, string> = {
  current: 'pill-active',
  arrears: 'pill-lapsed',
  prepaid: 'pill-caution',
}
