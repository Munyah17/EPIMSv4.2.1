import { describe, it, expect, beforeEach } from 'vitest'
import { sendSms, getSmsLog, clearSmsLog, getSmsSettings } from './smsService'

describe('smsService', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defaults to no account domain configured', () => {
    expect(getSmsSettings().domain).toBe('')
  })

  it('simulates sending when no account domain is configured, and logs it as simulated', async () => {
    const result = await sendSms('+263770000000', 'Hello')
    expect(result.success).toBe(true)
    expect(result.simulated).toBe(true)

    const log = getSmsLog()
    expect(log[0].status).toBe('simulated')
    expect(log[0].to).toBe('+263770000000')
  })

  it('clearSmsLog() empties the log', async () => {
    await sendSms('+263770000000', 'Hello')
    expect(getSmsLog().length).toBeGreaterThan(0)
    clearSmsLog()
    expect(getSmsLog()).toEqual([])
  })
})
