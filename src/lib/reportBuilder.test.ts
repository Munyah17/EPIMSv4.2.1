import { describe, expect, it } from 'vitest'
import { buildReport, type ReportData } from './reportBuilder'
import type { Claim, Client, Payment, Policy, Product } from '../types'

const agriPolicy = {
  id: 'p-agri', policyNumber: 'AGR-001', clientId: 'c1', clientName: 'Caroline Kabaya',
  productId: 'prod-agri', productName: 'Field to Floor', productCategory: 'agriculture',
  growerNumber: 'GR-12345', premium: 120, coverAmount: 5000, startDate: '2026-01-01',
  endDate: '2026-12-31', paymentMethod: 'Stop Order',
  createdAt: '2026-01-02', status: 'active', dependants: [],
} as Policy

const funeralPolicy = {
  ...agriPolicy,
  id: 'p-funeral', policyNumber: 'FUN-001', clientId: 'c2', clientName: 'Tendai Moyo',
  productId: 'prod-funeral', productName: 'Family Funeral', productCategory: 'funeral',
  growerNumber: undefined, premium: 5, coverAmount: 500,
} as Policy

const client: Client = {
  id: 'c1', name: 'Caroline Kabaya', email: '', phone: '0772000000', nationalId: 'ID1',
  dob: '1980-01-01', address: '', createdAt: '2026-01-01', policyCount: 1, status: 'active',
} as Client

const products = [
  { id: 'prod-agri', name: 'Field to Floor', category: 'agriculture' },
  { id: 'prod-funeral', name: 'Family Funeral', category: 'funeral' },
] as Product[]

const last = <T>(items: T[]) => items[items.length - 1]

const data: ReportData = {
  policies: [agriPolicy, funeralPolicy],
  claims: [],
  payments: [],
  clients: [client],
  staff: [],
  products,
  developers: [],
}

describe('report grower number column', () => {
  it('appends Grower No. to a mixed policy report only when agriculture is present', () => {
    const report = buildReport('policies', data, {}, 'none')
    expect(last(report.columns).label).toBe('Grower No.')
    expect(report.rows.map(last)).toEqual(['GR-12345', ''])

    const nonAgri = buildReport('policies', { ...data, policies: [funeralPolicy] }, {}, 'none')
    expect(nonAgri.columns.map(c => c.label)).not.toContain('Grower No.')
  })

  it('uses agriculture policies to identify grower clients in the clientele export', () => {
    const report = buildReport('clients', data, {}, 'none')
    expect(last(report.columns).label).toBe('Grower No.')
    expect(last(report.rows[0])).toBe('GR-12345')
  })

  it('keeps grower numbers on agriculture claims, payments, grouped and product reports', () => {
    const claim = {
      id: 'cl1', claimNumber: 'CL-1', policyId: 'p-agri', policyNumber: 'AGR-001', clientId: 'c1',
      clientName: 'Caroline Kabaya', productName: 'Field to Floor', category: 'agriculture',
      claimType: 'Loss', amount: 100, status: 'paid', stage: 'closed', dateOfEvent: '2026-02-01',
      dateSubmitted: '2026-02-02', description: '', fraudScore: 0, documents: [],
    } as Claim
    const payment = {
      id: 'pay1', reference: 'PAY-1', policyId: 'p-agri', policyNumber: 'AGR-001',
      clientName: 'Caroline Kabaya', amount: 120, method: 'Stop Order', status: 'completed',
      date: '2026-02-03',
    } as Payment
    const enriched = { ...data, claims: [claim], payments: [payment] }

    expect(last(buildReport('claims', enriched, {}, 'none').rows[0])).toBe('GR-12345')
    expect(last(buildReport('payments', enriched, {}, 'none').rows[0])).toBe('GR-12345')
    expect(last(buildReport('policies', enriched, {}, 'category').rows.find(r => r[0] === 'agriculture') ?? [])).toBe('GR-12345')
    expect(last(buildReport('products', enriched, {}, 'none').rows.find(r => r[0] === 'Field to Floor') ?? [])).toBe('GR-12345')
  })
})
