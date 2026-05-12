/**
 * SMS Service — Africa's Talking Gateway
 *
 * Free sandbox: https://sandbox.africastalking.com
 * Production:   https://api.africastalking.com
 *
 * To use:
 *  1. Sign up at https://africastalking.com (free)
 *  2. Create an app and get your API key
 *  3. Configure credentials in Billing & Reminders settings
 */

const SETTINGS_KEY = 'tqfy_sms_settings'

export interface SmsSettings {
  apiKey: string
  username: string
  senderId: string
  sandbox: boolean
}

const DEFAULTS: SmsSettings = {
  apiKey: '',
  username: 'sandbox',
  senderId: 'TARIQIFY',
  sandbox: true,
}

export function getSmsSettings(): SmsSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch { /**/ }
  return { ...DEFAULTS }
}

export function saveSmsSettings(s: SmsSettings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)) } catch { /**/ }
}

export interface SmsResult {
  success: boolean
  messageId?: string
  cost?: string
  error?: string
  simulated?: boolean
}

export interface BulkSmsResult {
  sent: number
  failed: number
  results: Array<{ phone: string; result: SmsResult }>
}

/**
 * Send a single SMS via Africa's Talking.
 * Falls back to simulation (console log + local record) if not configured.
 */
export async function sendSms(to: string, message: string): Promise<SmsResult> {
  const cfg = getSmsSettings()

  if (!cfg.apiKey) {
    // Simulation mode — record in console, no real SMS
    console.info(`[SMS SIM] To: ${to} | ${message}`)
    logSmsLocally(to, message, 'simulated')
    return { success: true, simulated: true, messageId: `sim_${Date.now()}` }
  }

  const baseUrl = cfg.sandbox
    ? 'https://api.sandbox.africastalking.com/version1/messaging'
    : 'https://api.africastalking.com/version1/messaging'

  const params = new URLSearchParams({
    username: cfg.username,
    to,
    message,
    ...(cfg.senderId ? { from: cfg.senderId } : {}),
  })

  try {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'apiKey': cfg.apiKey,
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    })

    if (!res.ok) {
      const text = await res.text()
      logSmsLocally(to, message, 'failed')
      return { success: false, error: `HTTP ${res.status}: ${text}` }
    }

    const data = await res.json()
    const recipient = data?.SMSMessageData?.Recipients?.[0]
    const success = recipient?.status === 'Success' || recipient?.statusCode === 101

    logSmsLocally(to, message, success ? 'sent' : 'failed')
    return {
      success,
      messageId: recipient?.messageId,
      cost: recipient?.cost,
      error: success ? undefined : recipient?.status,
    }
  } catch (e) {
    logSmsLocally(to, message, 'failed')
    return { success: false, error: String(e) }
  }
}

/**
 * Send the same message to multiple recipients.
 */
export async function sendBulkSms(numbers: string[], message: string): Promise<BulkSmsResult> {
  const cfg = getSmsSettings()

  if (!cfg.apiKey) {
    numbers.forEach(n => logSmsLocally(n, message, 'simulated'))
    return {
      sent: numbers.length,
      failed: 0,
      results: numbers.map(phone => ({ phone, result: { success: true, simulated: true, messageId: `sim_${Date.now()}` } })),
    }
  }

  // Africa's Talking accepts comma-separated recipients in a single call
  const to = numbers.join(',')
  const singleResult = await sendSms(to, message)
  return {
    sent: singleResult.success ? numbers.length : 0,
    failed: singleResult.success ? 0 : numbers.length,
    results: numbers.map(phone => ({ phone, result: singleResult })),
  }
}

// ── Local SMS log (for audit / history) ────────────────────────────

const LOG_KEY = 'tqfy_sms_log'

export interface SmsLogEntry {
  id: string
  to: string
  message: string
  status: 'sent' | 'failed' | 'simulated'
  ts: string
}

function logSmsLocally(to: string, message: string, status: SmsLogEntry['status']) {
  try {
    const log: SmsLogEntry[] = JSON.parse(localStorage.getItem(LOG_KEY) ?? '[]')
    log.unshift({ id: `sms_${Date.now()}`, to, message, status, ts: new Date().toISOString() })
    localStorage.setItem(LOG_KEY, JSON.stringify(log.slice(0, 200)))
  } catch { /**/ }
}

export function getSmsLog(): SmsLogEntry[] {
  try { return JSON.parse(localStorage.getItem(LOG_KEY) ?? '[]') } catch { return [] }
}

export function clearSmsLog() {
  try { localStorage.removeItem(LOG_KEY) } catch { /**/ }
}
