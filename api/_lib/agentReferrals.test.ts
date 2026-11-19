import { describe, expect, it } from 'vitest'
import {
  AGENT_REFERRAL_CODE_PATTERN,
  AGENT_REFERRAL_EMAILS,
  agentReferralLink,
  agentReferralSms,
  newAgentReferralCode,
  normalizeAgentReferralCode,
  referralDirectoryEmailText,
} from './agentReferrals.js'

describe('field-agent referral links', () => {
  it('normalises pasted codes and query fragments', () => {
    expect(normalizeAgentReferralCode(' mot-ab3d5k7x ')).toBe('MOT-AB3D5K7X')
    expect(normalizeAgentReferralCode('agent=MOT-AB3D5K7X')).toBe('MOT-AB3D5K7X')
    expect(normalizeAgentReferralCode('https://motions.co.zw/apply?agent=MOT-AB3D5K7X&source=share')).toBe('MOT-AB3D5K7X')
    expect(normalizeAgentReferralCode('bad-code')).toBeNull()
    expect(normalizeAgentReferralCode('MOT-0I1L2345')).toBeNull()
  })

  it('generates persistent-format codes without ambiguous characters', () => {
    for (let i = 0; i < 100; i++) {
      expect(newAgentReferralCode()).toMatch(AGENT_REFERRAL_CODE_PATTERN)
    }
  })

  it('builds the public application link and SMS', () => {
    const link = agentReferralLink('MOT-AB3D5K7X')
    expect(link).toBe('https://motions.co.zw/apply?agent=MOT-AB3D5K7X')
    expect(agentReferralSms({ name: 'Agent Example', referralCode: 'MOT-AB3D5K7X' })).toContain(link)
  })

  it('includes every named company recipient and each agent link in the register email', () => {
    expect(AGENT_REFERRAL_EMAILS).toEqual([
      'info@motions.co.zw',
      'a.antipas@motions.co.zw',
      'cady@motions.co.zw',
    ])
    const text = referralDirectoryEmailText([
      { profileId: 'a', name: 'Agent One', email: null, phone: '+263771234567', active: true, territory: 'Harare', referralCode: 'MOT-AB3D5K7X' },
      { profileId: 'b', name: 'Agent Two', email: null, phone: null, active: false, territory: null, referralCode: 'MOT-CD4F6M8Y' },
    ])
    expect(text).toContain('Agent One')
    expect(text).toContain('MOT-AB3D5K7X')
    expect(text).toContain('Agent Two')
    expect(text).toContain('MOT-CD4F6M8Y')
    expect(text).toContain('permanent')
  })
})
