import { describe, it, expect } from 'vitest'
import { computeAssignedStartDate, addMonthsIso, arrearsSummary, paidUntilAfterPayment } from './policyLifecycle'

// Locks down the exact bug a client hit: a policy's assigned start date
// read back as one day earlier than the 1st of the intended month (e.g.
// "31/08" instead of "01/09"), because computeAssignedStartDate used to
// build the date in local time and then read it back through
// toISOString(), which converts to UTC first. Zimbabwe is UTC+2 with no
// DST, so local midnight on the 1st is 22:00 UTC the day before -- wrong
// for the entire day, every day the function was called, not an
// occasional rounding error.
describe('computeAssignedStartDate', () => {
  it('assigns the 1st of the SAME month when registered before the 10th', () => {
    expect(computeAssignedStartDate(new Date(2026, 8, 1))).toBe('2026-09-01')
    expect(computeAssignedStartDate(new Date(2026, 8, 9))).toBe('2026-09-01')
  })

  it('assigns the 1st of the NEXT month when registered on/after the 10th', () => {
    expect(computeAssignedStartDate(new Date(2026, 8, 10))).toBe('2026-10-01')
    expect(computeAssignedStartDate(new Date(2026, 8, 30))).toBe('2026-10-01')
  })

  it('never returns the last day of the prior month -- the exact symptom reported', () => {
    // Registering on 3 September must never come back as 31 August.
    const result = computeAssignedStartDate(new Date(2026, 8, 3))
    expect(result).toBe('2026-09-01')
    expect(result).not.toBe('2026-08-31')
  })

  it('rolls the year over at a December registration', () => {
    expect(computeAssignedStartDate(new Date(2026, 11, 1))).toBe('2026-12-01')
    expect(computeAssignedStartDate(new Date(2026, 11, 15))).toBe('2027-01-01')
  })
})

describe('addMonthsIso', () => {
  it('adds months across a year boundary', () => {
    expect(addMonthsIso('2026-11-01', 3)).toBe('2027-02-01')
  })
  it('clamps to the last day of a shorter month', () => {
    expect(addMonthsIso('2026-01-31', 1)).toBe('2026-02-28')
  })
  it('is a no-op for zero months', () => {
    expect(addMonthsIso('2026-08-01', 0)).toBe('2026-08-01')
  })
})

describe('arrearsSummary', () => {
  const today = new Date(2026, 10, 4) // 4 Nov 2026

  it('counts every unpaid period from the paid-up-to date through today', () => {
    // Due 1 Aug, 1 Sep, 1 Oct, 1 Nov all missed -> 4 months at $12.
    expect(arrearsSummary('2026-08-01', 12, 1, today)).toEqual({ periods: 4, amount: 48, since: '2026-08-01' })
  })
  it('reports nothing owed when cover runs past today', () => {
    expect(arrearsSummary('2026-12-01', 12, 1, today)).toEqual({ periods: 0, amount: 0 })
  })
  it('reports nothing owed when there is no payment cursor', () => {
    expect(arrearsSummary(undefined, 12, 1, today)).toEqual({ periods: 0, amount: 0 })
  })
})

describe('paidUntilAfterPayment', () => {
  const today = new Date(2026, 10, 4)

  it('continues from the existing paid-up-to date, not from today', () => {
    // The bug this fixes: counting from today forgave Aug-Oct and then
    // over-credited the client by 3 months on top.
    expect(paidUntilAfterPayment('2026-08-01', 48, 12, 1, today)).toEqual({ periods: 4, paidUntil: '2026-12-01' })
  })
  it('a direct payment that settles the arrears clears them', () => {
    const { paidUntil } = paidUntilAfterPayment('2026-08-01', 48, 12, 1, today)
    expect(arrearsSummary(paidUntil, 12, 1, today).periods).toBe(0)
  })
  it('a part payment is recorded but does not move the date', () => {
    expect(paidUntilAfterPayment('2026-08-01', 10, 12, 1, today)).toEqual({ periods: 0, paidUntil: '2026-08-01' })
  })
  it('tolerates float noise in amounts', () => {
    expect(paidUntilAfterPayment('2026-08-01', 36.6, 12.2, 1, today).periods).toBe(3)
  })
  it('starts from today when the policy has no cursor yet', () => {
    expect(paidUntilAfterPayment(undefined, 12, 12, 1, today)).toEqual({ periods: 1, paidUntil: '2026-12-04' })
  })
  it('agriculture advances a whole season per period', () => {
    expect(paidUntilAfterPayment('2025-11-01', 100, 100, 12, today)).toEqual({ periods: 1, paidUntil: '2026-11-01' })
  })
})
