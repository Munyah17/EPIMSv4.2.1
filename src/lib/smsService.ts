/**
 * SMS Service — Afrosoft Aggregator V4 HTTP API.
 *
 * The browser no longer holds any gateway credentials: it asks
 * /api/gateway-proxy to send, and the server supplies the key from
 * AFROSOFT_SMS_API_KEY. Configuration that lived in localStorage meant
 * every device had to be set up separately and one blank save silently
 * stopped all SMS while still reporting success.
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
  apiKey: '',
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

/**
 * Hands the send to the server, which holds the Afrosoft key.
 *
 * Nothing about the gateway is configured in the browser any more: the
 * credentials used to live in localStorage, so every device needed setting
 * up and a single blank save dropped sending into simulation mode without
 * anyone noticing messages had stopped going out.
 */
import { supabase } from './supabase'
import { health } from './health'

/** Push an SMS gateway result into System Health, and when it failed, make
 *  it loud — the notify-failed event (dashboard toast/banner) plus a
 *  notification_log row so the failure outlives this browser session.
 *  notify.ts imports this file, so the import is deferred — a static one
 *  would be circular. */
async function reportSmsResult(ok: boolean, detail: string | undefined, durationMs: number) {
  health.record({ ts: Date.now(), type: 'notify', table: 'sms-gateway', success: ok, duration: durationMs, source: 'api', detail })
  if (ok) return
  const { reportOutcome } = await import('./notify')
  reportOutcome({ channel: 'sms', recipient: 'gateway', event: 'system', status: 'failed', detail })
}

