import type { SupabaseClient } from '@supabase/supabase-js'
import { sendMailDirect } from './mailTransport.js'

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

/** Office lines + mailbox copied on every lifecycle event. */
export const COMPANY_PHONES = ['+263780086175', '+263780086176', '+263780086177', '+263780086178']
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
  let digits = raw.replace(/\D/g, '')
  if (digits.startsWith('0')) digits = `263${digits.slice(1)}`
  else if (!digits.startsWith('263')) digits = `263${digits}`
  return digits
}
function isValidMsisdn(raw: string): boolean {
  return /^263[17]\d{8}$/.test(normalizeMsisdn(raw))
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

export async function sendSmsAfrosoft(to: string, message: string): Promise<Delivery> {
  const msisdn = normalizeMsisdn(to)
  if (!isValidMsisdn(to)) {
    return { channel: 'sms', recipient: to, status: 'failed', detail: `Not a valid ZW mobile: ${to}` }
  }
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
  const token = process.env.WHATSAPP_TOKEN
  const phoneId = process.env.WHATSAPP_PHONE_ID
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
    const res = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
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
 *  surfaced on the admin dashboard via notification_log, and here as an
 *  SMS to the office lines ONLY when the failure wasn't SMS itself (a
 *  dead SMS gateway can't report itself). */
async function alertOfficeOfFailure(admin: SupabaseClient | null, event: string, failures: Delivery[]) {
  if (failures.length === 0) return
  const emailFailed = failures.some(f => f.channel === 'email')
  if (emailFailed) {
    // Email is down — the office finds out by text, not by mailbox.
    for (const phone of COMPANY_PHONES) {
      await sendSmsAfrosoft(phone,
        `Motions ALERT: ${event} notification failed (${failures.map(f => `${f.channel}→${f.recipient}`).slice(0, 3).join('; ')}). Email service unreachable — check Integrations/Settings.`)
        .then(d => logDelivery(admin, 'system', undefined, d))
    }
  }
}

// ── The public shape ────────────────────────────────────────────────

export interface NotifyJob {
  /** Which lifecycle event this is — written to the log for filtering. */
  event: 'registration' | 'payment' | 'renewal' | 'claim' | 'ticket' | 'system'
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

  // The office — the four fixed lines plus any staff the event names.
  if (job.notifyOffice !== false) {
    const officeSms = `${job.smsText.length > 140 ? job.smsText.slice(0, 140) : job.smsText}${job.ref ? ` [${job.ref}]` : ''}`
    for (const phone of COMPANY_PHONES) {
      deliveries.push(sendSmsAfrosoft(phone, `[${job.event.toUpperCase()}] ${officeSms}`))
      deliveries.push(sendWhatsAppCloud(phone, `[${job.event.toUpperCase()}] ${waText}`))
    }
    for (const phone of job.staffPhones ?? []) {
      if (phone) deliveries.push(sendSmsAfrosoft(phone, `[${job.event.toUpperCase()}] ${officeSms}`))
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
