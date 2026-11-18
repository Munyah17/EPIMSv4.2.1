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
  accountHolder: 5,
  clientPhone: 6,
  clientStatus: 10,
  policyId: 16,
  policyNumber: 17,
  product: 18,
  category: 19,
  startDate: 21,
  period: 23,
  status: 24,
  grower: 29,
  hectarage: 30,
  contractor: 31,
  sumAssured: 36,
  premium: 37,
  retainedAssured: 39,
  retainedPremium: 40,
  reassured: 41,
  reassuredPremium: 42,
  agent: 46,
  createdAt: 50,
  clientId: 51,
}

describe('major policy report export', () => {
  const byId = new Map([[client.id, client]])
  const rows = treatyRows([policy], byId)

  it('emits one row per insured head with the complete policy register headers', () => {
    expect(rows).toHaveLength(2)
    expect(TREATY_HEADERS).toHaveLength(56)
    expect(TREATY_HEADERS).not.toContain('GENDER')
    expect(TREATY_HEADERS).toContain('HECTARAGE')
    expect(TREATY_HEADERS).toContain('GROWER NO.')
  })

  it('carries person, client and policy details on every row', () => {
    const principal = rows[0]
    expect([principal[0], principal[1]]).toEqual(['Caroline', 'Kabaya'])
    expect(principal[2]).toBe('26-Nov-1982')
    expect(principal[3]).toBe('38210897H38')
    expect(principal[COL.designation]).toBe('PRINCIPAL MEMBER')
    expect(principal[COL.accountHolder]).toBe('Caroline Kabaya')
    expect(principal[COL.clientPhone]).toBe('0772000000')
    expect(principal[COL.clientStatus]).toBe('active')
    expect(principal[COL.policyId]).toBe('p1')
    expect(principal[COL.policyNumber]).toBe('FND-001')
    expect(principal[COL.product]).toBe('Funeral')
    expect(principal[COL.category]).toBe('funeral')
    expect(principal[COL.startDate]).toBe('7-Dec-2026')
    expect(principal[COL.period]).toBe(1)
    expect(principal[COL.status]).toBe('active')
    expect(principal[COL.agent]).toBe('Agent One')
    expect(principal[COL.clientId]).toBe('c1')
  })

  it('designates dependants and splits the 40/60 retention', () => {
    expect(rows[1][COL.designation]).toBe('DEPENDENT SPOUSE')
    expect(rows[1][COL.clientPhone]).toBe('0772000000')
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
    expect(agriRows[0][32]).toBe(-17.8)
    expect(agriRows[0][33]).toBe(31.05)
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
    expect(packageRows.map(r => r[COL.accountHolder])).toEqual(['Glen View High School', 'Glen View High School'])
    expect(packageRows.map(r => r[COL.period])).toEqual([1, 1])
    expect(packageRows.map(r => r[COL.premium])).toEqual([30, 25])
    expect(treatyHeaders('term')).toContain('TERM PREMIUM')
    expect(treatyHeaders('mixed')).toContain('PREMIUM')
  })
})
