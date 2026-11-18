import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { serviceClient } from './_lib/sessionAuth.js'
import { dispatchMessage } from './_lib/bot/engine.js'
import { whatsappConfigured } from './_lib/bot/whatsapp.js'

/**
 * WhatsApp Cloud API webhook — replaces the Frappe
 * api/method/bot.bot.utils.webhook.webhook_handler endpoint.
 *
 *   GET  — Meta's verification handshake: hub.mode + hub.verify_token
 *          must match WHATSAPP_VERIFY_TOKEN, then echo hub.challenge.
 *   POST — inbound events. Each message normalises to one string:
 *            text        -> the body
 *            document    -> 'filename: X |||| id: Y' (claims upload)
 *            interactive -> the tapped button/list row's id
 *          then the bot engine dispatches it. Delivery receipts and
 *          every other event type are acknowledged and ignored.
 *
 * No session auth — Meta is the caller. Requests are authenticated by
 * the X-Hub-Signature-256 header when WHATSAPP_APP_SECRET is set (the
 * same model as api/paynow-webhook.ts: signatures, not sessions).
 */

export const config = { api: { bodyParser: false } }   // raw body needed for the signature

async function rawBody(req: VercelRequest): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  return Buffer.concat(chunks)
}

function signatureOk(body: Buffer, header: string | undefined): boolean {
  const secret = process.env.WHATSAPP_APP_SECRET
  if (!secret) return true                        // not configured — documented in docs/whatsapp-bot.md
  if (!header) return false
  const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
  try { return timingSafeEqual(Buffer.from(header), Buffer.from(expected)) } catch { return false }
}

/** Meta retries an event if delivery is slow. `wa_inbound_events` is the
 *  idempotency ledger: the first delivery inserts the message id; retries
 *  hit the primary key and are acknowledged without replaying the flow.
 *  If the migration has not been run yet the bot still works — dedupe is
 *  protection, not a hard dependency. */
async function firstDelivery(admin: NonNullable<ReturnType<typeof serviceClient>>, messageId: string, phone: string): Promise<boolean> {
  if (!messageId) return true
  const { error } = await admin.from('wa_inbound_events').insert({ message_id: messageId, phone_number: phone })
  if (!error) return true
  if (error.code === '23505') return false
  console.error('whatsapp-webhook: inbound dedupe unavailable', error.message)
  return true
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query
    if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN && challenge) {
      return res.status(200).send(String(challenge))
    }
    return res.status(403).send('Verification failed')
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const body = await rawBody(req)
  if (!signatureOk(body, req.headers['x-hub-signature-256'] as string | undefined)) {
    return res.status(401).json({ error: 'Bad signature' })
  }

  const admin = serviceClient()
  if (!admin || !whatsappConfigured()) {
    console.error('whatsapp-webhook: server not configured (Supabase service key or WHATSAPP_* env missing)')
    return res.status(200).json({ received: true })
  }

  try {
    const data = JSON.parse(body.toString('utf8'))
    if (data?.object !== 'whatsapp_business_account' || !Array.isArray(data.entry)) {
      return res.status(200).json({ received: true })
    }

    // Processed before the 200 is sent, not after — Vercel can freeze a
    // function once it responds, so answering first risks losing replies.
    // The work is a handful of outbound calls, well inside Meta's retry
    // window.
    for (const entry of data.entry) {
      for (const change of entry.changes ?? []) {
        const value = change?.value
        const messages = value?.messages
        if (!Array.isArray(messages)) continue                    // statuses etc — ignore
        const contacts = Array.isArray(value?.contacts) ? value.contacts : []
        for (const m of messages) {
          const phone = String(m.from ?? '').replace(/\D/g, '')
          const username = String(
            contacts.find((c: { wa_id?: string; profile?: { name?: string } }) => String(c.wa_id ?? '') === phone)?.profile?.name
            ?? contacts[0]?.profile?.name ?? '',
          )
          let input: string | null = null
          if (m.type === 'text' && m.text?.body != null) input = String(m.text.body)
          else if (m.type === 'document' && m.document?.id) input = `filename: ${m.document.filename ?? 'document'} |||| id: ${m.document.id}`
          else if (m.type === 'image' && m.image?.id) input = `filename: ${m.image.caption ? `${m.image.caption}.jpg` : 'claim-photo.jpg'} |||| id: ${m.image.id}`
          else if (m.type === 'interactive' && m.interactive?.button_reply) input = String(m.interactive.button_reply.id)
          else if (m.type === 'interactive' && m.interactive?.list_reply) input = String(m.interactive.list_reply.id)
          if (input === null || !/^\d{7,15}$/.test(phone)) continue
          if (!(await firstDelivery(admin, String(m.id ?? ''), phone))) continue
          await dispatchMessage(admin, { phone, input, username })
        }
      }
    }
  } catch (e) {
    console.error('whatsapp-webhook: processing error', e)
  }
  return res.status(200).json({ received: true })
}
