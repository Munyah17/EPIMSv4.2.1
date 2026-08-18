import { describe, it, expect, beforeEach } from 'vitest'
import { sendSms, getSmsLog, clearSmsLog, getSmsSettings, saveSmsSettings } from './smsService'

describe('smsService', () => {
  beforeEach(() => {
    localStorage.clear()
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
})
