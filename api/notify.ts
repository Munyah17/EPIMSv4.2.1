import type { VercelRequest, VercelResponse } from '@vercel/node'
import { serviceClient, requireSession } from './_lib/sessionAuth.js'
import { dispatchNotification, sendSmsAfrosoft, sendEmailDirect, sendWhatsAppCloud, logDelivery, type NotifyJob, type Delivery } from './_lib/notify.js'

/**
 * The notification bus.
 *
 * Every lifecycle event the app needs to announce — registration, payment,
 * renewal stage, claim stage, ticket stage — is POSTed here, and the
 * server fans it out to the client AND the office over SMS + email +
 * WhatsApp, logging each attempt to notification_log.
 *
 * Callers:
 *   - signed-in app users (client portal + staff console), by session
 *   - our own serverless functions / the public website's provisioning
 *     pipeline, by CRON_SECRET or NOTIFY_SECRET bearer — a machine telling
 *     the bus "payment confirmed" is not a person signing in.
 *
 * Body:
 *   { event, ref?, client: {name, phone, email}, staffPhones?[],
 *     staffEmails?[], smsText, emailSubject, emailText, whatsappText?,
 *     notifyClient?, notifyOffice? }
 *
 * It always reports the per-channel results — a caller that ignores them
 * is the one making things silent again.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const admin = serviceClient()
  if (!admin) return res.status(500).json({ error: 'Server is not configured.' })

  const bearer = req.headers.authorization ?? ''
  const machineSecret = process.env.NOTIFY_SECRET || process.env.CRON_SECRET
  const isMachine = !!machineSecret && bearer === `Bearer ${machineSecret}`
  if (!isMachine && !(await requireSession(req, admin))) {
    return res.status(401).json({ error: 'Sign-in required.' })
  }

  const body = (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {})) as
    NotifyJob & { channel?: 'sms' | 'email' | 'whatsapp'; recipient?: string; text?: string; subject?: string; logOnly?: boolean; status?: string; detail?: string }

  // Audit-only write: client code that sent through its own channel (the
  // SMS proxy, send-email) reports the outcome here so notification_log
  // holds every attempt — the quiet part that used to be missing.
  if (body.logOnly) {
    if (!body.channel || !body.recipient || !body.event || !body.status) {
      return res.status(400).json({ error: 'logOnly needs channel, recipient, event and status.' })
    }
    await logDelivery(admin, String(body.event), body.ref, {
      channel: body.channel, recipient: String(body.recipient),
      status: body.status as Delivery['status'], detail: body.detail,
    })
    return res.status(200).json({ ok: true })
  }

  // Single-channel send (e.g. "WhatsApp this client") rather than the
  // full three-channel fanout.
  if (body.channel && body.recipient && body.text) {
    const d = body.channel === 'sms' ? await sendSmsAfrosoft(body.recipient, body.text)
      : body.channel === 'whatsapp' ? await sendWhatsAppCloud(body.recipient, body.text)
      : await sendEmailDirect(body.recipient, body.subject ?? String(body.event), body.text)
    await logDelivery(admin, String(body.event ?? 'system'), body.ref, d)
    return res.status(d.status === 'failed' ? 502 : 200).json({ ok: d.status !== 'failed', delivery: d })
  }

  if (!body.event || !body.smsText || !body.emailText || !body.emailSubject) {
    return res.status(400).json({ error: 'event, smsText, emailSubject and emailText are required.' })
  }
  if (!body.client?.phone && !body.client?.email && body.notifyOffice === false) {
    return res.status(400).json({ error: 'No recipients: give a client contact, or leave notifyOffice on.' })
  }

  try {
    const deliveries: Delivery[] = await dispatchNotification(admin, body)
    const failed = deliveries.filter(d => d.status === 'failed')
    return res.status(200).json({
      ok: failed.length === 0,
      deliveries,
      failed: failed.length,
      queued: deliveries.filter(d => d.status === 'queued').length,
    })
  } catch (e) {
    return res.status(500).json({ error: `Notification dispatch failed: ${e}` })
  }
}
