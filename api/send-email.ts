import type { VercelRequest, VercelResponse } from '@vercel/node'
import { sendMailDirect } from './_lib/mailTransport.js'
import { serviceClient, requireSession } from './_lib/sessionAuth.js'

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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // This sends real mail through our own Microsoft 365 / SMTP account, so
  // it can never be anonymous — an open relay on a verified sender domain
  // is a spam cannon pointed back at us. Two callers are legitimate: a
  // signed-in user (any role — a policyholder's own actions can fire
  // notifications too), and cron-reminders carrying the cron secret.
  const cronSecret = process.env.CRON_SECRET
  const isCron = !!cronSecret && req.headers.authorization === `Bearer ${cronSecret}`
  if (!isCron) {
    const admin = serviceClient()
    if (!admin) return res.status(500).json({ error: 'Server is not configured.' })
    if (!(await requireSession(req, admin))) {
      return res.status(401).json({ error: 'Sign-in required.' })
    }
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
  const sent = await sendMailDirect({
    to: body.to,
    cc: body.cc,
    subject: body.subject,
    text: body.text,
    from: body.from,
    fromName: body.fromName,
    replyTo: body.replyTo,
    attachmentBase64: body.attachmentBase64,
    attachmentFilename: body.attachmentFilename,
  })
  if (sent.ok) return res.status(200).json({ success: true, via: sent.via })
  if (sent.simulated) {
    return res.status(200).json({ simulated: true, reason: sent.error })
  }
  return res.status(502).json({ error: sent.error })
}
