import type { SupabaseClient } from '@supabase/supabase-js'
import { sendMailDirect } from './mailTransport.js'
import { normalizeZwMobile, parseRecipientPhones, smsParts } from '../../src/lib/smsText.js'

/**
 * One place every notification goes through.
 *
 * The old pipeline was three loosely related client-side helpers whose
 * failures were swallowed with `.catch(() => {})` — so "the client never
 * got the confirmation" had no trace anywhere. This dispatcher is
 * different in two ways that matter:
 *
 *   1. Every attempt is written to `notification_log` — sent, failed,
 *      queued, skipped — so the dashboard can banner failures and support
 *      can look a delivery up by recipient.
 *   2. It runs server-side, so it works when nobody has the app open
 *      (webhooks, cron) and it never relies on browser credentials.
 *
 * Channels:
 *   SMS      — Afrosoft, server-side key (AFROSOFT_SMS_API_KEY)
 *   Email    — Graph then SMTP, same transport as /api/send-email
 *   WhatsApp — Meta Cloud API when WHATSAPP_TOKEN + WHATSAPP_PHONE_ID are
 *              set; otherwise the message is logged 'queued' with a
 *              wa.me link a staff member can click to send by hand. A
 *              queued message still reaches the client — it just takes a
 *              human until real credentials exist.
 */

/** Last-resort office lines — used ONLY until Settings → SMS Recipients
 *  is first saved. Once an admin saves a list there (even an empty one),
 *  it is the assignment and these numbers are never consulted again.
 *  Matches the seed list Settings shows on first open. */
export const DEFAULT_OFFICE_PHONES = ['+263780086175', '+263780086176', '+263780086177', '+263780086178']
export const COMPANY_EMAIL = 'info@motions.co.zw'

export type Channel = 'sms' | 'email' | 'whatsapp'
export type DeliveryStatus = 'sent' | 'failed' | 'queued' | 'skipped'

export interface Delivery {
  channel: Channel
  recipient: string
  status: DeliveryStatus
  detail?: string
}

// ── Zimbabwe numbers ────────────────────────────────────────────────

export function normalizeMsisdn(raw: string): string {
  return normalizeZwMobile(raw) ?? raw.replace(/\D/g, '')
}
function isValidMsisdn(raw: string): boolean {
  return normalizeZwMobile(raw) !== null
}

const SMS_EVENT: Record<string, 'registration' | 'payment' | 'claim' | 'system'> = {
  registration: 'registration',
  payment: 'payment',
  renewal: 'payment',
  claim: 'claim',
  ticket: 'system',
  system: 'system',
  recon: 'system',
}

/** Office lines for an event, resolved from Settings → SMS Recipients
 *  (app_settings.notif_settings) and filtered to the event's bucket. The
 *  saved list is the assignment — adding or removing a number takes effect
 *  for website, cron and counter sales alike, and a saved list with nobody
 *  ticked for this event means nobody is texted. Only when NO list has
 *  ever been saved do the default office lines apply. */
async function officeSmsNumbers(admin: SupabaseClient | null, event: string): Promise<string[]> {
  const bucket = SMS_EVENT[event] ?? 'system'
  try {
    if (admin) {
      const { data } = await admin.from('app_settings').select('value').eq('key', 'notif_settings').maybeSingle()
      const value = data?.value as { smsRecipients?: { phone?: string; events?: string[] }[] } | null
      const list = value?.smsRecipients
      // A saved list is the assignment, even when this event has nobody
      // ticked. Falling back to every office line here would text a number
      // an admin had just removed.
      if (Array.isArray(list)) {
        const seen = new Set<string>()
        const out: string[] = []
        for (const r of list) {
          if (!Array.isArray(r?.events) || !r.events.includes(bucket)) continue
          for (const n of parseRecipientPhones(r.phone ?? '')) {
            if (seen.has(n)) continue
            seen.add(n)
            out.push(`+${n}`)
          }
        }
        return out
      }
    }
  } catch { /* fall through to the fixed lines */ }
  return DEFAULT_OFFICE_PHONES
}

