import type { Handler } from '@netlify/functions'

/**
 * Proxies outgoing mail to Resend (https://resend.com) so the API key never
 * reaches the browser. Set RESEND_API_KEY (and optionally RESEND_FROM) as
 * Netlify environment variables. Without RESEND_API_KEY configured, this
 * returns { simulated: true } so the client can fall back gracefully.
 */

interface SendEmailBody {
  to: string
  cc?: string
  subject: string
  text: string
  from?: string
  fromName?: string
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) }
  }

  let body: SendEmailBody
  try {
    body = JSON.parse(event.body ?? '{}')
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) }
  }

  if (!body.to || !body.subject || !body.text) {
    return { statusCode: 400, body: JSON.stringify({ error: 'to, subject, and text are required' }) }
  }

  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    return { statusCode: 200, body: JSON.stringify({ simulated: true, reason: 'RESEND_API_KEY not configured' }) }
  }

  const fromAddress = process.env.RESEND_FROM || body.from || 'onboarding@resend.dev'
  const fromHeader = body.fromName ? `${body.fromName} <${fromAddress}>` : fromAddress

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromHeader,
        to: [body.to],
        cc: body.cc ? body.cc.split(',').map(s => s.trim()).filter(Boolean) : undefined,
        subject: body.subject,
        text: body.text,
      }),
    })

    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: data?.message ?? `Resend API error (${res.status})` }) }
    }
    return { statusCode: 200, body: JSON.stringify({ success: true, id: data?.id }) }
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: `Failed to reach Resend: ${e}` }) }
  }
}
