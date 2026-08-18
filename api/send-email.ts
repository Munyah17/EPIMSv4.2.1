import type { VercelRequest, VercelResponse } from '@vercel/node'
import nodemailer from 'nodemailer'

/**
 * Sends outgoing mail via the company's own SMTP server (a cPanel host —
 * see database/../REBUILD_INSTRUCTIONS or ops notes for the mailbox list)
 * so credentials never reach the browser. Configure via Vercel env vars:
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
 * Without SMTP_HOST configured, returns { simulated: true } so the client
 * (src/lib/mailService.ts) can fall back gracefully — e.g. before the
 * mailboxes actually exist yet.
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

function getTransporter() {
  if (cachedTransporter) return cachedTransporter
  const host = process.env.SMTP_HOST
  const password = process.env.SMTP_PASSWORD
  if (!host || !password) return null
  cachedTransporter = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT ?? 465),
    secure: (process.env.SMTP_SECURE ?? 'true') === 'true',
    auth: { user: process.env.SMTP_DEFAULT_USER ?? undefined, pass: password },
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

  const host = process.env.SMTP_HOST
  const password = process.env.SMTP_PASSWORD
  if (!host || !password) {
    return res.status(200).json({ simulated: true, reason: 'SMTP_HOST/SMTP_PASSWORD not configured' })
  }

  // Microsoft 365 (and most hosted providers) refuse to send as any address
  // other than the mailbox that authenticated, so when a fixed account is
  // configured it always owns the From header. The role mailbox the app
  // asked for becomes Reply-To instead, which keeps replies routed sensibly
  // without forging the sender.
  const authenticatedFrom = process.env.SMTP_DEFAULT_USER
  const requestedFrom = body.from || process.env.SMTP_FALLBACK_FROM || `noreply@${host.replace(/^mail\./, '')}`
  const fromAddress = authenticatedFrom || requestedFrom
  const fromHeader = body.fromName ? `${body.fromName} <${fromAddress}>` : fromAddress
  const replyTo = body.replyTo
    || (authenticatedFrom && requestedFrom !== authenticatedFrom ? requestedFrom : undefined)

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
      ...(process.env.SMTP_DEFAULT_USER ? {} : { auth: { user: fromAddress, pass: password } }),
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
