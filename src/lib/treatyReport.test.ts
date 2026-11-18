import { describe, it, expect } from 'vitest'
import { treatyRows, treatyHeaders, TREATY_HEADERS } from './treatyReport'
import type { Policy, Client } from '../types'

const client: Client = {
  id: 'c1', name: 'Caroline Kabaya', nationalId: '38210897h38', email: 'caroline@example.com',
  phone: '0772000000', dob: '1982-11-26', gender: 'Female',
  address: '12 Test Road, Harare', occupation: 'Farmer', status: 'active',
  policyCount: 1, createdAt: '2026-01-01',
} as Client

const policy: Policy = {
  id: 'p1', policyNumber: 'FND-001', clientId: 'c1', clientName: 'Caroline Kabaya',
  productId: 'x', productName: 'Funeral', productCategory: 'funeral', excess: '10% min $50',
  premium: 1, coverAmount: 500,
  startDate: '2026-12-07', endDate: '2027-12-07', status: 'active',
  dependants: [
    { name: 'Rosemary Karikoga', relationship: 'Spouse', dob: '1980-05-10', gender: 'Female', nationalId: '49-053220 R 49', premium: 1, coverAmount: 500 },
  ],
  paymentMethod: 'EcoCash', coverScope: 'individual', agentId: 'a1', agentName: 'Agent One',
  capturedById: 's1', capturedByName: 'Staff One', source: 'web_app', insurer: 'Motions',
  nextPaymentDate: '2027-01-01', lastPaymentDate: '2026-12-01', createdAt: '2026-12-07',
} as Policy

const COL = {
  designation: 4,
  grower: 5,
  policyId: 6,
  policyNumber: 7,
  product: 8,
  category: 9,
  startDate: 11,
  period: 13,
  status: 14,
  hectarage: 19,
  contractor: 20,
  gpsLat: 21,
  gpsLng: 22,
  sumAssured: 25,
  premium: 26,
  retainedAssured: 28,
  retainedPremium: 29,
  reassured: 30,
  reassuredPremium: 31,
  agent: 35,
  capturedBy: 36,
  createdAt: 39,
}

describe('major policy report export', () => {
  const byId = new Map([[client.id, client]])
  const rows = treatyRows([policy], byId)

  it('emits one row per insured head with the complete policy register headers', () => {
    expect(rows).toHaveLength(2)
    expect(TREATY_HEADERS).toHaveLength(40)
    expect(TREATY_HEADERS.filter(h => h.startsWith('CLIENT '))).toHaveLength(0)
    expect(TREATY_HEADERS).not.toContain('GENDER')
    expect(TREATY_HEADERS).not.toContain('CAPTURED BY ID')
    expect(TREATY_HEADERS).not.toContain('CLIENT ID')
    expect(TREATY_HEADERS).not.toContain('PRODUCT ID')
    expect(TREATY_HEADERS).not.toContain('GROUP ID')
    expect(TREATY_HEADERS).not.toContain('AGENT ID')
    expect(TREATY_HEADERS).toContain('HECTARAGE')
    expect(TREATY_HEADERS).toContain('GROWER NO.')
  })

  it('carries person and policy details on every row', () => {
    const principal = rows[0]
    expect([principal[0], principal[1]]).toEqual(['Caroline', 'Kabaya'])
    expect(principal[2]).toBe('26-Nov-1982')
    expect(principal[3]).toBe('38210897H38')
    expect(principal[COL.designation]).toBe('PRINCIPAL MEMBER')
    expect(principal[COL.grower]).toBe('')
    expect(principal[COL.policyId]).toBe('p1')
    expect(principal[COL.policyNumber]).toBe('FND-001')
    expect(principal[COL.product]).toBe('Funeral')
    expect(principal[COL.category]).toBe('funeral')
    expect(principal[COL.startDate]).toBe('7-Dec-2026')
    expect(principal[COL.period]).toBe(1)
    expect(principal[COL.status]).toBe('active')
    expect(principal[COL.agent]).toBe('Agent One')
    expect(principal[COL.capturedBy]).toBe('Staff One')
    expect(principal[COL.createdAt]).toBe('7-Dec-2026')
  })

  it('designates dependants and splits the 40/60 retention', () => {
    expect(rows[1][COL.designation]).toBe('DEPENDENT SPOUSE')
    // 500 assured at 40% retained / 60% ceded; 1 premium likewise
    expect([rows[1][COL.retainedAssured], rows[1][COL.reassured]]).toEqual([200, 300])
    expect([rows[1][COL.retainedPremium], rows[1][COL.reassuredPremium]]).toEqual([0.4, 0.6])
  })

  it('carries agriculture registration, hectarage, contractor and GPS fields', () => {
    const agriPolicy: Policy = {
      ...policy,
      productCategory: 'agriculture',
      growerNumber: 'AGR-12345',
      hectarage: 1.5,
      contractor: 'Tobacco Merchant',
      gpsLat: -17.8,
      gpsLng: 31.05,
    }
    const agriRows = treatyRows([agriPolicy], byId)
    const headers = treatyHeaders('annual')
    expect(headers).toContain('ANNUAL PREMIUM')
    expect(agriRows[0]).toHaveLength(TREATY_HEADERS.length)
    expect(agriRows[0][COL.grower]).toBe('AGR-12345')
    expect(agriRows[0][COL.hectarage]).toBe(1.5)
    expect(agriRows[0][COL.contractor]).toBe('Tobacco Merchant')
    expect(agriRows[0][COL.gpsLat]).toBe(-17.8)
    expect(agriRows[0][COL.gpsLng]).toBe(31.05)
  })

  it('exports package participants as insured heads for the negotiated term', () => {
    const schoolTrip: Policy = {
      ...policy,
      coverScope: 'group',
      onceOff: true,
      groupId: 'grp-school',
      groupName: 'Glen View High School',
      productCategory: 'accident',
      startDate: '2026-12-10',
      endDate: '2026-12-20',
      dependants: [
        { name: 'Tendai Chikafu', relationship: 'Participant', dob: '2010-04-02', nationalId: 'A', premium: 30, coverAmount: 1000 },
        { name: 'Rudo Moyo', relationship: 'Participant', dob: '2011-09-14', nationalId: 'B', premium: 25, coverAmount: 1000 },
      ],
    }
    const packageRows = treatyRows([schoolTrip], byId)
    expect(packageRows).toHaveLength(2)
    expect(packageRows.map(r => r[COL.designation])).toEqual(['PRINCIPAL MEMBER', 'PRINCIPAL MEMBER'])
    expect(packageRows.map(r => r[COL.grower])).toEqual(['', ''])
    expect(packageRows.map(r => r[COL.period])).toEqual([1, 1])
    expect(packageRows.map(r => r[COL.premium])).toEqual([30, 25])
    expect(treatyHeaders('term')).toContain('TERM PREMIUM')
    expect(treatyHeaders('mixed')).toContain('PREMIUM')
  })
})
