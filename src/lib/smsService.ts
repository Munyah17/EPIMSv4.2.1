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

/** Lifecycle context stamped onto each delivery's notification_log row —
 *  the event bucket (registration, payment, renewal, claim, ticket) plus
 *  the policy/claim/ticket number support searches by. Callers that know
 *  the record pass it; test and marketing sends leave it out and land
 *  under 'system'. */
export interface SmsContext {
  event?: string
  ref?: string
}

/** Push one delivery outcome into notification_log (via /api/notify's
 *  logOnly route) with the caller's event/ref attached. Deferred import
 *  keeps the notify.ts -> smsService.ts import one-directional. */
function reportSmsOutcome(phone: string, ctx: SmsContext | undefined, status: 'sent' | 'failed' | 'skipped', detail?: string) {
  void import('./notify').then(({ reportOutcome }) => {
    reportOutcome({ channel: 'sms', recipient: phone, event: ctx?.event ?? 'system', ref: ctx?.ref, status, detail })
  }).catch(() => { /**/ })
}

/** Digits Afrosoft will accept. Invalid input comes back unchanged so the
 *  error still names the number the user typed. */
function normalizeMsisdn(raw: string): string {
  return normalizeZwMobile(raw) ?? raw.replace(/\D/g, '')
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
  return normalizeZwMobile(raw) !== null
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
import { health, isDevOrigin } from './health'
import { normalizeZwMobile, smsParts } from './smsText'

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

async function callAfrosoftOnce(
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
      // 404 means the serverless function isn't on this host at all —
      // dev server, static preview, or a broken deploy. Named as such on
      // ANY host: checking `hostname === 'localhost'` here is what let
      // 127.0.0.1 and LAN IPs keep reporting a fake gateway outage.
      if (res.status === 404) {
        return {
          ok: false,
          error: `The SMS API is not deployed on ${window.location.hostname} — send texts from the live portal (portal.motions.co.zw).`
        }
      }
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
        error: 'The SMS service is not reachable at /api/gateway-proxy — it returned a page instead of a response. Use the deployed site to send real SMS messages. On localhost, SMS will be simulated (logged but not sent).',
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

/** Econet drops a concatenated or Unicode text, so a long alert is sent
 *  as separate single-segment messages. A refused part stops the rest. */
async function callAfrosoft(
  numbers: string[], message: string,
): Promise<{ ok: true; data: AfrosoftResponse } | { ok: false; error: string }> {
  const parts = smsParts(message)
  if (parts.length === 0) return { ok: false, error: 'Message was empty.' }
  let last: { ok: true; data: AfrosoftResponse } | { ok: false; error: string } | null = null
  for (const part of parts) {
    last = await callAfrosoftOnce(numbers, part)
    if (!last.ok) return last
    const code = last.data.status?.['error-code']
    // A non-000 batch verdict still carries per-number detail (002 +
    // failed-sms-details names each refused number and why), so it is
    // NOT flattened into a generic failure here — sendBulkSms reads the
    // details, reports every refusal to notification_log and retries the
    // refused numbers through the /api/notify route (a different egress
    // IP — the one a per-key IP whitelist may still allow).
    if (code && code !== '000') return last
  }
  return last ?? { ok: false, error: 'Message was empty.' }
}

/**
 * Fallback sender: asks /api/notify to send one SMS server-side. Used when
 * the gateway-proxy route fails — different function, same Afrosoft key.
 * The server retries transient failures once and logs the attempt to
 * notification_log, so a failed message leaves a trace an admin can see.
 */
async function sendViaNotify(to: string, message: string, ctx?: SmsContext): Promise<SmsResult> {
  try {
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch('/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}) },
      body: JSON.stringify({ channel: 'sms', recipient: to, text: message, event: ctx?.event ?? 'system', ref: ctx?.ref }),
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
export async function sendSms(to: string, message: string, ctx?: SmsContext): Promise<SmsResult> {
  const bulk = await sendBulkSms([to], message, ctx)
  return bulk.results[0]?.result ?? { success: false, error: 'Send failed' }
}

/**
 * Send the same message to multiple recipients. Afrosoft accepts
 * comma-separated numbers in a single call.
 */
export async function sendBulkSms(numbers: string[], message: string, ctx?: SmsContext): Promise<BulkSmsResult> {
  startOutboxPump()
  // Bad numbers are separated out and reported individually, rather than
  // being sent and taking every other recipient down with them.
  const invalid = numbers.filter(n => !isValidMsisdn(n))
  const valid = numbers.filter(isValidMsisdn)
  const invalidResults = invalid.map(phone => {
    const error = `Not a valid Zimbabwe mobile number (${phone.trim() || 'blank'}); correct it on the client record.`
    logSmsLocally(phone, message, 'failed', error)
    // A number that never reached the gateway is still an attempt the
    // delivery log should show — it is exactly the kind of quiet dead end
    // "the client never got the text" investigations used to hit.
    reportSmsOutcome(phone, ctx, 'failed', error)
    return { phone, result: { success: false, error } }
  })

  if (valid.length === 0) {
    return { sent: 0, failed: invalidResults.length, results: invalidResults }
  }

  // A dev origin has no /api at all — the send can't reach the gateway,
  // the fallback can't reach it either, and queueing it in the outbox
  // would just retry a fetch that will 404 every 3 minutes. Answer
  // honestly instead of cascading into the outage machinery.
  if (isDevOrigin()) {
    const devMsg = `Dev server (${window.location.hostname}) — the SMS API only exists on the deployed portal; nothing was sent.`
    const devResults = valid.map(phone => {
      logSmsLocally(phone, message, 'failed', devMsg)
      return { phone, result: { success: false, error: devMsg } }
    })
    health.record({ ts: Date.now(), type: 'notify', table: 'sms-gateway', success: false, duration: 0, source: 'api', detail: devMsg })
    return { sent: 0, failed: devResults.length + invalidResults.length, results: [...devResults, ...invalidResults] }
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
      const d = await sendViaNotify(phone, message, ctx)
      logSmsLocally(phone, message, d.success ? 'sent' : 'failed', d.error)
      if (!d.success) enqueueOutbox(phone, message, ctx)
      return { phone, result: d }
    }))
    // Health + loudness: if every number failed on both routes the gateway
    // is effectively down — record it, banner it, log it. Actual send failures
    // are stronger evidence than ping failures, so they immediately trigger
    // the down state (bypassing the consecutive failure threshold).
    const anySent = fallback.some(r => r.result.success)
    if (!anySent) {
      consecutiveFailures = CONSECUTIVE_FAILURES_THRESHOLD
    }
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
    // Every outcome lands in notification_log — sent included — mirroring
    // sendEmail. Successes used to exist only in this browser's local
    // history, which made "did the text go out?" unanswerable for staff.
    reportSmsOutcome(phone, ctx, success ? 'sent' : 'failed', error ?? (sentIds.get(key) ? `accepted, message-id ${sentIds.get(key)}` : undefined))
    return {
      phone,
      result: success ? { success: true, messageId: sentIds.get(key) } : { success: false, error },
    }
  })

  const all = [...results, ...invalidResults]
  // Small batches (office alerts — the sends that matter most) get one
  // retry through /api/notify, which runs on a different Vercel egress
  // IP — the route a per-key IP-whitelist refusal can still succeed on.
  // Only numbers Afrosoft actually refused are retried, never a number
  // that failed local validation. Each retry logs its own delivery row.
  const refused = all.filter(r => !r.result.success)
  if (refused.length && valid.length <= 10) {
    for (const r of results.filter(x => !x.result.success)) {
      const d = await sendViaNotify(r.phone, message, ctx)
      if (d.success) {
        r.result = { success: true, messageId: undefined }
        logSmsLocally(r.phone, message, 'sent', 'delivered via notify fallback after gateway refusal')
      }
    }
  }
  // Gateway answered — that's an SMS-gateway success even if individual
  // numbers were refused (a blacklisted number isn't a dead gateway).
  const stillRefused = all.filter(r => !r.result.success).length
  void reportSmsResult(true, stillRefused ? `${stillRefused} of ${all.length} number(s) refused by gateway` : undefined, Date.now() - started)
  return {
    sent: all.filter(r => r.result.success).length,
    failed: all.filter(r => !r.result.success).length,
    results: all,
  }
}

// ── Gateway watch: ask Afrosoft if it's alive, on a timer ────────────
//
// The watch pings Afrosoft every few minutes without spending a text.
// Loud alerts (banner, email, notification_log) only fire when:
//  - A real SMS send fails on all routes (handled in reportSmsResult)
//  - OR the gateway is completely unreachable for multiple consecutive checks
//
// A single ping failure is not an outage — it could be a transient network
// blip or the proxy warming up. We only announce "down" after consecutive
// failures to avoid false alarms that make the monitoring feature noise,
// not signal.
//
// The flag lives in localStorage so a refresh mid-outage re-shows the
// banner instead of forgetting it, and only TRANSITIONS alert — one
// office email per outage, not one per poll.

const GATEWAY_FLAG_KEY = 'tqfy_sms_gateway_down'
const GATEWAY_WATCH_MS = 5 * 60 * 1000
const CONSECUTIVE_FAILURES_THRESHOLD = 3 // Only announce down after 3 consecutive failed pings
export const SMS_GATEWAY_EVENT = 'ims:sms-gateway-status'

export interface GatewayPing {
  up: boolean
  /** Whose problem it is: 'afrosoft' = provider side, 'config'/'us' = ours. */
  source: 'afrosoft' | 'config' | 'us'
  detail: string
  /** The page is running where /api can't exist (dev server, LAN IP) —
   *  the ping says nothing about the real gateway, so the watch must
   *  neither alarm nor count it as a failure. */
  dev?: boolean
}

export function isGatewayFlaggedDown(): boolean {
  try { return localStorage.getItem(GATEWAY_FLAG_KEY) === '1' } catch { return false }
}

export async function pingSmsGateway(): Promise<GatewayPing> {
  // A dev origin can never reach the API — no point fetching, and the
  // answer must NOT read as a gateway problem.
  if (isDevOrigin()) {
    return {
      up: false,
      source: 'us',
      dev: true,
      detail: `Dev server (${window.location.hostname}) — the SMS API only exists on the deployed portal. Send test texts from portal.motions.co.zw.`
    }
  }

  try {
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch('/api/gateway-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}) },
      body: JSON.stringify({ action: 'ping' }),
    })
    if (!res.ok) {
      // The proxy itself failing is OUR side, not Afrosoft's — and a 404
      // means the functions aren't on this deployment at all.
      if (res.status === 404) {
        return { up: false, source: 'us', detail: 'The SMS API is not deployed on this host (HTTP 404) — the serverless functions are missing from this deployment.' }
      }
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
  // Name the actual fault: 'afrosoft' = provider outage; 'config' = OUR
  // side missing credentials — the office must not chase Afrosoft for a
  // key nobody set.
  const isConfig = ping.source === 'config'
  const headline = isConfig ? 'SMS GATEWAY MISCONFIGURED' : 'AFROSOFT SMS GATEWAY IS DOWN'
  reportOutcome({ channel: 'sms', recipient: 'gateway', event: 'system', status: 'failed', detail: `${headline}: ${ping.detail}` })
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
        smsText: `Motions: ${headline} — text messages cannot be delivered. ${ping.detail}`,
        emailSubject: `[${isConfig ? 'SMS CONFIG' : 'AFROSOFT DOWN'}] ${isConfig ? 'SMS gateway missing configuration' : 'SMS gateway unreachable'} — client texts cannot be delivered`,
        emailText: `${isConfig
          ? 'The SMS gateway is not configured correctly — this is OUR side (missing credentials), not an Afrosoft outage.\n\nFix: set AFROSOFT_SMS_API_KEY / AFROSOFT_SMS_DOMAIN on Vercel.'
          : 'The SMS gateway (Afrosoft) is DOWN and cannot deliver text messages.'}\n\nDetail:   ${ping.detail}\nChecked:  ${new Date().toISOString()}\n\nImpact: signup welcomes, payment confirmations, billing reminders and invoice notices will NOT reach clients by SMS until ${isConfig ? 'the configuration is completed' : 'Afrosoft recovers'}. The dashboard banner stays up for the duration.\n\nThis alert fires once per outage, not per check.`,
      }),
    })
  } catch { /**/ }
}

