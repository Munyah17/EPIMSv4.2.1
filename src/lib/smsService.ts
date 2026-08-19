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

/**
 * Version-suffixed on purpose. Settings saved under the unsuffixed key came
 * from an earlier gateway and carried a sender ID Afrosoft does not
 * recognise, which merged over these defaults and made every send fail with
 * "sender-id is invalid". A new key retires that data instead of asking each
 * user to clear their browser storage by hand.
 */
const SETTINGS_KEY = 'tqfy_sms_settings_afrosoft'
const LEGACY_SETTINGS_KEY = 'tqfy_sms_settings'

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
    localStorage.removeItem(LEGACY_SETTINGS_KEY)
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { ...DEFAULTS }
    const stored = JSON.parse(raw) as Partial<SmsSettings>
    // Only ever take the three fields this gateway understands, so a stray
    // key from an older shape can't reach the request.
    return {
      apiKey: stored.apiKey ?? DEFAULTS.apiKey,
      domain: stored.domain ?? DEFAULTS.domain,
      senderId: stored.senderId ?? DEFAULTS.senderId,
    }
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

/**
 * Afrosoft echoes numbers back in its own format -- it accepts
 * "263780086176" and reports it as "+263780086176". Comparing the sent and
 * returned strings directly marks genuinely delivered messages as failed,
 * so both sides are reduced to the last 9 digits (the subscriber number,
 * which is stable across +263 / 263 / 0 prefixes) before matching.
 */
function msisdnKey(raw: string): string {
  return raw.replace(/\D/g, '').slice(-9)
}

/**
 * A Zimbabwe mobile number normalises to 263 followed by 9 digits.
 *
 * Worth checking before sending because Afrosoft rejects the whole request
 * when any single recipient is malformed -- one bad number in a contact list
 * otherwise fails the entire campaign, which is precisely what "Sent: 0 |
 * Failed: 9" looks like from the outside.
 */
function isValidMsisdn(raw: string): boolean {
  const digits = normalizeMsisdn(raw)
  return /^263[17]\d{8}$/.test(digits)
}

interface AfrosoftResponse {
  status?: { 'error-code'?: string; 'error-status'?: string; 'error-description'?: string }
  'sms-response-details'?: Array<{
    'success-count'?: string
    'sent-sms-details'?: Array<{ 'sms-client-id'?: string; 'message-id'?: string; 'mobile-no'?: string }>
    'failed-sms-details'?: Array<{ count?: string; reasons?: Array<{ 'sms-client-id'?: string; 'mobile-no'?: string; 'failed-reason'?: string }> }>
  }>
}

/** True when Afrosoft's complaint is specifically about the sender ID. */
function isSenderIdRejection(data: AfrosoftResponse): boolean {
  const texts = [
    data.status?.['error-description'] ?? '',
    ...(data['sms-response-details']?.[0]?.['failed-sms-details'] ?? [])
      .flatMap(f => f.reasons ?? []).map(r => r['failed-reason'] ?? ''),
  ]
  return texts.some(t => /sender[-\s]?id/i.test(t))
}

