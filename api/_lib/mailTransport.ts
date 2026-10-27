import nodemailer from 'nodemailer'
import { graphConfigured, sendViaGraph } from './graphMail.js'
import { stripEmailSubject, stripEmailBody } from './smsCanon.js'

/**
 * The actual mail transport, extracted from send-email.ts so non-HTTP
 * callers (the notification dispatcher, webhooks, cron) can send without
 * faking a request through their own endpoint.
 *
 * Route order is the same as send-email.ts:
 *   1. Microsoft 365 via Graph (MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET)
 *   2. SMTP (SMTP_HOST / SMTP_PASSWORD)
 *   3. Neither configured -> simulated:true. The caller must treat that as
 *      NOT sent — a confirmation that never left the building is worse than
 *      a loud failure.
 */

export interface MailPayload {
  to: string
  cc?: string
  subject: string
  text: string
  from?: string
  fromName?: string
  replyTo?: string
  attachmentBase64?: string
  attachmentFilename?: string
}

export type MailResult =
  | { ok: true; via: 'graph' | 'smtp' }
  | { ok: false; simulated: boolean; error: string }

let cachedTransporter: nodemailer.Transporter | null = null

/**
 * The SMTP login and the address mail is sent from are two different
 * things, and only sometimes the same string. See send-email.ts for the
 * full explanation.
 */
function authUser(): string | undefined {
  return process.env.SMTP_AUTH_USER || process.env.SMTP_DEFAULT_USER || undefined
}

function senderAddress(): string | undefined {
  return process.env.SMTP_FROM || process.env.SMTP_FALLBACK_FROM
    || (process.env.SMTP_DEFAULT_USER?.includes('@') ? process.env.SMTP_DEFAULT_USER : undefined)
}

function getTransporter() {
  if (cachedTransporter) return cachedTransporter
  const host = process.env.SMTP_HOST
  const password = process.env.SMTP_PASSWORD
  if (!host || !password) return null
  cachedTransporter = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT ?? 465),
    secure: (process.env.SMTP_SECURE ?? 'true') === 'true',
    auth: { user: authUser(), pass: password },
  })
  return cachedTransporter
}

export async function sendMailDirect(mail: MailPayload): Promise<MailResult> {
  // Same wording border as SMS: a stale bundle or a caller that still
  // writes "REGISTRATION:" / "[REG]" envelopes must not resurrect the
  // banned label on email — subjects take the full strip, bodies only
  // lose envelope lines and bracket tags so prose is never mangled.
  mail = { ...mail, subject: stripEmailSubject(mail.subject), text: stripEmailBody(mail.text) }
  if (graphConfigured()) {
    const sender = mail.from || process.env.MS_SEND_AS || senderAddress()
    if (!sender) {
      return { ok: false, simulated: false, error: 'No sender mailbox: set MS_SEND_AS, or supply a from address.' }
    }
    const sent = await sendViaGraph({
      from: sender,
      fromName: mail.fromName,
      to: mail.to,
      cc: mail.cc,
      replyTo: mail.replyTo,
      subject: mail.subject,
      text: mail.text,
      attachmentBase64: mail.attachmentBase64,
      attachmentFilename: mail.attachmentFilename,
    })
    if (sent.ok) return { ok: true, via: 'graph' }
    // Reported rather than silently retried over SMTP: a Graph failure is
    // almost always a configuration fault, and quietly falling back would
    // hide the thing that needs fixing.
    return { ok: false, simulated: false, error: sent.error }
  }

  const host = process.env.SMTP_HOST
  const password = process.env.SMTP_PASSWORD
  if (!host || !password) {
    return { ok: false, simulated: true, error: 'Neither Microsoft 365 (MS_TENANT_ID/MS_CLIENT_ID/MS_CLIENT_SECRET) nor SMTP (SMTP_HOST/SMTP_PASSWORD) is configured.' }
  }

  const verifiedSender = senderAddress()
  const requestedFrom = mail.from || `noreply@${host.replace(/^(mail|smtp)\./, '')}`
  const fromAddress = verifiedSender || requestedFrom
  const fromHeader = mail.fromName ? `${mail.fromName} <${fromAddress}>` : fromAddress
  // Every mailbox answer lands in one place: replies on mail sent "from"
  // any address must go to the monitored inbox, not the role alias the
  // template happened to name — SMTP_REPLY_TO forces that when the caller
  // didn't set one itself.
  const replyTo = mail.replyTo
    || process.env.SMTP_REPLY_TO
    || (verifiedSender && requestedFrom !== verifiedSender ? requestedFrom : undefined)

  try {
    const transporter = getTransporter()
    if (!transporter) return { ok: false, simulated: true, error: 'SMTP not configured' }
    await transporter.sendMail({
      from: fromHeader,
      ...(authUser() ? {} : { auth: { user: fromAddress, pass: password } }),
      to: mail.to,
      cc: mail.cc,
      replyTo,
      subject: mail.subject,
      text: mail.text,
      attachments: mail.attachmentBase64 && mail.attachmentFilename ? [{
        filename: mail.attachmentFilename,
        content: Buffer.from(mail.attachmentBase64, 'base64'),
      }] : undefined,
    } as nodemailer.SendMailOptions)
    return { ok: true, via: 'smtp' }
  } catch (e) {
    return { ok: false, simulated: false, error: `Failed to send via SMTP: ${e}` }
  }
}