let gatewayWatchStarted = false
let lastGatewayState: 'up' | 'down' | null = isGatewayFlaggedDown() ? 'down' : null
let lastGatewayCheck: { at: number; up: boolean; source: string; detail: string; dev?: boolean } | null = null
let consecutiveFailures = 0

/** What the watch last saw — feeds the dashboard's always-on status row. */
export function getGatewayWatchStatus(): { state: 'up' | 'down' | 'dev' | 'unknown'; checkedAt: number | null; detail: string; source: string } {
  if (!lastGatewayCheck) {
    return { state: lastGatewayState === 'down' ? 'down' : 'unknown', checkedAt: null, detail: 'No check run yet this session.', source: 'us' }
  }
  return {
    state: lastGatewayCheck.dev ? 'dev' : lastGatewayCheck.up ? 'up' : 'down',
    checkedAt: lastGatewayCheck.at,
    detail: lastGatewayCheck.detail,
    source: lastGatewayCheck.source,
  }
}

async function checkGateway() {
  let ping = await pingSmsGateway()

  // A dev host can't have the API — the probe carries zero information
  // about Afrosoft, so it neither counts toward the outage threshold nor
  // raises the banner. The event still goes out with down:false so a tab
  // that WAS showing the banner clears it.
  if (ping.dev) {
    consecutiveFailures = 0
    lastGatewayCheck = { at: Date.now(), up: false, source: ping.source, detail: ping.detail, dev: true }
    lastGatewayState = null
    // A stale flag on this origin (set by an older build's fake outage)
    // would re-raise the banner on every login — dev can never have a
    // real gateway outage, so the flag has no business persisting here.
    try { localStorage.removeItem(GATEWAY_FLAG_KEY) } catch { /**/ }
    window.dispatchEvent(new CustomEvent(SMS_GATEWAY_EVENT, {
      detail: { down: false, source: ping.source, reason: ping.detail, checkedAt: Date.now() },
    }))
    return
  }

  health.record({ ts: Date.now(), type: 'notify', table: 'sms-gateway', success: ping.up, duration: 0, source: 'api', detail: `watch: ${ping.detail}` })
  const state: 'up' | 'down' = ping.up ? 'up' : 'down'
  lastGatewayCheck = { at: Date.now(), up: ping.up, source: ping.source, detail: ping.detail }

  if (state === 'down') {
    consecutiveFailures++
    // Only declare down after consecutive failures to avoid false alarms
    // from transient network blips or cold-start issues
    if (consecutiveFailures >= CONSECUTIVE_FAILURES_THRESHOLD && lastGatewayState !== 'down') {
      // Only a provider-side or missing-config failure declares "Afrosoft
      // down". source 'us' means the browser couldn't reach OUR OWN api —
      // the local network/session, not the gateway; it stays out of the
      // outage flag and never emails the office a false alarm.
      if (ping.source !== 'us') {
        try { localStorage.setItem(GATEWAY_FLAG_KEY, '1') } catch { /**/ }
        void announceGatewayDown(ping)
      }
    }
  } else {
    consecutiveFailures = 0
    if (lastGatewayState === 'down') {
      try { localStorage.removeItem(GATEWAY_FLAG_KEY) } catch { /**/ }
    }
  }
  lastGatewayState = state
  // Every check updates the dashboard row — the banner itself only
  // appears on the down transition, but "last checked" always moves.
  window.dispatchEvent(new CustomEvent(SMS_GATEWAY_EVENT, {
    detail: { down: state === 'down', source: ping.source, reason: ping.detail, checkedAt: Date.now() },
  }))
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

interface OutboxEntry { to: string; message: string; ctx?: SmsContext; ts: number; tries: number }

function readOutbox(): OutboxEntry[] {
  try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? '[]') } catch { return [] }
}