async function callAfrosoft(
  numbers: string[], message: string,
): Promise<{ ok: true; data: AfrosoftResponse } | { ok: false; error: string }> {
  const mobiles = numbers.map(normalizeMsisdn).join(',')

  try {
    // /api/gateway-proxy requires a signed-in user — the send goes out on
    // our Afrosoft key, so it is never open to anonymous callers.
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch('/api/gateway-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}) },
      body: JSON.stringify({ action: 'sms', mobiles, message }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      return { ok: false, error: (err as { error?: string })?.error ?? `Gateway proxy error (HTTP ${res.status})` }
    }

    // A plain `vite` dev server has no serverless functions, so it answers
    // /api/* with the app's own HTML shell — a 200 that is not JSON. Parsing
    // that throws "Unexpected token <", which tells nobody anything, so the
    // failure is named instead: sending needs the API running.
    let envelope: { status: number; ok: boolean; body: string }
    try {
      envelope = await res.json() as { status: number; ok: boolean; body: string }
    } catch {
      return {
        ok: false,
        error: 'The SMS service is not reachable at /api/gateway-proxy — it returned a page instead of a response. Use the deployed site, or run the dev server with API functions enabled.',
      }
    }
    const { status, ok, body } = envelope
    if (!ok) return { ok: false, error: `Afrosoft HTTP ${status}: ${body.slice(0, 200)}` }
    const data = JSON.parse(body) as AfrosoftResponse
    return { ok: true, data }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

/**
 * Fallback sender: asks /api/notify to send one SMS server-side. Used when
 * the gateway-proxy route fails — different function, same Afrosoft key.
 * The server retries transient failures once and logs the attempt to
 * notification_log, so a failed message leaves a trace an admin can see.
 */
async function sendViaNotify(to: string, message: string): Promise<SmsResult> {
  try {
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch('/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}) },
      body: JSON.stringify({ channel: 'sms', recipient: to, text: message, event: 'system' }),
    })
    const body = await res.json().catch(() => ({})) as { ok?: boolean; delivery?: { status?: string; detail?: string } }
    if (body.ok && body.delivery?.status === 'sent') return { success: true }
    return { success: false, error: body.delivery?.detail ?? `notify fallback failed (HTTP ${res.status})` }
  } catch (e) {
    return { success: false, error: `notify fallback unreachable: ${e}` }
  }
}

/**
 * Send a single SMS via Afrosoft.
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
  startOutboxPump()
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

  const started = Date.now()
  const result = await callAfrosoft(valid, message)

  if (!result.ok) {
    // Second route before calling it dead: /api/notify's single-channel
    // sender hits Afrosoft through a different function, so a proxy
    // outage (expired session, cold-start 5xx, dev server) doesn't stop
    // the message from going out. Only transport-level failures retry —
    // a number Afrosoft refused is refused for good.
    const fallback = await Promise.all(valid.map(async phone => {
      const d = await sendViaNotify(phone, message)
      logSmsLocally(phone, message, d.success ? 'sent' : 'failed', d.error)
      if (!d.success) enqueueOutbox(phone, message)
      return { phone, result: d }
    }))
    // Health + loudness: if every number failed on both routes the gateway
    // is effectively down — record it, banner it, log it.
    const anySent = fallback.some(r => r.result.success)
    void reportSmsResult(anySent, anySent ? undefined : `All routes failed for ${valid.length} number(s): ${result.error}`, Date.now() - started)
    return {
      sent: fallback.filter(r => r.result.success).length,
      failed: fallback.filter(r => !r.result.success).length + invalidResults.length,
      results: [...fallback, ...invalidResults],
    }
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
  // Gateway answered — that's an SMS-gateway success even if individual
  // numbers were refused (a blacklisted number isn't a dead gateway).
  void reportSmsResult(true, results.some(r => !r.result.success) ? `${results.filter(r => !r.result.success).length} of ${valid.length} number(s) refused by gateway` : undefined, Date.now() - started)
  return {
    sent: all.filter(r => r.result.success).length,
    failed: all.filter(r => !r.result.success).length,
    results: all,
  }
}

// ── Gateway watch: ask Afrosoft if it's alive, on a timer ────────────
//
// "Is SMS working" cannot only be answered by real sends — between sends
// the gateway could be down and nobody would know until the next signup
// or reminder hit a dead host. This watch pings Afrosoft every few
// minutes without spending a text, and the moment the state CHANGES:
//  - 'afrosoft-down'  → health tracker entry, notification_log row, a
//    persistent dashboard banner, and an office email via /api/notify
//    (SMTP still works when SMS is dead — that is the point of checking
//    whose problem it is)
//  - recovery         → the banner clears and the log says we're back
//
// The flag lives in localStorage so a refresh mid-outage re-shows the
// banner instead of forgetting it, and only TRANSITIONS alert — one
// office email per outage, not one per poll.

const GATEWAY_FLAG_KEY = 'tqfy_sms_gateway_down'
const GATEWAY_WATCH_MS = 5 * 60 * 1000
export const SMS_GATEWAY_EVENT = 'ims:sms-gateway-status'

export interface GatewayPing {
  up: boolean
  /** Whose problem it is: 'afrosoft' = provider side, 'config'/'us' = ours. */
  source: 'afrosoft' | 'config' | 'us'
  detail: string
}

export function isGatewayFlaggedDown(): boolean {
  try { return localStorage.getItem(GATEWAY_FLAG_KEY) === '1' } catch { return false }
}

export async function pingSmsGateway(): Promise<GatewayPing> {
  try {
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch('/api/gateway-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}) },
      body: JSON.stringify({ action: 'ping' }),
    })
    if (!res.ok) {
      // The proxy itself failing (401/500) is OUR side, not Afrosoft's.
      const err = await res.json().catch(() => ({}))
      return { up: false, source: 'us', detail: (err as { error?: string })?.error ?? `Gateway proxy error (HTTP ${res.status})` }
    }
    const body = await res.json().catch(() => null) as { up?: boolean; source?: string; detail?: string } | null
    if (body === null) {
      return { up: false, source: 'us', detail: 'The SMS service is not reachable at /api/gateway-proxy — the API returned a page instead of a response.' }
    }
    return {
      up: !!body.up,
      source: body.source === 'config' ? 'config' : body.source === 'afrosoft' ? 'afrosoft' : 'us',
      detail: body.detail ?? 'No detail returned',
    }
  } catch (e) {
    return { up: false, source: 'us', detail: `Could not reach the SMS service at all: ${e}` }
  }
}

async function announceGatewayDown(ping: GatewayPing) {
  const { reportOutcome } = await import('./notify')
  reportOutcome({ channel: 'sms', recipient: 'gateway', event: 'system', status: 'failed', detail: `AFROSOFT DOWN: ${ping.detail}` })
  // Office email through /api/notify — SMTP is unaffected by the SMS
  // gateway being down, which is exactly why the alert rides it.
  try {
    const { data: { session } } = await supabase.auth.getSession()
    await fetch('/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}) },
      body: JSON.stringify({
        event: 'system', ref: 'sms-gateway',
        notifyClient: false, notifyOffice: true,
        smsText: `Motions: AFROSOFT SMS GATEWAY IS DOWN — text messages cannot be delivered. ${ping.detail}`,
        emailSubject: '[AFROSOFT DOWN] SMS gateway unreachable — client texts cannot be delivered',
        emailText: `The SMS gateway (Afrosoft) is DOWN and cannot deliver text messages.\n\nDetail:   ${ping.detail}\nChecked:  ${new Date().toISOString()}\n\nImpact: signup welcomes, payment confirmations, billing reminders and invoice notices will NOT reach clients by SMS until Afrosoft recovers. The dashboard banner stays up for the duration of the outage.\n\nThis alert fires once per outage, not per check.`,
      }),
    })
  } catch { /**/ }
}

