import { describe, it, expect } from 'vitest'
import { computeAssignedStartDate } from './policyLifecycle'

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
