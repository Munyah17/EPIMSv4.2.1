import type { Handler } from '@netlify/functions'

/**
 * Real AI fraud scoring via Groq (llama-3.3-70b-versatile). Replaces the
 * hardcoded `Math.floor(Math.random() * 30)` that used to ship with every
 * submitted claim regardless of its actual content.
 */

interface ScoreClaimBody {
  claimType: string
  amount: number
  coverAmount: number
  dateOfEvent: string
  policyStartDate: string
  dateSubmitted: string
  description: string
  priorClaimsOnPolicy: number
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) }
  }

  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) {
    return { statusCode: 200, body: JSON.stringify({ score: 20, signals: [] as string[], reasoning: 'AI fraud scoring not configured (GROQ_API_KEY missing) — default low score.' }) }
  }

  let body: ScoreClaimBody
  try {
    body = JSON.parse(event.body ?? '{}')
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) }
  }
  if (!body.claimType || body.amount == null || !body.dateOfEvent || !body.description) {
    return { statusCode: 400, body: JSON.stringify({ error: 'claimType, amount, dateOfEvent, and description are required.' }) }
  }

  const daysPolicyToEvent = Math.round(
    (new Date(body.dateOfEvent).getTime() - new Date(body.policyStartDate).getTime()) / 86400000
  )
  const daysEventToSubmit = Math.round(
    (new Date(body.dateSubmitted).getTime() - new Date(body.dateOfEvent).getTime()) / 86400000
  )
  const pctOfCover = body.coverAmount > 0 ? Math.round((body.amount / body.coverAmount) * 100) : 0

  const prompt = `You are a fraud-detection assistant for a Zimbabwean micro-insurance agency reviewing a newly submitted claim. Score fraud risk from 0-100 (higher = more suspicious) based on known red flags: claims filed very soon after policy inception, amounts at or near the full cover limit, long delays between event and submission (or suspiciously immediate submission), vague or inconsistent descriptions, and repeat claims on the same policy.

Claim type: ${body.claimType}
Claim amount: $${body.amount} (${pctOfCover}% of the policy's $${body.coverAmount} cover limit)
Days between policy start and date of event: ${daysPolicyToEvent}
Days between event and submission: ${daysEventToSubmit}
Prior claims already filed on this policy: ${body.priorClaimsOnPolicy}
Description provided by claimant: "${body.description}"

Respond with ONLY a JSON object, no markdown, no explanation outside the JSON: {"score": <integer 0-100>, "signals": [<0-4 short strings naming specific red flags actually present, empty array if none>], "reasoning": "<one sentence, under 25 words>"}`

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 300,
        response_format: { type: 'json_object' },
      }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { statusCode: 502, body: JSON.stringify({ error: `Groq API error (${res.status}): ${text}` }) }
    }
    const data = await res.json()
    const content = data?.choices?.[0]?.message?.content
    if (!content) return { statusCode: 502, body: JSON.stringify({ error: 'Groq returned no content.' }) }

    const parsed = JSON.parse(content)
    const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 0)))
    const signals = Array.isArray(parsed.signals) ? parsed.signals.map(String).slice(0, 4) : []
    return { statusCode: 200, body: JSON.stringify({ score, signals, reasoning: String(parsed.reasoning || '').slice(0, 200) }) }
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: `Failed to score claim: ${e}` }) }
  }
}
