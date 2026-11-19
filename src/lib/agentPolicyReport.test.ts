import { describe, expect, it } from 'vitest'
import { AGENT_POLICY_HEADERS, buildAgentPolicyReport, normalizeGrowerNumber } from './agentPolicyReport'

const client = {
  id: 'c1',
  name: 'Tariro Annah Moyo',
  nationalId: '63-1234567-a-89',
  dob: '1990-05-12',
  phone: '0773909307',
  address: '12 Main Street, Harare',
  createdAt: '2025-11-04',
}

const uncoveredClient = {
  ...client,
  id: 'c2',
  name: 'Kudzai Chikafu',
  nationalId: '49-123456-B-12',
  createdAt: '2026-01-01',
}

const policies = [
  {
    id: 'p2',
    clientId: 'c1',
    policyNumber: 'FND-002',
    growerNumber: '12345',
    status: 'waiting_period',
    startDate: '2026-02-10',
    createdAt: '2026-02-01',
  },
  {
    id: 'p1',
    clientId: 'c1',
    policyNumber: 'AGR-001',
    growerNumber: 'v777',
    status: 'active',
    startDate: '2026-01-10',
    createdAt: '2026-01-01',
  },
]

describe('personalised field-agent policy report', () => {
  it('uses the requested personalised columns without an Agent column', () => {
    const { data, error } = buildAgentPolicyReport('Kelvin Chigodo', [client], [])
    expect(error).toBeNull()
    expect(data?.headers).toEqual([
      'Name', 'Surname', 'Date of Birth', 'ID No.', "Grower's Number",
      'Phone No.', 'Address', 'Status', 'Reg Date', 'Policy Number',
    ])
    expect(AGENT_POLICY_HEADERS).not.toContain('Agent')
    expect(data?.metadata[0]).toEqual(['Field Agent', 'Kelvin Chigodo'])
  })

  it('emits one row per policy with canonical ID and grower number', () => {
    const { data, error } = buildAgentPolicyReport('Kelvin Chigodo', [client], policies)
    expect(error).toBeNull()
    expect(data?.rows).toHaveLength(2)
    expect(data?.rows[0]).toEqual([
      'Tariro',
      'Annah Moyo',
      '12-MAY-1990',
      '631234567A89',
      'V777',
      '0773909307',
      '12 Main Street, Harare',
      'Active',
      '01-JAN-2026',
      'AGR-001',
    ])
    expect(data?.rows[1][7]).toBe('Waiting Period')
    expect(data?.rows[1][4]).toBe('V12345')
  })

  it('keeps clients who have no policy in the agent book', () => {
    const { data, error } = buildAgentPolicyReport('Kelvin Chigodo', [uncoveredClient], [])
    expect(error).toBeNull()
    expect(data?.rows[0][7]).toBe('No Policy')
    expect(data?.rows[0][8]).toBe('01-JAN-2026')
    expect(data?.rows[0][9]).toBe('')
  })

  it('flags malformed national IDs in the report instead of stopping export', () => {
    const { data, error } = buildAgentPolicyReport('Kelvin Chigodo', [
      { ...client, nationalId: 'BAD-ID' },
    ], [])
    expect(error).toBeNull()
    expect(data?.rows).toHaveLength(1)
    expect(data?.rows[0][3]).toBe('INVALID: BAD-ID')
    expect(data?.notices[0]).toContain('1 invalid National ID')
    expect(data?.notices[0]).toContain('BAD-ID')
    expect(data?.metadata).toContainEqual(['Notice', data?.notices[0]])
  })

  it('normalises a grower number to always carry the V prefix', () => {
    expect(normalizeGrowerNumber('123')).toBe('V123')
    expect(normalizeGrowerNumber(' v123 ')).toBe('V123')
    expect(normalizeGrowerNumber('AGR 555')).toBe('VAGR555')
    expect(normalizeGrowerNumber('')).toBe('')
  })
})
