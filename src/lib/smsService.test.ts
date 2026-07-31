import { describe, it, expect, beforeEach } from 'vitest'
import { sendSms, getSmsLog, clearSmsLog, getSmsSettings } from './smsService'

describe('smsService', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defaults to sandbox with no API key configured', () => {
    expect(getSmsSettings().apiKey).toBe('')
    expect(getSmsSettings().sandbox).toBe(true)
  })

  it('simulates sending when no API key is configured, and logs it as simulated', async () => {
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