// ── Channel senders ─────────────────────────────────────────────────

async function afrosoftOnce(msisdn: string, message: string): Promise<Delivery> {
  const apiKey = process.env.AFROSOFT_SMS_API_KEY
  if (!apiKey) {
    return { channel: 'sms', recipient: msisdn, status: 'failed', detail: 'AFROSOFT_SMS_API_KEY is not configured on the server.' }
  }
  const domain = process.env.AFROSOFT_SMS_DOMAIN || 'sms.vas.co.zw'
  const params = new URLSearchParams({ apikey: apiKey, mobiles: msisdn, sms: message })
  const senderId = process.env.AFROSOFT_SMS_SENDER_ID
  if (senderId) params.set('senderid', senderId)
  if (/[^\x00-\x7F]/.test(message)) params.set('unicode', 'yes')
  try {
    const res = await fetch(`https://${domain}/client/api/sendmessage?${params.toString()}`)
    const body = await res.text()
    // Afrosoft answers 200 even on refusal; the error-code is the verdict.
    if (res.ok && /"error-code"\s*:\s*"000"/.test(body)) {
      return { channel: 'sms', recipient: msisdn, status: 'sent', detail: body.slice(0, 200) }
    }
    const desc = body.match(/"error-description"\s*:\s*"([^"]+)"/)?.[1]
    return { channel: 'sms', recipient: msisdn, status: 'failed', detail: desc ?? `Afrosoft HTTP ${res.status}: ${body.slice(0, 160)}` }
  } catch (e) {
    return { channel: 'sms', recipient: msisdn, status: 'failed', detail: `Gateway unreachable: ${e}` }
  }
}

async function sendOneSms(msisdn: string, message: string): Promise<Delivery> {
  const first = await afrosoftOnce(msisdn, message)
  if (first.status === 'sent') return first
  // A definitive Afrosoft refusal (200 with an error-code, or a named
  // rejection like "Blacklisted") is not retried — retrying a refused
  // number just burns credit. But transport failures — unreachable host,
  // 5xx, a truncated body with no error-code — get one more shot after a
  // pause, because a gateway hiccup must not be the difference between
  // "client got the text" and "nobody knows it never sent".
  const definitive = /error-code|error-description|Afrosoft HTTP 4\d\d/i.test(first.detail ?? '')
  if (definitive) return first
  await new Promise(r => setTimeout(r, 1500))
  const second = await afrosoftOnce(msisdn, message)
  return second.status === 'sent'
    ? { ...second, detail: `sent on retry — first attempt: ${first.detail ?? 'unknown'}` }
    : { ...second, detail: `failed twice — ${first.detail ?? '?'}; then ${second.detail ?? '?'}` }
}

export async function sendSmsAfrosoft(to: string, message: string): Promise<Delivery> {
  const msisdn = normalizeMsisdn(to)
  if (!isValidMsisdn(to)) {
    return { channel: 'sms', recipient: to, status: 'failed', detail: `Not a valid ZW mobile: ${to}` }
  }
  const parts = smsParts(message)
  if (parts.length === 0) {
    return { channel: 'sms', recipient: msisdn, status: 'skipped', detail: 'Empty message.' }
  }
  let last: Delivery = { channel: 'sms', recipient: msisdn, status: 'failed', detail: 'Empty message.' }
  for (const part of parts) {
    last = await sendOneSms(msisdn, part)
    if (last.status !== 'sent') return last
  }
  return last
}

export async function sendEmailDirect(to: string, subject: string, text: string): Promise<Delivery> {
  const result = await sendMailDirect({ to, subject, text, from: 'noreply@motions.co.zw', fromName: 'Motions Microinsurance', replyTo: COMPANY_EMAIL })
  if (result.ok) return { channel: 'email', recipient: to, status: 'sent', detail: `via ${result.via}` }
  return { channel: 'email', recipient: to, status: result.simulated ? 'skipped' : 'failed', detail: result.error }
}

