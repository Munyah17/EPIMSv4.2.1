import { describe, it, expect } from 'vitest'
import { settlement, allocatePayment, defaultCharge } from './paymentAllocation'

const today = new Date(2026, 10, 6) // 6 Nov 2026

describe('mid-cycle dependant upgrade', () => {
  // Holder paid $1 for November (next due 1 Dec). Four dependants then
  // added at $1 each — monthly total $5. Collect $4, not $5, and never $6.
  const paidNovember: { amount: number; date: string }[] = [{ amount: 1, date: '2026-11-03' }]

  it('asks only for the new heads when the holder already paid this month', () => {
    const s = settlement(5, 1, '2026-12-01', paidNovember, today)
    expect(s.dueNow).toBe(4)
    expect(s.credit).toBe(0)
    expect(s.isUpgrade).toBe(true)
    expect(defaultCharge(s, 1)).toBe(4)
  })

  it('applies overpayment credit to the next amount collected', () => {
    const after = [...paidNovember, { amount: 5, date: '2026-11-06' }]
    const s = settlement(5, 1, '2026-12-01', after, today)
    expect(s.credit).toBe(1)
    expect(s.dueNow).toBe(0)
    expect(defaultCharge(s, 1)).toBe(4)
    const a = allocatePayment(4, 5, 1, '2026-12-01', after, today)
    expect(a.nextPaymentDate).toBe('2027-01-01')
    expect(a.periodsAdvanced).toBe(1)
    expect(a.credit).toBe(0)
  })

  it('a $4 dependant payment does not advance the due date', () => {
    const a = allocatePayment(4, 5, 1, '2026-12-01', paidNovember, today)
    expect(a.nextPaymentDate).toBe('2026-12-01')
    expect(a.periodsAdvanced).toBe(0)
    expect(a.credit).toBe(0)
    expect(a.filledUpgrade).toBe(true)
  })

  it('a $5 payment (holder charged again) keeps the extra dollar as credit', () => {
    const a = allocatePayment(5, 5, 1, '2026-12-01', paidNovember, today)
    expect(a.nextPaymentDate).toBe('2026-12-01')
    expect(a.periodsAdvanced).toBe(0)
    expect(a.credit).toBe(1)
    expect(a.filledUpgrade).toBe(true)
  })

  it('a $6 charge leaves the extra $1 visible as overpayment, not a vanished remainder', () => {
    // Total collected after this payment: $1 + $6 = $7 against a $5 month.
    const after = [...paidNovember, { amount: 6, date: '2026-11-06' }]
    const s = settlement(5, 1, '2026-12-01', after, today)
    expect(s.dueNow).toBe(0)
    expect(s.credit).toBe(2)

    const a = allocatePayment(6, 5, 1, '2026-12-01', paidNovember, today)
    expect(a.nextPaymentDate).toBe('2026-12-01')
    expect(a.credit).toBe(2)
  })

  it('paying the $4 upgrade then the extra dollar shows $1 credit', () => {
    const after = [...paidNovember, { amount: 4, date: '2026-11-06' }, { amount: 1, date: '2026-11-06' }]
    const s = settlement(5, 1, '2026-12-01', after, today)
    expect(s.credit).toBe(1)
    expect(s.dueNow).toBe(0)
  })
})

describe('ordinary monthly billing', () => {
  it('a full premium on an up-to-date policy buys the next month', () => {
    const paid = [{ amount: 5, date: '2026-11-01' }]
    const s = settlement(5, 1, '2026-12-01', paid, today)
    expect(s.dueNow).toBe(0)
    expect(s.credit).toBe(0)
    expect(s.isUpgrade).toBe(false)
    const a = allocatePayment(5, 5, 1, '2026-12-01', paid, today)
    expect(a.nextPaymentDate).toBe('2027-01-01')
    expect(a.periodsAdvanced).toBe(1)
    expect(a.credit).toBe(0)
  })

  it('arrears of one month asks for one period', () => {
    const s = settlement(5, 1, '2026-11-01', [], today)
    expect(s.dueNow).toBe(5)
    expect(s.isUpgrade).toBe(false)
    const a = allocatePayment(5, 5, 1, '2026-11-01', [], today)
    expect(a.nextPaymentDate).toBe('2026-12-01')
    expect(a.periodsAdvanced).toBe(1)
  })

  it('a part payment against arrears does not buy a month and is not overpayment', () => {
    const a = allocatePayment(3, 5, 1, '2026-11-01', [], today)
    expect(a.periodsAdvanced).toBe(0)
    expect(a.nextPaymentDate).toBe('2026-11-01')
    expect(a.credit).toBe(0)
    const s = settlement(5, 1, '2026-11-01', [{ amount: 3, date: '2026-11-06' }], today)
    expect(s.dueNow).toBe(2)
    expect(s.credit).toBe(0)
  })

  it('a second part payment that completes the month advances the due date', () => {
    const a = allocatePayment(2, 5, 1, '2026-11-01', [{ amount: 3, date: '2026-11-06' }], today)
    expect(a.periodsAdvanced).toBe(1)
    expect(a.nextPaymentDate).toBe('2026-12-01')
    expect(a.credit).toBe(0)
  })
})
