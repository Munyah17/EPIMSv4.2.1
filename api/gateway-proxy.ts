import type { VercelRequest, VercelResponse } from '@vercel/node'

/**
 * Generic server-side relay for the EcoCash, Paynow, and Afrosoft SMS APIs,
 * all of which reject direct browser calls via CORS. The client still holds
 * and sends merchant/API credentials (same trust model as today, just
 * routed through this same-origin function instead of a blocked
 * cross-origin request).
 *
 * Locked to an explicit host allowlist so this can't be abused as an open
 * proxy to arbitrary URLs (SSRF). The Afrosoft SMS domain is account-specific
 * (not published in Afrosoft's API docs) so it's allowlisted via an env var
 * once known, rather than hardcoded like the other two.
 */

const ALLOWED_HOSTS = new Set(
  ['api.ecocash.co.zw', 'www.paynow.co.zw', process.env.AFROSOFT_SMS_DOMAIN].filter((h): h is string => !!h),
)

interface ProxyRequestBody {
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const proxyReq: ProxyRequestBody = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {})

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