let gatewayWatchStarted = false
let lastGatewayState: 'up' | 'down' | null = isGatewayFlaggedDown() ? 'down' : null

async function checkGateway() {
  const ping = await pingSmsGateway()
  health.record({ ts: Date.now(), type: 'notify', table: 'sms-gateway', success: ping.up, duration: 0, source: 'api', detail: `watch: ${ping.detail}` })
  const state: 'up' | 'down' = ping.up ? 'up' : 'down'

  if (state === 'down' && lastGatewayState !== 'down') {
    try { localStorage.setItem(GATEWAY_FLAG_KEY, '1') } catch { /**/ }
    window.dispatchEvent(new CustomEvent(SMS_GATEWAY_EVENT, { detail: { down: true, source: ping.source, reason: ping.detail } }))
    void announceGatewayDown(ping)
  } else if (state === 'up' && lastGatewayState === 'down') {
    try { localStorage.removeItem(GATEWAY_FLAG_KEY) } catch { /**/ }
    window.dispatchEvent(new CustomEvent(SMS_GATEWAY_EVENT, { detail: { down: false } }))
  }
  lastGatewayState = state
}

export function startGatewayWatch() {
  if (gatewayWatchStarted || typeof window === 'undefined') return
  gatewayWatchStarted = true
  void checkGateway()
  setInterval(() => { void checkGateway() }, GATEWAY_WATCH_MS)
}

// ── SMS outbox: failed sends retry until they land ───────────────────
//
// When BOTH routes (gateway-proxy, then /api/notify) fail, the message is
// not lost — it goes into a persisted outbox that retries every few
// minutes and the moment the browser regains connectivity. Entries die at
// 48 hours or 8 attempts; before that a text is always still trying to
// get out, which is what "the SMS must never silently fail" means when
// the network itself is the problem.

const OUTBOX_KEY = 'tqfy_sms_outbox'
const OUTBOX_MAX_AGE_MS = 48 * 60 * 60 * 1000
const OUTBOX_MAX_TRIES = 8
const OUTBOX_FLUSH_MS = 3 * 60 * 1000

interface OutboxEntry { to: string; message: string; ts: number; tries: number }

function readOutbox(): OutboxEntry[] {
  try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? '[]') } catch { return [] }
}

function writeOutbox(entries: OutboxEntry[]) {
  try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(entries.slice(0, 50))) } catch { /**/ }
}

function enqueueOutbox(to: string, message: string) {
  const box = readOutbox()
  // Same text to the same number already waiting? Don't double it.
  if (box.some(e => e.to === to && e.message === message)) return
  box.push({ to, message, ts: Date.now(), tries: 0 })
  writeOutbox(box)
}

async function flushOutbox() {
  const box = readOutbox()
  if (box.length === 0) return
  const kept: OutboxEntry[] = []
  for (const entry of box) {
    if (Date.now() - entry.ts > OUTBOX_MAX_AGE_MS || entry.tries >= OUTBOX_MAX_TRIES) {
      logSmsLocally(entry.to, entry.message, 'failed', `Outbox gave up after ${entry.tries} tries / ${Math.round((Date.now() - entry.ts) / 3600000)}h — last chance exhausted.`)
      continue
    }
    // Try the primary route, then the notify fallback — same order as a
    // live send, but the entry drops out only when one actually lands.
    const primary = await callAfrosoft([entry.to], entry.message)
    let sent = primary.ok && /"error-code"\s*:\s*"000"/.test(primary.data ? JSON.stringify(primary.data) : '')
    if (primary.ok && !sent) {
      const detail = primary.data['sms-response-details']?.[0]
      sent = (detail?.['sent-sms-details'] ?? []).some(s => msisdnKey(s['mobile-no'] ?? '') === msisdnKey(entry.to))
    }
    if (!sent) {
      const d = await sendViaNotify(entry.to, entry.message)
      sent = d.success
    }
    if (sent) {
      logSmsLocally(entry.to, entry.message, 'sent', 'delivered by outbox retry')
    } else {
      kept.push({ ...entry, tries: entry.tries + 1 })
    }
  }
  writeOutbox(kept)
}

export function getSmsOutboxCount(): number {
  return readOutbox().length
}

let outboxPumpStarted = false
function startOutboxPump() {
  if (outboxPumpStarted || typeof window === 'undefined') return
  outboxPumpStarted = true
  setInterval(() => { void flushOutbox() }, OUTBOX_FLUSH_MS)
  window.addEventListener('online', () => { void flushOutbox() })
  // Catch anything queued before this session opened.
  void flushOutbox()
}

// ── Local SMS log (for audit / history) ────────────────────────────

const LOG_KEY = 'tqfy_sms_log'

export interface SmsLogEntry {
  id: string
  to: string
  message: string
  status: 'sent' | 'failed'
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
