import { describe, expect, it } from 'vitest'
import { isInternalAuthEmail, roleChain, rolesInChain, sameRoleChain, signInSuffix } from './accountIdentity.js'

describe('account identity role chains', () => {
  it('separates customers from staff and agents', () => {
    expect(sameRoleChain('policyholder', 'agent')).toBe(false)
    expect(sameRoleChain('policyholder', 'policy_admin')).toBe(false)
    expect(sameRoleChain('policy_admin', 'finance')).toBe(true)
    expect(sameRoleChain('agent', 'agent')).toBe(true)
  })

  it('groups work roles separately from system roles and agents', () => {
    expect(roleChain('client_relations')).toBe('staff')
    expect(roleChain('admin')).toBe('system')
    expect(roleChain('agent')).toBe('agent')
    expect(rolesInChain('finance')).toContain('policy_admin')
    expect(rolesInChain('finance')).not.toContain('agent')
  })

  it('uses role-specific sign-in suffixes and internal auth domains', () => {
    expect(signInSuffix('agent')).toBe('Agent')
    expect(signInSuffix('policyholder')).toBe('Client')
    expect(isInternalAuthEmail('agent-jane-doe-x1y2z3@agent.motions.local')).toBe(true)
    expect(isInternalAuthEmail('staff-jane-doe-x1y2z3@account.motions.local')).toBe(true)
    expect(isInternalAuthEmail('jane@example.com')).toBe(false)
  })
})
