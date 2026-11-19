import { describe, expect, it } from 'vitest'
import { POLICY_DUMP_HEADERS, policyDumpRows } from './policyDumpReport'
import type { Client, Policy } from '../types'

const client: Client = {
  id: 'c1',
  name: 'Tariro Annah Moyo',
  nationalId: '631234567A89',
  dob: '1990-05-12',
  phone: '0773909307',
  address: '12 Main Street, Harare',
  status: 'active',
  policyCount: 2,
  createdAt: '2025-12-01',
} as Client

const policy: Policy = {
  id: 'p1',
  policyNumber: 'AGR-001',
  clientId: 'c1',
  clientName: client.name,
  productId: 'prod1',
  productName: 'Tobacco',
  premium: 100,
  coverAmount: 1000,
  startDate: '2026-01-10',
  endDate: '2027-01-10',
  status: 'active',
  dependants: [],
  paymentMethod: 'EcoCash',
  growerNumber: '12345',
  agentName: 'Kelvin Chigodo',
  capturedByName: 'Staff One',
  createdAt: '2026-01-01',
} as Policy

describe('all-policies operational dump', () => {
  it('uses the requested columns', () => {
    expect([...POLICY_DUMP_HEADERS]).toEqual([
      'Name', 'Surname', 'DOB', 'Grower No.', 'Phone', 'Address',
      'Status', 'Agent Name', 'Captured By', 'Reg Date',
      'Policy Count', 'Policy Number',
    ])
    expect(POLICY_DUMP_HEADERS).not.toContain('Product')
    expect(POLICY_DUMP_HEADERS).not.toContain('Agent ID')
  })

  it('emits holder identity, attribution and total policy count on each policy row', () => {
    const second: Policy = {
      ...policy,
      id: 'p2',
      policyNumber: 'FND-002',
      status: 'waiting_period',
      growerNumber: 'v777',
    }
    const rows = policyDumpRows([policy, second], new Map([[client.id, client]]))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual([
      'Tariro',
      'Annah Moyo',
      '12-MAY-1990',
      'V12345',
      '0773909307',
      '12 Main Street, Harare',
      'Active',
      'Kelvin Chigodo',
      'Staff One',
      '01-JAN-2026',
      2,
      'AGR-001',
    ])
    expect(rows[1][3]).toBe('V777')
    expect(rows[1][6]).toBe('Waiting Period')
    expect(rows[1][10]).toBe(2)
  })

  it('marks website purchases without a staff capturer as self signup', () => {
    const websitePolicy: Policy = {
      ...policy,
      capturedById: undefined,
      capturedByName: undefined,
      agentId: undefined,
      agentName: undefined,
      source: 'motions_website',
    }
    const rows = policyDumpRows([websitePolicy], new Map([[client.id, client]]))
    expect(rows[0][7]).toBe('')
    expect(rows[0][8]).toBe('Self Signup')
  })

  it('keeps a policy row usable when the client read is unavailable', () => {
    const rows = policyDumpRows([policy], new Map())
    expect(rows[0][0]).toBe('Tariro')
    expect(rows[0][1]).toBe('Annah Moyo')
    expect(rows[0][2]).toBe('—')
    expect(rows[0][4]).toBe('')
    expect(rows[0][10]).toBe(1)
  })
})
