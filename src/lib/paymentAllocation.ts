/**
 * How much to collect right now, and what to do with a payment.
 *
 * Two bugs this exists to close:
 *
 * 1. Mid-cycle dependant add. The holder already paid this month ($1).
 *    Four dependants are then added ($4). The monthly total becomes $5,
 *    but collecting $5 charges the holder twice. Collect only the unpaid
 *    heads for the period that is already paid up; leftover cents after
 *    that are overpayment / credit, not a silent extra month.
 *
 * 2. Remainder vanishing. floor(paid / perPeriod) used to throw away
 *    anything short of a whole extra period, so a $6 payment against a
 *    $5 premium left a dollar that staff and the client could not see.
 *
 * Derived from completed payments + nextPaymentDate — no extra column.
 * Agriculture is billed on the crop, not per head, so callers pass
 * cycleMonths=12 and skip the upgrade path (paidToward in a 12-month
 * window is the annual premium, not a dependant top-up).
 *
 * Every relative import carries .js — api/ functions run as transpiled
 * ESM where Node resolves literally.
 */
import { addMonthsIso, arrearsSummary } from './policyLifecycle.js'
import { toIsoDate } from './dateUtils.js'

export interface CompletedPayment {
  amount: number
  date: string
}

export function completedPays(payments: { amount: number; date: string; status?: string }[]): CompletedPayment[] {
  return payments
    .filter(p => !p.status || p.status === 'completed')
    .map(p => ({ amount: p.amount, date: p.date.slice(0, 10) }))
}

export interface Settlement {
  perPeriod: number
  /** What to collect right now. 0 when the current period is fully funded. */
  dueNow: number
  /** Paid in the current period above perPeriod — visible overpayment. */
  credit: number
  /** Completed-payment total inside the current paid-up window. */
  paidTowardCurrent: number
  /** True when the period is paid up for the old head-count and new heads still owe. */
  isUpgrade: boolean
}

function money(n: number): number {
  return Math.round(n * 100) / 100
}

function inCurrentWindow(date: string, periodStart: string, periodEnd: string): boolean {
  const d = date.slice(0, 10)
  return d >= periodStart && d < periodEnd
}

function paidInWindow(payments: CompletedPayment[], periodStart: string, periodEnd: string): number {
  return money(payments.reduce((sum, p) => (
    p.amount > 0 && inCurrentWindow(p.date, periodStart, periodEnd) ? sum + p.amount : sum
  ), 0))
}

/**
 * What the policy owes (or is owed) given the payments already on file.
 * `payments` is completed payments only — pending/failed/reversed excluded.
 */
export function settlement(
  perPeriod: number,
  cycleMonths: number,
  nextPaymentDate: string | undefined,
  payments: CompletedPayment[],
  today: Date = new Date(),
): Settlement {
  const empty: Settlement = { perPeriod, dueNow: 0, credit: 0, paidTowardCurrent: 0, isUpgrade: false }
  if (!(perPeriod > 0)) return empty

  const todayIso = toIsoDate(today)
  const n = nextPaymentDate?.slice(0, 10)
  if (!n || n <= todayIso) {
    const arrears = arrearsSummary(n, perPeriod, cycleMonths, today)
    // Part payments toward the missed period(s) sit on file but used
    // not to count: each new payment was judged against a full perPeriod
    // on its own, so $3 then $2 never added up to a month. Anything
    // received on/after the due date is credit toward that arrears bill.
    const paidSinceDue = n
      ? money(payments.reduce((sum, p) => (p.amount > 0 && p.date.slice(0, 10) >= n ? sum + p.amount : sum), 0))
      : 0
    const dueNow = money(Math.max(0, arrears.amount - paidSinceDue))
    const credit = money(Math.max(0, paidSinceDue - arrears.amount))
    return { ...empty, dueNow, credit, paidTowardCurrent: paidSinceDue }
  }

  // Cover already runs past today. Anything paid inside this period that
  // falls short of the CURRENT billable premium is a dependant upgrade —
  // new heads added after the holder paid. Anything above it is credit.
  // paidToward == 0 means the period was funded by advancing the cursor
  // (a full-premium payment) rather than by in-window top-ups: nothing
  // extra is due, and inventing a $perPeriod bill would re-charge them.
  const periodStart = addMonthsIso(n, -cycleMonths)
  const paidToward = paidInWindow(payments, periodStart, n)
  if (paidToward <= 0) return empty
  if (paidToward + 0.005 < perPeriod) {
    return {
      perPeriod,
      dueNow: money(perPeriod - paidToward),
      credit: 0,
      paidTowardCurrent: paidToward,
      isUpgrade: true,
    }
  }
  return {
    perPeriod,
    dueNow: 0,
    credit: money(paidToward - perPeriod),
    paidTowardCurrent: paidToward,
    isUpgrade: false,
  }
}

