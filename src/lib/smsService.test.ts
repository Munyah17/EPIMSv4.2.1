import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { sendSms, sendBulkSms, getSmsLog, clearSmsLog, getSmsSettings, saveSmsSettings } from './smsService'

/** Replies exactly as the live Afrosoft gateway does, via the shape our
 *  /api/gateway-proxy relay returns. */
function mockGateway(afrosoftBody: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => ({ status: 200, ok: true, body: JSON.stringify(afrosoftBody) }),
  } as Response)
}

describe('smsService', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('ships with the Afrosoft account domain and API key configured', () => {
    expect(getSmsSettings().domain).toBe('sms.vas.co.zw')
    expect(getSmsSettings().apiKey).toBeTruthy()
  })

  /** Simulation is the fallback whenever the gateway isn't fully configured,
   *  so these force that state rather than relying on the shipped defaults. */
  const useSimulationMode = () => saveSmsSettings({ apiKey: '', domain: '', senderId: '' })

  it('simulates sending when the gateway is not configured, and logs it as simulated', async () => {
    useSimulationMode()
    const result = await sendSms('+263770000000', 'Hello')
    expect(result.success).toBe(true)
    expect(result.simulated).toBe(true)

    const log = getSmsLog()
    expect(log[0].status).toBe('simulated')
    expect(log[0].to).toBe('+263770000000')
  })

  it('clearSmsLog() empties the log', async () => {
    useSimulationMode()
    await sendSms('+263770000000', 'Hello')
    expect(getSmsLog().length).toBeGreaterThan(0)
    clearSmsLog()
    expect(getSmsLog()).toEqual([])
  })

  /** Regression: Afrosoft is sent "263780086176" and reports it back as
   *  "+263780086176". Matching those two as strings marked every delivered
   *  message as failed. This is the exact live response for a success. */
  it('counts a message as sent when the gateway echoes the number back with a + prefix', async () => {
    mockGateway({
      status: { 'error-code': '000', 'error-status': 'Success', 'error-description': 'Success' },
      'sms-response-details': [{
        'success-count': '1',
        'failed-sms-details': [],
        'sent-sms-details': [{ 'sms-client-id': 'abc', 'message-id': 'msg-1', 'mobile-no': '+263780086176' }],
      }],
    })

    const result = await sendSms('+263780086176', 'Hello')
    expect(result.success).toBe(true)
    expect(result.messageId).toBe('msg-1')
    expect(getSmsLog()[0].status).toBe('sent')
  })

  it('records the gateway\'s own reason against a message it refused', async () => {
    mockGateway({
      status: { 'error-code': '002', 'error-status': 'invalid', 'error-description': 'mobiles is invalid, mobile no min length :{10}' },
      'sms-response-details': [{
        'success-count': '0',
        'failed-sms-details': [{ count: '1', reasons: [{ 'mobile-no': '+263770000001', 'failed-reason': 'Number is not reachable' }] }],
        'sent-sms-details': [],
      }],
    })

    const result = await sendSms('0770000001', 'Hello')
    expect(result.success).toBe(false)
    expect(result.error).toBe('Number is not reachable')
    expect(getSmsLog()[0].error).toBe('Number is not reachable')
  })

  /** An unrecognised sender ID must never stop a message going out: the
   *  service drops it, forgets it, and resends on the account default. */
  it('retries without the sender ID when Afrosoft rejects it, and forgets the bad value', async () => {
    saveSmsSettings({ apiKey: 'k', domain: 'sms.vas.co.zw', senderId: 'TARIQIFY' })
    const rejected = {
      status: { 'error-code': '002', 'error-status': 'invalid', 'error-description': 'sender-id is invalid, Must be a valid [sender-id]' },
      'sms-response-details': [{ 'success-count': '0', 'failed-sms-details': [], 'sent-sms-details': [] }],
    }
    const accepted = {
      status: { 'error-code': '000', 'error-status': 'Success', 'error-description': 'Success' },
      'sms-response-details': [{
        'success-count': '1', 'failed-sms-details': [],
        'sent-sms-details': [{ 'message-id': 'msg-9', 'mobile-no': '+263777274385' }],
      }],
    }
    const reply = (body: unknown) => ({ ok: true, json: async () => ({ status: 200, ok: true, body: JSON.stringify(body) }) }) as Response
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(reply(rejected))
      .mockResolvedValueOnce(reply(accepted))

    const result = await sendSms('+263777274385', 'Hello')

    expect(result.success).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // The retry must not carry the rejected sender ID...
    expect(String(fetchMock.mock.calls[1]?.[1]?.body)).not.toContain('senderid')
    // ...and it must not be left in settings to break the next send.
    expect(getSmsSettings().senderId).toBe('')
  })

  it('reports per-number outcomes across a bulk send', async () => {
    mockGateway({
      status: { 'error-code': '000', 'error-status': 'Success', 'error-description': 'Success' },
      'sms-response-details': [{
        'success-count': '1',
        'failed-sms-details': [{ count: '1', reasons: [{ 'mobile-no': '+263771111111', 'failed-reason': 'Blacklisted' }] }],
        'sent-sms-details': [{ 'message-id': 'msg-2', 'mobile-no': '+263772222222' }],
      }],
    })

    const bulk = await sendBulkSms(['0771111111', '0772222222'], 'Hello')
    expect(bulk.sent).toBe(1)
    expect(bulk.failed).toBe(1)
    expect(bulk.results.find(r => r.phone === '0772222222')?.result.success).toBe(true)
    expect(bulk.results.find(r => r.phone === '0771111111')?.result.error).toBe('Blacklisted')
  })
})