async function callAfrosoft(
  numbers: string[], message: string, cfg: SmsSettings, senderIdOverride?: string,
): Promise<{ ok: true; data: AfrosoftResponse } | { ok: false; error: string }> {
  const senderId = senderIdOverride !== undefined ? senderIdOverride : cfg.senderId
  const mobiles = numbers.map(normalizeMsisdn).join(',')
  const params = new URLSearchParams({
    apikey: cfg.apiKey,
    mobiles,
    sms: message,
    ...(senderId ? { senderid: senderId } : {}),
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

  // Bad numbers are separated out and reported individually, rather than
  // being sent and taking every other recipient down with them.
  const invalid = numbers.filter(n => !isValidMsisdn(n))
  const valid = numbers.filter(isValidMsisdn)
  const invalidResults = invalid.map(phone => {
    const error = `Not a valid Zimbabwe mobile number (${phone.trim() || 'blank'}); correct it on the client record.`
    logSmsLocally(phone, message, 'failed', error)
    return { phone, result: { success: false, error } }
  })

  if (valid.length === 0) {
    return { sent: 0, failed: invalidResults.length, results: invalidResults }
  }

  let result = await callAfrosoft(valid, message, cfg)

  // A sender ID Afrosoft doesn't recognise must never be the reason a
  // message fails to go out. If that's the complaint, drop it, clear it
  // from the saved settings so it can't bite again, and resend using the
  // account's own default sender ID.
  if (result.ok && cfg.senderId && isSenderIdRejection(result.data)) {
    console.warn(`[SMS] Afrosoft rejected sender ID "${cfg.senderId}"; clearing it and resending with the account default.`)
    saveSmsSettings({ ...cfg, senderId: '' })
    result = await callAfrosoft(valid, message, cfg, '')
  }

  if (!result.ok) {
    valid.forEach(n => logSmsLocally(n, message, 'failed', result.error))
    const failedResults = valid.map(phone => ({ phone, result: { success: false, error: result.error } }))
    return { sent: 0, failed: failedResults.length + invalidResults.length, results: [...failedResults, ...invalidResults] }
  }

  const errorCode = result.data.status?.['error-code']
  const detail = result.data['sms-response-details']?.[0]
  const sentIds = new Map((detail?.['sent-sms-details'] ?? []).map(s => [msisdnKey(s['mobile-no'] ?? ''), s['message-id']]))
  const failedReasons = new Map(
    (detail?.['failed-sms-details'] ?? []).flatMap(f => f.reasons ?? []).map(r => [msisdnKey(r['mobile-no'] ?? ''), r['failed-reason']]),
  )

  // A per-number reason ("Blacklisted", "Number is not reachable") is what
  // someone can actually act on, so it always wins over the request-level
  // description, which only stands in when the gateway rejected the batch
  // outright and named no individual number.
  const batchReason = result.data.status?.['error-description']
    || (errorCode && errorCode !== '000' ? `Afrosoft error ${errorCode}` : undefined)

  const results = valid.map(phone => {
    const key = msisdnKey(phone)
    const success = sentIds.has(key)
    const error = success
      ? undefined
      : failedReasons.get(key)
        ?? batchReason
        ?? 'Afrosoft accepted the request but did not confirm this number as sent.'
    logSmsLocally(phone, message, success ? 'sent' : 'failed', error)
    return {
      phone,
      result: success ? { success: true, messageId: sentIds.get(key) } : { success: false, error },
    }
  })

  const all = [...results, ...invalidResults]
  return {
    sent: all.filter(r => r.result.success).length,
    failed: all.filter(r => !r.result.success).length,
    results: all,
  }
}

// ── Local SMS log (for audit / history) ────────────────────────────

const LOG_KEY = 'tqfy_sms_log'

export interface SmsLogEntry {
  id: string
  to: string
  message: string
  status: 'sent' | 'failed' | 'simulated'
  /** Why it failed, straight from the gateway where it said so — a log
   *  that only says "failed" gives nobody anything to act on. */
  error?: string
  ts: string
}

function logSmsLocally(to: string, message: string, status: SmsLogEntry['status'], error?: string) {
  try {
    const log: SmsLogEntry[] = JSON.parse(localStorage.getItem(LOG_KEY) ?? '[]')
    log.unshift({ id: `sms_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, to, message, status, error, ts: new Date().toISOString() })
    localStorage.setItem(LOG_KEY, JSON.stringify(log.slice(0, 200)))
  } catch { /**/ }
}

export function getSmsLog(): SmsLogEntry[] {
  try { return JSON.parse(localStorage.getItem(LOG_KEY) ?? '[]') } catch { return [] }
}

export function clearSmsLog() {
  try { localStorage.removeItem(LOG_KEY) } catch { /**/ }
}