export interface AllocationResult {
  nextPaymentDate: string
  periodsAdvanced: number
  credit: number
  /** True when this payment closed a mid-cycle dependant shortfall. */
  filledUpgrade: boolean
}

/**
 * Apply `amount` on top of the payments already on file. Fills a current-
 * period dependant upgrade first; leftover whole periods advance the
 * cursor; leftover cents become credit rather than disappearing.
 *
 * `paymentsBeforeThis` must NOT include the payment being applied.
 */
export function allocatePayment(
  amount: number,
  perPeriod: number,
  cycleMonths: number,
  nextPaymentDate: string | undefined,
  paymentsBeforeThis: CompletedPayment[],
  today: Date = new Date(),
): AllocationResult {
  const todayIso = toIsoDate(today)
  const base = nextPaymentDate && nextPaymentDate.slice(0, 10) > todayIso
    ? nextPaymentDate.slice(0, 10)
    : (nextPaymentDate?.slice(0, 10) ?? todayIso)

  if (!(perPeriod > 0) || !(amount > 0)) {
    return { nextPaymentDate: base, periodsAdvanced: 0, credit: 0, filledUpgrade: false }
  }

  const s = settlement(perPeriod, cycleMonths, nextPaymentDate, paymentsBeforeThis, today)
  // Overpayment already sitting on this period is spendable: a $1 credit
  // plus a $4 collection buys the next $5 month, so the extra dollar the
  // client can see is actually used rather than asked for again.
  let available = money(amount + s.credit)
  let filledUpgrade = false
  let cursor = base
  let advanced = 0

  if (s.dueNow > 0) {
    const applied = Math.min(available, s.dueNow)
    available = money(available - applied)
    const filledDue = applied + 0.005 >= s.dueNow
    filledUpgrade = s.isUpgrade && filledDue
    if (!filledDue) {
      // Short of what is owed: the cursor does not move and the shortfall
      // is not credit — they still owe the rest. The payment row still
      // records every cent, so the next settlement sees it.
      return { nextPaymentDate: cursor, periodsAdvanced: 0, credit: 0, filledUpgrade }
    }
    // The due-now hole is filled. For arrears that hole WAS the missed
    // periods, so the cursor jumps those periods forward. An upgrade
    // fills the already-paid period — the cursor stays put.
    if (!s.isUpgrade) {
      const missed = arrearsSummary(nextPaymentDate, perPeriod, cycleMonths, today).periods
      if (missed > 0) {
        cursor = addMonthsIso(cursor, missed * cycleMonths)
        advanced += missed
      }
    }
  }

  const extra = Math.floor((available + 0.005) / perPeriod)
  const credit = money(available - extra * perPeriod)
  if (extra > 0) {
    cursor = addMonthsIso(cursor, extra * cycleMonths)
    advanced += extra
  }
  return { nextPaymentDate: cursor, periodsAdvanced: advanced, credit, filledUpgrade }
}

/**
 * Default amount a payment screen should ask for.
 *
 * Mid-cycle upgrade: just the new heads (optionally plus extra full months).
 * Arrears: the arrears figure when asking for one period, else the selected
 * number of periods at the current rate.
 * Up to date: one (or N) full period — a voluntary prepayment.
 */
export function defaultCharge(s: Settlement, periods: number): number {
  const n = Number.isFinite(periods) && periods > 0 ? Math.floor(periods) : 1
  const raw = s.isUpgrade
    ? s.dueNow + Math.max(0, n - 1) * s.perPeriod
    : s.dueNow > 0 && n === 1 ? s.dueNow
    : n * s.perPeriod
  return money(Math.max(0, raw - s.credit))
}
