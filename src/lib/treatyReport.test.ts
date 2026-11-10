import { describe, it, expect } from 'vitest'
import { treatyRows, treatyHeaders, TREATY_HEADERS } from './treatyReport'
import type { Policy, Client } from '../types'

const client: Client = {
  id: 'c1', name: 'Caroline Kabaya', nationalId: '38210897h38',
  phone: '0772000000', dob: '1982-11-26', gender: 'Female',
  address: '', occupation: '', policyCount: 1, status: 'active',
  createdAt: '2026-01-01',
} as Client

const policy: Policy = {
  id: 'p1', policyNumber: 'FND-001', clientId: 'c1', clientName: 'Caroline Kabaya',
  productId: 'x', productName: 'Funeral', productCategory: 'funeral',
  premium: 1, coverAmount: 500,
  startDate: '2026-12-07', endDate: '2027-12-07', status: 'active',
  dependants: [
    { name: 'Rosemary Karikoga', relationship: 'Spouse', dob: '1980-05-10', gender: 'Female', nationalId: '49-053220 R 49', premium: 1, coverAmount: 500 },
  ],
  paymentMethod: 'EcoCash', coverScope: 'individual', createdAt: '2026-12-07',
} as Policy

describe('treaty report export', () => {
  const byId = new Map([[client.id, client]])
  const rows = treatyRows([policy], byId)

  it('emits one row per insured head with the template headers', () => {
    expect(rows).toHaveLength(2)
    expect(TREATY_HEADERS).toHaveLength(17)
  })

  it('formats every date as d-MMM-yyyy and normalises the ID', () => {
    const [name, surname, dob, id, gender, , , designation, commence, period, assured, premium] = rows[0]
    expect([name, surname]).toEqual(['Caroline', 'Kabaya'])
    expect(dob).toBe('26-Nov-1982')
    expect(commence).toBe('7-Dec-2026')
    expect(id).toBe('38210897H38')
    expect([gender, designation, period, assured, premium]).toEqual(['Female', 'PRINCIPAL MEMBER', 1, 500, 1])
  })

  it('designates dependants and splits the 40/60 retention', () => {
    expect(rows[1][7]).toBe('DEPENDENT SPOUSE')
    expect(rows[1][4]).toBe('Female')
    // 500 assured at 40% retained / 60% ceded; 1 premium likewise
    expect([rows[1][13], rows[1][15]]).toEqual([200, 300])
    expect([rows[1][14], rows[1][16]]).toEqual([0.4, 0.6])
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
    expect(packageRows.map(r => r[7])).toEqual(['PRINCIPAL MEMBER', 'PRINCIPAL MEMBER'])
    expect(packageRows.map(r => r[9])).toEqual([1, 1])
    expect(packageRows.map(r => r[11])).toEqual([30, 25])
    expect(treatyHeaders('term')).toContain('TERM PREMIUM')
    expect(treatyHeaders('mixed')).toContain('PREMIUM')
  })
})
