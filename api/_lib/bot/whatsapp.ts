/**
 * WhatsApp Cloud API senders — the port of messaging_client.py.
 *
 * Environment:
 *   WHATSAPP_ACCESS_TOKEN     permanent token from the Meta app
 *   WHATSAPP_PHONE_NUMBER_ID  the number people message you on
 *   WHATSAPP_GRAPH_VERSION    optional, defaults v21.0
 *
 * A send that fails throws — the engine catches, logs and tells the
 * caller something went wrong rather than leaving them mid-flow.
 */

const GRAPH = 'https://graph.facebook.com'

function config(): { token: string; phoneId: string; version: string } | null {
  const token = process.env.WHATSAPP_ACCESS_TOKEN
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID
  if (!token || !phoneId) return null
  return { token, phoneId, version: process.env.WHATSAPP_GRAPH_VERSION || 'v21.0' }
}

export function whatsappConfigured(): boolean {
  return config() !== null
}

async function send(phone: string, payload: Record<string, unknown>): Promise<void> {
  const cfg = config()
  if (!cfg) throw new Error('WhatsApp is not configured (WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID).')
  const res = await fetch(`${GRAPH}/${cfg.version}/${cfg.phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: phone, ...payload }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`WhatsApp send failed (HTTP ${res.status}): ${detail.slice(0, 300)}`)
  }
}

export function sendText(phone: string, body: string): Promise<void> {
  return send(phone, { type: 'text', text: { body } })
}

export function sendDocument(phone: string, caption: string, filename: string, link: string): Promise<void> {
  return send(phone, { type: 'document', document: { link, filename, caption } })
}

export interface ReplyButton { id: string; title: string }

/** Up to 3 reply buttons. */
export function sendButtons(phone: string, body: string, buttons: ReplyButton[], header?: string, footer?: string): Promise<void> {
  const interactive: Record<string, unknown> = {
    type: 'button',
    body: { text: body },
    action: { buttons: buttons.slice(0, 3).map(b => ({ type: 'reply', reply: { id: b.id, title: b.title } })) },
  }
  if (header) interactive.header = { type: 'text', text: header }
  if (footer) interactive.footer = { text: footer }
  return send(phone, { type: 'interactive', interactive })
}

export interface ListRow { id: string; title: string; description?: string }

/** Interactive list, one section, up to 10 rows. Row titles cap at 24 chars. */
export function sendList(phone: string, buttonText: string, body: string, rows: ListRow[], header?: string, footer?: string): Promise<void> {
  const interactive: Record<string, unknown> = {
    type: 'list',
    body: { text: body },
    action: {
      button: buttonText.slice(0, 20),
      sections: [{
        title: buttonText.slice(0, 20),
        rows: rows.slice(0, 10).map(r => ({
          id: r.id, title: r.title.slice(0, 24),
          ...(r.description ? { description: r.description.slice(0, 72) } : {}),
        })),
      }],
    },
  }
  if (header) interactive.header = { type: 'text', text: header }
  if (footer) interactive.footer = { text: footer }
  return send(phone, { type: 'interactive', interactive })
}
