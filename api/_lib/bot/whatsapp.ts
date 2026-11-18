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

const TEXT_LIMIT = 4000

/** Cloud API text bodies cap around 4KB. Split long policy/client books at
 *  a line boundary so a large book cannot fail the whole reply. */
export function splitText(body: string, limit = TEXT_LIMIT): string[] {
  if (body.length <= limit) return [body]
  const parts: string[] = []
  let rest = body
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit)
    if (cut < limit * 0.5) cut = limit
    parts.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest) parts.push(rest)
  return parts
}

export async function sendText(phone: string, body: string): Promise<void> {
  for (const part of splitText(body)) await send(phone, { type: 'text', text: { body: part } })
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

const DOCUMENT_MIME_TYPES = new Set([
  'application/pdf', 'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/rtf', 'text/rtf',
  'image/jpeg', 'image/png', 'image/webp',
])
const MIME_EXTENSIONS: Record<string, string> = {
  'application/pdf': 'pdf', 'text/csv': 'csv',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/rtf': 'rtf', 'text/rtf': 'rtf',
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
}
const MAX_MEDIA_BYTES = 10 * 1024 * 1024

export interface WhatsappMedia {
  filename: string
  mimeType: string
  bytes: Buffer
}

/** Meta media is a two-step download: the id resolves to a temporary URL,
 *  then the URL returns the bytes (both requests need the bearer token). */
export async function downloadMedia(mediaId: string, fallbackFilename = 'whatsapp-file'): Promise<WhatsappMedia> {
  const cfg = config()
  if (!cfg) throw new Error('WhatsApp is not configured (WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID).')
  const metaRes = await fetch(`${GRAPH}/${cfg.version}/${encodeURIComponent(mediaId)}`, {
    headers: { Authorization: `Bearer ${cfg.token}` },
  })
  if (!metaRes.ok) throw new Error(`Could not resolve WhatsApp media ${mediaId} (HTTP ${metaRes.status}).`)
  const meta = await metaRes.json() as { url?: string; mime_type?: string; file_size?: number; filename?: string }
  const mimeType = String(meta.mime_type ?? 'application/octet-stream').toLowerCase()
  if (!meta.url) throw new Error('WhatsApp returned no media download URL.')
  if (!DOCUMENT_MIME_TYPES.has(mimeType)) throw new Error(`Unsupported claim attachment type ${mimeType}.`)
  if (Number(meta.file_size) > MAX_MEDIA_BYTES) throw new Error('The claim attachment is larger than 10MB.')

  const mediaRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${cfg.token}` } })
  if (!mediaRes.ok) throw new Error(`Could not download WhatsApp media (HTTP ${mediaRes.status}).`)
  const bytes = Buffer.from(await mediaRes.arrayBuffer())
  if (!bytes.length) throw new Error('WhatsApp returned an empty attachment.')
  if (bytes.length > MAX_MEDIA_BYTES) throw new Error('The claim attachment is larger than 10MB.')

  const ext = MIME_EXTENSIONS[mimeType] ?? 'bin'
  const base = (meta.filename || fallbackFilename || `whatsapp-file.${ext}`).replace(/\.[A-Za-z0-9]+$/, '')
  const filename = `${base.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80) || 'whatsapp-file'}.${ext}`
  return { filename, mimeType, bytes }
}