function writeOutbox(entries: OutboxEntry[]) {
  try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(entries.slice(0, 50))) } catch { /**/ }
}

function enqueueOutbox(to: string, message: string, ctx?: SmsContext) {
  const box = readOutbox()
  // Same text to the same number already waiting? Don't double it.
  if (box.some(e => e.to === to && e.message === message)) return
  box.push({ to, message, ctx, ts: Date.now(), tries: 0 })
  writeOutbox(box)
}

async function flushOutbox() {
  const box = readOutbox()
  if (box.length === 0) return
  const kept: OutboxEntry[] = []
  for (const entry of box) {
    if (Date.now() - entry.ts > OUTBOX_MAX_AGE_MS || entry.tries >= OUTBOX_MAX_TRIES) {
      const giveUp = `Outbox gave up after ${entry.tries} tries / ${Math.round((Date.now() - entry.ts) / 3600000)}h — last chance exhausted.`
      logSmsLocally(entry.to, entry.message, 'failed', giveUp)
      reportSmsOutcome(entry.to, entry.ctx, 'failed', giveUp)
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
      const d = await sendViaNotify(entry.to, entry.message, entry.ctx)
      sent = d.success
    }
    if (sent) {
      logSmsLocally(entry.to, entry.message, 'sent', 'delivered by outbox retry')
      reportSmsOutcome(entry.to, entry.ctx, 'sent', 'delivered by outbox retry')
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
