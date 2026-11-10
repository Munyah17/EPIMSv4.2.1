import { describe, it, expect } from 'vitest'
import type { Policy } from '../types'
import { policyBillablePremium, billableHeadCount, premiumLines, formatBillablePremium } from './premium'

const base: Policy = {
  id: 'pol1',
  policyNumber: 'EMA2026001',
  clientId: 'c1',
  clientName: 'Harold Muwi',
  productId: 'prod-funeral',
  productName: 'Funeral Cash Plan',
  productCategory: 'funeral',
  premium: 12,
  coverAmount: 8000,
  startDate: '2026-01-01',
  endDate: '2027-01-01',
  status: 'active',
  dependants: [],
  paymentMethod: 'EcoCash',
  createdAt: '2026-01-01',
  nextPaymentDate: '2026-02-01',
}

describe('per-head premiums', () => {
  it('charges the policyholder alone when there are no dependants', () => {
    expect(policyBillablePremium(base)).toBe(12)
    expect(billableHeadCount(base)).toBe(1)
  })

  it('adds a premium for every dependant', () => {
    const policy: Policy = {
      ...base,
      dependants: [
        { name: 'Tendai', relationship: 'Spouse', dob: '1992-04-02', nationalId: 'A', premium: 12 },
        { name: 'Rudo', relationship: 'Daughter', dob: '2015-09-14', nationalId: 'B', premium: 8 },
      ],
    }
    expect(policyBillablePremium(policy)).toBe(32)
    expect(billableHeadCount(policy)).toBe(3)
  })

  it('does not bill a blank dependant row left on the form', () => {
    const policy: Policy = {
      ...base,
      premium: 1,
      dependants: [
        { name: 'Tendai', relationship: 'Spouse', dob: '1992-04-02', nationalId: 'A', premium: 1 },
        { name: 'Rudo', relationship: 'Daughter', dob: '2015-09-14', nationalId: 'B', premium: 1 },
        { name: 'Tariro', relationship: 'Son', dob: '2018-02-01', nationalId: 'C', premium: 1 },
        { name: 'Nyasha', relationship: 'Daughter', dob: '2020-06-11', nationalId: 'D', premium: 1 },
        { name: '   ', relationship: '', dob: '', nationalId: '' },
      ],
    }
    expect(policyBillablePremium(policy)).toBe(5)
    expect(billableHeadCount(policy)).toBe(5)
  })

  it('puts a dependant with no plan of their own on the policyholder’s premium', () => {
    const policy: Policy = {
      ...base,
      dependants: [{ name: 'Rudo', relationship: 'Daughter', dob: '2015-09-14', nationalId: 'B' }],
    }
    expect(policyBillablePremium(policy)).toBe(24)
    expect(premiumLines(policy)[1].premium).toBe(12)
  })

  it('bills agriculture on the crop, not per head', () => {
    const policy: Policy = {
      ...base,
      productCategory: 'agriculture',
      productName: 'Tobacco Cover',
      premium: 400,
      dependants: [{ name: 'Farm hand', relationship: 'Worker', dob: '1990-01-01', nationalId: 'C', premium: 50 }],
    }
    expect(policyBillablePremium(policy)).toBe(400)
    expect(billableHeadCount(policy)).toBe(1)
  })

  it('bills a once-off package across participants for the term', () => {
    const policy: Policy = {
      ...base,
      coverScope: 'group',
      onceOff: true,
      groupId: 'grp-school',
      groupName: 'Glen View High School',
      premium: 25,
      nextPaymentDate: undefined,
      dependants: [
        { name: 'Tendai', relationship: 'Participant', dob: '2010-04-02', nationalId: 'A', premium: 30 },
        { name: 'Rudo', relationship: 'Participant', dob: '2011-09-14', nationalId: 'B' },
      ],
    }
    expect(policyBillablePremium(policy)).toBe(55)
    expect(billableHeadCount(policy)).toBe(2)
    expect(formatBillablePremium(policy)).toBe('$55.00/term (2 participants)')
  })

  it('labels monthly products /mo and agriculture /yr', () => {
    const policy: Policy = {
      ...base,
      dependants: [{ name: 'Tendai', relationship: 'Spouse', dob: '1992-04-02', nationalId: 'A', premium: 12 }],
    }
    expect(formatBillablePremium(policy)).toBe('$24.00/mo (2 people)')
    expect(formatBillablePremium(base)).toBe('$12.00/mo')
    expect(formatBillablePremium({ ...base, productCategory: 'agriculture', productName: 'Tobacco Cover' })).toBe('$12.00/yr')
  })
})