/** WhatsApp Business Cloud API. Without credentials the message is queued
 *  with a wa.me deep link — staff tap it from the outbox and the text is
 *  pre-filled, so the client still hears from us while Meta onboarding
 *  is pending. */
export async function sendWhatsAppCloud(to: string, message: string): Promise<Delivery> {
  const msisdn = normalizeMsisdn(to)
  // Two names for the same credentials: the notify channel pre-dates the
  // chatbot, which introduced WHATSAPP_ACCESS_TOKEN/PHONE_NUMBER_ID.
  // Either pair works — set whichever Meta gives you, never both.
  const token = process.env.WHATSAPP_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN
  const phoneId = process.env.WHATSAPP_PHONE_ID || process.env.WHATSAPP_PHONE_NUMBER_ID
  if (!token || !phoneId) {
    return {
      channel: 'whatsapp', recipient: msisdn, status: 'queued',
      detail: `WhatsApp Business API not configured (WHATSAPP_TOKEN/WHATSAPP_PHONE_ID) — queued for manual send: https://wa.me/${msisdn}?text=${encodeURIComponent(message)}`,
    }
  }
  if (!isValidMsisdn(to)) {
    return { channel: 'whatsapp', recipient: to, status: 'failed', detail: `Not a valid ZW mobile: ${to}` }
  }
  try {
    const res = await fetch(`https://graph.facebook.com/${process.env.WHATSAPP_GRAPH_VERSION || 'v19.0'}/${phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: msisdn,
        type: 'text',
        text: { body: message, preview_url: false },
      }),
    })
    const body = await res.json().catch(() => ({})) as { error?: { message?: string } }
    if (res.ok) return { channel: 'whatsapp', recipient: msisdn, status: 'sent' }
    return { channel: 'whatsapp', recipient: msisdn, status: 'failed', detail: body?.error?.message ?? `Meta HTTP ${res.status}` }
  } catch (e) {
    return { channel: 'whatsapp', recipient: msisdn, status: 'failed', detail: `WhatsApp API unreachable: ${e}` }
  }
}

// ── Logging ─────────────────────────────────────────────────────────

export async function logDelivery(admin: SupabaseClient | null, event: string, ref: string | undefined, d: Delivery) {
  if (!admin) return
  try {
    await admin.from('notification_log').insert({
      event, channel: d.channel, recipient: d.recipient, ref: ref ?? null, status: d.status, detail: d.detail ?? null,
    })
  } catch { /* the log table is additive — a missing migration must not break delivery */ }
}

/** A failed dispatch is itself an event the office needs to know about —
 *  surfaced on the admin dashboard via notification_log, and cross-channel
 *  alerted here: a dead email transport reports by SMS, a dead SMS gateway
 *  reports by email. Each channel is the other's smoke alarm. */
async function alertOfficeOfFailure(admin: SupabaseClient | null, event: string, failures: Delivery[]) {
  if (failures.length === 0) return
  const summary = failures.map(f => `${f.channel}→${f.recipient}`).slice(0, 4).join('; ')
  const emailFailed = failures.some(f => f.channel === 'email')
  if (emailFailed) {
    // Email is down — the office finds out by text, not by mailbox.
    for (const phone of await officeSmsNumbers(admin, 'system')) {
      await sendSmsAfrosoft(phone,
        `ALERT: ${event} notification failed (${summary}). Email service unreachable — check Integrations/Settings.`)
        .then(d => logDelivery(admin, 'system', undefined, d))
    }
  }
  const smsFailed = failures.some(f => f.channel === 'sms')
  if (smsFailed) {
    // SMS is down — the office finds out by email, not by text.
    await sendEmailDirect(COMPANY_EMAIL,
      `[SMS FAILURE] ${event} notification could not be texted`,
      `One or more SMS deliveries failed after retry:\n\n${failures.filter(f => f.channel === 'sms').map(f => `  ${f.recipient} — ${f.detail ?? 'failed'}`).join('\n')}\n\nCheck the Afrosoft account balance and Integrations/Settings. Queued messages will retry from the app outbox where applicable.`)
      .then(d => logDelivery(admin, 'system', undefined, d))
  }
}

// ── The public shape ────────────────────────────────────────────────

export interface NotifyJob {
  /** Which lifecycle event this is — written to the log for filtering. */
  event: 'registration' | 'payment' | 'renewal' | 'claim' | 'ticket' | 'system' | 'recon'
  /** Policy/claim/ticket number for tracing. */
  ref?: string
  client?: { name?: string; phone?: string | null; email?: string | null } | null
  /** Extra staff recipients beyond the fixed company lines — e.g. the
   *  claims processor picking up a stage. */
  staffPhones?: string[]
  staffEmails?: string[]
  /** Bodies are built by the caller — they know the event's wording. */
  smsText: string
  emailSubject: string
  emailText: string
  whatsappText?: string
  /** Whole blocks to switch off for a given event (e.g. agriculture). */
  notifyClient?: boolean
  notifyOffice?: boolean
}

export async function dispatchNotification(admin: SupabaseClient | null, job: NotifyJob): Promise<Delivery[]> {
  const deliveries: Promise<Delivery>[] = []
  const clientPhone = job.notifyClient === false ? undefined : job.client?.phone
  const clientEmail = job.notifyClient === false ? undefined : job.client?.email
  const waText = job.whatsappText ?? job.smsText

  // Client — SMS + email + WhatsApp, all three at once.
  if (clientPhone) deliveries.push(sendSmsAfrosoft(clientPhone, job.smsText))
  if (clientEmail) deliveries.push(sendEmailDirect(clientEmail, job.emailSubject, job.emailText))
  if (clientPhone) deliveries.push(sendWhatsAppCloud(clientPhone, waText))

  // The office — whoever Settings assigned to this event, plus any
  // staff the event names. Brackets are two GSM units and were pushing
  // the prefix past a single Econet segment, so the label is plain text.
  if (job.notifyOffice !== false) {
    const officeSms = `${job.smsText}${job.ref ? ` Ref ${job.ref}` : ''}`
    const officeLines = await officeSmsNumbers(admin, job.event)
    for (const phone of officeLines) {
      deliveries.push(sendSmsAfrosoft(phone, `${job.event.toUpperCase()}: ${officeSms}`))
    }
    // WhatsApp follows the SAME assignment as SMS — the Settings → SMS
    // Recipients list governs every office channel, not just texts, so a
    // number removed there stops getting WhatsApp copies too.
    for (const phone of officeLines) {
      deliveries.push(sendWhatsAppCloud(phone, `${job.event.toUpperCase()}: ${waText}`))
    }
    const already = new Set(officeLines.map(p => normalizeZwMobile(p)))
    for (const phone of job.staffPhones ?? []) {
      const n = phone ? normalizeZwMobile(phone) : null
      if (!n || already.has(n)) continue
      already.add(n)
      deliveries.push(sendSmsAfrosoft(phone, `${job.event.toUpperCase()}: ${officeSms}`))
    }
    deliveries.push(sendEmailDirect(COMPANY_EMAIL, `[${job.event.toUpperCase()}] ${job.emailSubject}`, job.emailText))
    for (const email of job.staffEmails ?? []) {
      if (email) deliveries.push(sendEmailDirect(email, `[${job.event.toUpperCase()}] ${job.emailSubject}`, job.emailText))
    }
  }

  const results = await Promise.all(deliveries)
  await Promise.all(results.map(d => logDelivery(admin, job.event, job.ref, d)))
  await alertOfficeOfFailure(admin, job.event, results.filter(d => d.status === 'failed'))
  return results
}
