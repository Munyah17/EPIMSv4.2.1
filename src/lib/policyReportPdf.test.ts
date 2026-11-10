import { describe, it, expect } from 'vitest'
import { policyDocumentSchedule } from './policyReportPdf'
import { formatDate } from './dateUtils'

const funeral = {
  productName: 'Funeral Cash Plan',
  lastPaymentDate: '2026-11-03',
  nextPaymentDate: '2026-12-01',
  endDate: '2027-11-03',
}

const tobacco = {
  productName: 'Tobacco Field to Floor — Standard',
  lastPaymentDate: '2026-11-06',
  nextPaymentDate: '2027-11-15',
  endDate: '2027-08-31',
}

const schoolTourPackage = {
  productName: 'Travel Accident Cover',
  coverScope: 'group' as const,
  onceOff: true,
  startDate: '2026-12-10',
  lastPaymentDate: '2026-11-10',
  nextPaymentDate: undefined,
  endDate: '2026-12-20',
}

describe('non-agriculture policy document schedule', () => {
  it('prints Payment Date as the day money landed, and Renewal Date as next due', () => {
    const s = policyDocumentSchedule(funeral, 'funeral')
    expect(s.paymentLabel).toBe('Payment Date')
    expect(s.untilLabel).toBe('Renewal Date')
    expect(s.paidWhen).toBe(formatDate('2026-11-03'))
    expect(s.renewsWhen).toBe(formatDate('2026-12-01'))
    expect(s.paidWhen).not.toBe(s.renewsWhen)
    expect(s.untilLabel).not.toBe('Expiration Date')
  })

  it('does not put the 1-year end_date artefact in the schedule', () => {
    const s = policyDocumentSchedule(funeral, 'health')
    expect(s.renewsWhen).toBe(formatDate(funeral.nextPaymentDate))
    expect(s.renewsWhen).not.toBe(formatDate(funeral.endDate))
  })
})

describe('once-off package policy document schedule', () => {
  it('prints the negotiated commencement and expiration dates', () => {
    const s = policyDocumentSchedule(schoolTourPackage, 'accident')
    expect(s.paymentLabel).toBe('Commencement Date')
    expect(s.untilLabel).toBe('Expiration Date')
    expect(s.paidWhen).toBe(formatDate('2026-12-10'))
    expect(s.renewsWhen).toBe(formatDate('2026-12-20'))
    expect(s.renewsWhen).not.toBe(formatDate(schoolTourPackage.lastPaymentDate))
  })
})

describe('agriculture policy document schedule is unchanged', () => {
  it('keeps Commencement / Expiration as the tobacco season for Field-to-Floor', () => {
    const s = policyDocumentSchedule(tobacco, 'agriculture')
    expect(s.paymentLabel).toBe('Commencement Date')
    expect(s.untilLabel).toBe('Expiration Date')
    expect(s.paidWhen).toBe('15-NOV-2026')
    expect(s.renewsWhen).toBe('31-AUG-2027')
  })

  it('keeps Expiration Date on non-tobacco agriculture', () => {
    const s = policyDocumentSchedule({
      productName: 'Small Scale Crops',
      lastPaymentDate: '2026-11-06',
      nextPaymentDate: '2027-11-01',
      endDate: '2027-10-31',
    }, 'agriculture')
    expect(s.paymentLabel).toBe('Commencement Date')
    expect(s.untilLabel).toBe('Expiration Date')
    expect(s.paidWhen).toBe('15-NOV-2026')
    expect(s.renewsWhen).toBe(formatDate('2027-10-31'))
  })
})
