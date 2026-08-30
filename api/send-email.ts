import type { VercelRequest, VercelResponse } from '@vercel/node'
import nodemailer from 'nodemailer'
import { graphConfigured, sendViaGraph } from './_lib/graphMail.js'

/**
 * Outgoing mail. Two routes, tried in this order:
 *
 *  1. Microsoft 365 via Graph — the live path. See _lib/graphMail.ts.
 *     Set MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET and MS_SEND_AS.
 *     No mailbox password is involved, so it is unaffected by Microsoft
 *     retiring Basic Auth for SMTP submission, and each role mailbox
 *     sends as itself.
 *
 *  2. SMTP — kept as a fallback for a non-Microsoft relay, and so mail
 *     keeps working while a tenant is being set up.
 *
 * Either way credentials stay on the server and never reach the browser.
 * With neither configured this returns { simulated: true } and the caller
 * says so plainly; it never reports a message as sent when none was.
 *
 * SMTP env vars:
 *
 *   SMTP_HOST     — e.g. c3.my-control-panel.com
 *   SMTP_PORT     — defaults to 465
 *   SMTP_SECURE   — "true" for port 465 (implicit TLS), "false" for 587 (STARTTLS). Defaults to true.
 *   SMTP_PASSWORD — shared across the role mailboxes (see src/lib/mailboxes.ts);
 *                   update this — and split into per-mailbox vars if any
 *                   mailbox's password ever diverges — once real passwords are set.
 *
 * The SMTP *username* is always the `from` address itself (cPanel mail
 * authenticates as the full mailbox address), so no separate username var
 * is needed as long as every mailbox shares one password.
 *
 */

interface SendEmailBody {
  to: string
  cc?: string
  subject: string
  text: string
  from?: string
  fromName?: string
  replyTo?: string
  /** Base64 payload (no data: URI prefix) — e.g. a generated policy report PDF. */
  attachmentBase64?: string
  attachmentFilename?: string
}

let cachedTransporter: nodemailer.Transporter | null = null

/**
 * The SMTP login and the address mail is sent from are two different things,
 * and only sometimes the same string. A cPanel mailbox logs in as its own
 * address; a relay such as Resend logs in as a service username ("resend")
 * with the API key as the password, and the from-address is a verified
 * domain instead. Conflating the two breaks every provider of the second
 * kind, so they are configured separately:
 *
 *   SMTP_AUTH_USER  who we log in as        (falls back to SMTP_DEFAULT_USER)
 *   SMTP_FROM       the address we send as  (falls back to SMTP_DEFAULT_USER)
 */
function authUser(): string | undefined {
  return process.env.SMTP_AUTH_USER || process.env.SMTP_DEFAULT_USER || undefined
}

function senderAddress(): string | undefined {
  return process.env.SMTP_FROM || process.env.SMTP_FALLBACK_FROM
    // Only usable as a sender if it actually looks like an address.
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const body: SendEmailBody = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {})

  if (!body.to || !body.subject || !body.text) {
    return res.status(400).json({ error: 'to, subject, and text are required' })
  }

  // Microsoft 365 first, when it is configured. Graph is the path
  // Microsoft actually supports: no mailbox password, unaffected by the
  // retirement of Basic Auth for SMTP, and each role mailbox genuinely
  // sends as itself instead of everything going out from one account.
  // SMTP stays behind it so nothing breaks while the tenant is being set
  // up, and so a non-Microsoft relay is still an option.
  if (graphConfigured()) {
    const sender = body.from || process.env.MS_SEND_AS || senderAddress()
    if (!sender) {
      return res.status(500).json({ error: 'No sender mailbox: set MS_SEND_AS, or supply a from address with the request.' })
    }
    const sent = await sendViaGraph({
      from: sender,
      fromName: body.fromName,
      to: body.to,
      cc: body.cc,
      replyTo: body.replyTo,
      subject: body.subject,
      text: body.text,
      attachmentBase64: body.attachmentBase64,
      attachmentFilename: body.attachmentFilename,
    })
    if (sent.ok) return res.status(200).json({ success: true, via: 'graph' })
    // Reported rather than silently retried over SMTP: a Graph failure is
    // almost always a configuration fault (expired secret, missing admin
    // consent, mailbox outside the access policy), and quietly falling
    // back would hide the thing that needs fixing.
    return res.status(502).json({ error: sent.error })
  }

  const host = process.env.SMTP_HOST
  const password = process.env.SMTP_PASSWORD
  if (!host || !password) {
    return res.status(200).json({ simulated: true, reason: 'Neither Microsoft 365 (MS_TENANT_ID/MS_CLIENT_ID/MS_CLIENT_SECRET) nor SMTP (SMTP_HOST/SMTP_PASSWORD) is configured' })
  }

  // Providers only let you send from a domain you have verified, so when a
  // sender address is configured it always owns the From header. The role
  // mailbox the app asked for becomes Reply-To instead, which keeps replies
  // routed to the right desk without forging a sender we cannot prove.
  const verifiedSender = senderAddress()
  const requestedFrom = body.from || `noreply@${host.replace(/^(mail|smtp)\./, '')}`
  const fromAddress = verifiedSender || requestedFrom
  const fromHeader = body.fromName ? `${body.fromName} <${fromAddress}>` : fromAddress
  const replyTo = body.replyTo
    || (verifiedSender && requestedFrom !== verifiedSender ? requestedFrom : undefined)

  try {
    const transporter = getTransporter()
    if (!transporter) {
      return res.status(200).json({ simulated: true, reason: 'SMTP not configured' })
    }
    const info = await transporter.sendMail({
      from: fromHeader,
      // cPanel mailboxes typically must send AS themselves — authenticate
      // per-send as the actual from address rather than one fixed account,
      // so "from" genuinely matches who the SMTP session logged in as.
      // With no fixed login configured, fall back to the cPanel pattern of
      // authenticating per-send as the mailbox being sent from.
      ...(authUser() ? {} : { auth: { user: fromAddress, pass: password } }),
      to: body.to,
      cc: body.cc,
      replyTo,
      subject: body.subject,
      text: body.text,
      attachments: body.attachmentBase64 && body.attachmentFilename ? [{
        filename: body.attachmentFilename,
        content: Buffer.from(body.attachmentBase64, 'base64'),
      }] : undefined,
    } as nodemailer.SendMailOptions)
    return res.status(200).json({ success: true, id: info.messageId })
  } catch (e) {
    return res.status(502).json({ error: `Failed to send via SMTP: ${e}` })
  }
}
