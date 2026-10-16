import type { VercelRequest, VercelResponse } from '@vercel/node'
import { serviceClient, requireSession } from './_lib/sessionAuth.js'

/**
 * Generic server-side relay for the EcoCash, Paynow, and Afrosoft SMS APIs,
 * all of which reject direct browser calls via CORS. The client still holds
 * and sends merchant/API credentials (same trust model as today, just
 * routed through this same-origin function instead of a blocked
 * cross-origin request).
 *
 * Locked to an explicit host allowlist so this can't be abused as an open
 * proxy to arbitrary URLs (SSRF). AFROSOFT_SMS_DOMAIN stays overridable by
 * env var in case Afrosoft moves us to a different host, but defaults to
 * the one they assigned us so live SMS works without extra config.
 */

const ALLOWED_HOSTS = new Set(
  ['api.ecocash.co.zw', 'www.paynow.co.zw', process.env.AFROSOFT_SMS_DOMAIN || 'sms.vas.co.zw']
    .filter((h): h is string => !!h),
)

interface ProxyRequestBody {
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  /** 'sms' sends a real text on our key; 'ping' is the no-spend liveness
   *  check the gateway watch and System Health use. */
  action?: 'sms' | 'ping'
  mobiles?: string
  message?: string
}

/**
 * Sends through Afrosoft using credentials held on the server.
 *
 * SMS used to be assembled in the browser from settings in localStorage,
 * which meant every device needed configuring and one blank save silently
 * dropped the whole system into simulation mode -- messages "sent" that
 * never existed. The key belongs on the server, where it is set once and
 * cannot be cleared by a stray click in a settings form.
 */
/**
 * Liveness check against Afrosoft that does not spend an SMS: a balance
 * lookup through the same credentials. The response itself doesn't matter
 * — ANY HTTP answer (even an auth rejection) proves the host is up; only
 * a connection failure, timeout, or 5xx counts as "Afrosoft is down".
 *
 * `source` names whose problem it is:
 *  - 'afrosoft' — the gateway host could not be reached or errored out
 *  - 'config'   — our side: the API key isn't set on the server
 */
async function pingAfrosoft(): Promise<{ up: boolean; source: 'afrosoft' | 'config'; detail: string }> {
  const apiKey = process.env.AFROSOFT_SMS_API_KEY
  const domain = process.env.AFROSOFT_SMS_DOMAIN || 'sms.vas.co.zw'
  if (!apiKey) {
    return { up: false, source: 'config', detail: 'AFROSOFT_SMS_API_KEY is not configured on the server — that is our setup, not Afrosoft.' }
  }
  const url = `https://${domain}/client/api/getbalance?${new URLSearchParams({ apikey: apiKey })}`
  try {
    const upstream = await fetch(url, { signal: AbortSignal.timeout(10000) })
    if (upstream.status >= 500) {
      await upstream.arrayBuffer().catch(() => { /**/ })
      return { up: false, source: 'afrosoft', detail: `Afrosoft returned HTTP ${upstream.status} — their server is erroring.` }
    }
    // Any 2xx/4xx answer means the host is alive and answering us.
    const body = await upstream.text()
    return { up: true, source: 'afrosoft', detail: `Afrosoft answered (HTTP ${upstream.status})${body ? `: ${body.slice(0, 120)}` : ''}` }
  } catch (e) {
    return { up: false, source: 'afrosoft', detail: `Afrosoft host unreachable (connection/timeout): ${e}` }
  }
}

async function sendViaAfrosoft(mobiles: string, message: string) {
  const apiKey = process.env.AFROSOFT_SMS_API_KEY
  const domain = process.env.AFROSOFT_SMS_DOMAIN || 'sms.vas.co.zw'
  if (!apiKey) {
    return { ok: false as const, status: 503, body: JSON.stringify({ error: 'AFROSOFT_SMS_API_KEY is not configured on the server.' }) }
  }

  const params = new URLSearchParams({ apikey: apiKey, mobiles, sms: message })
  const senderId = process.env.AFROSOFT_SMS_SENDER_ID
  if (senderId) params.set('senderid', senderId)
  // Non-ASCII has to be declared or Afrosoft mangles it.
  if (/[^\x00-\x7F]/.test(message)) params.set('unicode', 'yes')

  const url = `https://${domain}/client/api/sendmessage?${params.toString()}`
  // One automatic retry on transport failure — an SMS is important enough
  // that a single dropped TCP connection must not be the difference
  // between "client got the text" and "nobody knows it never sent".
  try {
    const upstream = await fetch(url)
    if (upstream.ok) return { ok: true, status: upstream.status, body: await upstream.text() }
    if (upstream.status < 500) return { ok: false, status: upstream.status, body: await upstream.text() }
    // 5xx: fall through to the retry.
    await upstream.arrayBuffer().catch(() => { /**/ })
  } catch {
    // Unreachable: fall through to the retry.
  }
  await new Promise(r => setTimeout(r, 1500))
  const retry = await fetch(url)
  return { ok: retry.ok, status: retry.status, body: await retry.text() }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // The 'sms' action sends on OUR Afrosoft key and the plain relay still
  // originates traffic from our function — neither can be anonymous. The
  // Afrosoft balance and our sender ID are both spent by a stranger's text.
  // Our own serverless callers (the public website's provisioning pipeline)
  // authenticate with the shared machine secret instead of a user session.
  const admin = serviceClient()
  if (!admin) return res.status(500).json({ error: 'Server is not configured: SUPABASE_SERVICE_ROLE_KEY environment variable is missing on Vercel. This is a one-time setup issue, not related to user sessions.' })
  const machineSecret = process.env.NOTIFY_SECRET || process.env.CRON_SECRET
  const isMachine = !!machineSecret && req.headers.authorization === `Bearer ${machineSecret}`
  if (!isMachine && !(await requireSession(req, admin))) {
    return res.status(401).json({ error: 'Sign-in required.' })
  }

  const proxyReq: ProxyRequestBody = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {})

  if (proxyReq.action === 'ping') {
    // Health probe — no message is sent, nothing is spent.
    const result = await pingAfrosoft()
    return res.status(200).json(result)
  }

  if (proxyReq.action === 'sms') {
    if (!proxyReq.mobiles || !proxyReq.message) {
      return res.status(400).json({ error: 'mobiles and message are required.' })
    }
    try {
      const result = await sendViaAfrosoft(proxyReq.mobiles, proxyReq.message)
      return res.status(200).json({ status: result.status, ok: result.ok, body: result.body })
    } catch (e) {
      return res.status(502).json({ error: `SMS gateway unreachable: ${e}` })
    }
  }

  let target: URL
  try {
    target = new URL(proxyReq.url)
  } catch {
    return res.status(400).json({ error: 'Invalid target url' })
  }

  if (target.protocol !== 'https:' || !ALLOWED_HOSTS.has(target.hostname)) {
    return res.status(403).json({ error: `Target host not allowed: ${target.hostname}` })
  }

  try {
    const upstream = await fetch(target.toString(), {
      method: proxyReq.method ?? 'POST',
      headers: proxyReq.headers,
      body: proxyReq.method === 'GET' ? undefined : proxyReq.body,
    })
    const text = await upstream.text()
    return res.status(200).json({ status: upstream.status, ok: upstream.ok, body: text })
  } catch (e) {
    return res.status(502).json({ error: `Upstream request failed: ${e}` })
  }
}
