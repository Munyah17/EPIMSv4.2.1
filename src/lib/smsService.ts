/**
 * SMS Service — Afrosoft Aggregator V4 HTTP API
 *
 * Real Afrosoft account credentials (per Afrosoft's HTTP API documentation
 * on file). The {Domain} host is account-specific and is not published in
 * Afrosoft's generic docs — it must be entered below once Afrosoft confirms
 * it, same as the API key.
 *
 * Calls are routed through /api/gateway-proxy (server-side) since Afrosoft's
 * API rejects direct browser calls via CORS, same pattern used for the
 * EcoCash/Paynow gateway calls in paymentGateways.ts.
 */

const SETTINGS_KEY = 'tqfy_sms_settings'

export interface SmsSettings {
  apiKey: string
  /** Afrosoft account domain, e.g. "sms.afrosoft.co.zw" — provided by Afrosoft, not in their generic API docs. */
  domain: string
  /** Leave blank to use the default sender ID assigned to the Afrosoft account. */
  senderId: string
}

const DEFAULTS: SmsSettings = {
  apiKey: '72bb6de19ecf8df8',
  domain: 'sms.vas.co.zw',
  senderId: '',
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
  error?: string
  simulated?: boolean
}

export interface BulkSmsResult {
  sent: number
  failed: number
  results: Array<{ phone: string; result: SmsResult }>
}

/** Zimbabwe MSISDN normalization: strips formatting, converts local 0-prefix to 263 country code. */
function normalizeMsisdn(raw: string): string {
  let digits = raw.replace(/\D/g, '')
  if (digits.startsWith('0')) digits = '263' + digits.slice(1)
  else if (!digits.startsWith('263')) digits = '263' + digits
  return digits
}

interface AfrosoftResponse {
  status?: { 'error-code'?: string; 'error-status'?: string; 'error-description'?: string }
  'sms-response-details'?: Array<{
    'success-count'?: string
    'sent-sms-details'?: Array<{ 'sms-client-id'?: string; 'message-id'?: string; 'mobile-no'?: string }>
    'failed-sms-details'?: Array<{ count?: string; reasons?: Array<{ 'sms-client-id'?: string; 'mobile-no'?: string; 'failed-reason'?: string }> }>
  }>
}

async function callAfrosoft(numbers: string[], message: string, cfg: SmsSettings): Promise<{ ok: true; data: AfrosoftResponse } | { ok: false; error: string }> {
  const mobiles = numbers.map(normalizeMsisdn).join(',')
  const params = new URLSearchParams({
    apikey: cfg.apiKey,
    mobiles,
    sms: message,
    ...(cfg.senderId ? { senderid: cfg.senderId } : {}),
    ...(/[^\x00-\x7F]/.test(message) ? { unicode: 'yes' } : {}),
  })
  const url = `https://${cfg.domain}/client/api/sendmessage?${params.toString()}`

  try {
    const res = await fetch('/api/gateway-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, method: 'GET' }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      return { ok: false, error: (err as { error?: string })?.error ?? `Gateway proxy error (HTTP ${res.status})` }
    }
    const { status, ok, body } = await res.json() as { status: number; ok: boolean; body: string }
    if (!ok) return { ok: false, error: `Afrosoft HTTP ${status}: ${body.slice(0, 200)}` }
    const data = JSON.parse(body) as AfrosoftResponse
    return { ok: true, data }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

/**
 * Send a single SMS via Afrosoft.
 * Falls back to simulation (console log + local record) if not configured.
 */
export async function sendSms(to: string, message: string): Promise<SmsResult> {
  const bulk = await sendBulkSms([to], message)
  return bulk.results[0]?.result ?? { success: false, error: 'Send failed' }
}

/**
 * Send the same message to multiple recipients. Afrosoft accepts
 * comma-separated numbers in a single call.
 */
export async function sendBulkSms(numbers: string[], message: string): Promise<BulkSmsResult> {
  const cfg = getSmsSettings()

  if (!cfg.apiKey || !cfg.domain) {
    // Simulation mode — record in console, no real SMS
    numbers.forEach(n => { console.info(`[SMS SIM] To: ${n} | ${message}`); logSmsLocally(n, message, 'simulated') })
    return {
      sent: numbers.length,
      failed: 0,
      results: numbers.map(phone => ({ phone, result: { success: true, simulated: true, messageId: `sim_${Date.now()}` } })),
    }
  }

  const result = await callAfrosoft(numbers, message, cfg)
  if (!result.ok) {
    numbers.forEach(n => logSmsLocally(n, message, 'failed'))
    return { sent: 0, failed: numbers.length, results: numbers.map(phone => ({ phone, result: { success: false, error: result.error } })) }
  }

  const errorCode = result.data.status?.['error-code']
  const detail = result.data['sms-response-details']?.[0]
  const sentIds = new Map((detail?.['sent-sms-details'] ?? []).map(s => [s['mobile-no'], s['message-id']]))
  const failedReasons = new Map(
    (detail?.['failed-sms-details'] ?? []).flatMap(f => f.reasons ?? []).map(r => [r['mobile-no'], r['failed-reason']]),
  )

  if (errorCode !== '000' && sentIds.size === 0) {
    const reason = result.data.status?.['error-description'] || `Afrosoft error ${errorCode ?? 'unknown'}`
    numbers.forEach(n => logSmsLocally(n, message, 'failed'))
    return { sent: 0, failed: numbers.length, results: numbers.map(phone => ({ phone, result: { success: false, error: reason } })) }
  }

  const results = numbers.map(phone => {
    const norm = normalizeMsisdn(phone)
    const success = sentIds.has(norm)
    logSmsLocally(phone, message, success ? 'sent' : 'failed')
    return {
      phone,
      result: success
        ? { success: true, messageId: sentIds.get(norm) }
        : { success: false, error: failedReasons.get(norm) ?? 'Not confirmed sent by Afrosoft' },
    }
  })

  return {
    sent: results.filter(r => r.result.success).length,
    failed: results.filter(r => !r.result.success).length,
    results,
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
