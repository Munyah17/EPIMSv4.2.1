import type { VercelRequest, VercelResponse } from '@vercel/node'

/**
 * Real AI fraud scoring via Claude (claude-sonnet-5) — replaces the
 * hardcoded `Math.floor(Math.random() * 30)` that used to ship with every
 * submitted claim regardless of its actual content. Was previously on Groq;
 * moved to Anthropic per the 2026-08 access review so claim fraud scoring
 * and assessment photo analysis (analyze-assessment-photo.ts) share one
 * provider and key.
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return res.status(200).json({ score: 20, signals: [] as string[], reasoning: 'AI fraud scoring not configured (ANTHROPIC_API_KEY missing) — default low score.' })
  }

  const body: ScoreClaimBody = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {})
  if (!body.claimType || body.amount == null || !body.dateOfEvent || !body.description) {
    return res.status(400).json({ error: 'claimType, amount, dateOfEvent, and description are required.' })
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

Respond with ONLY a JSON object, no markdown fences, no explanation outside the JSON: {"score": <integer 0-100>, "signals": [<0-4 short strings naming specific red flags actually present, empty array if none>], "reasoning": "<one sentence, under 25 words>"}`

  try {
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    if (!apiRes.ok) {
      const text = await apiRes.text().catch(() => '')
      return res.status(502).json({ error: `AI service error (${apiRes.status}): ${text}` })
    }
    const data = await apiRes.json()
    const content = data?.content?.[0]?.text
    if (!content) return res.status(502).json({ error: 'AI service returned no content.' })

    const parsed = JSON.parse(content)
    const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 0)))
    const signals = Array.isArray(parsed.signals) ? parsed.signals.map(String).slice(0, 4) : []
    return res.status(200).json({ score, signals, reasoning: String(parsed.reasoning || '').slice(0, 200) })
  } catch (e) {
    return res.status(502).json({ error: `Failed to score claim: ${e}` })
  }
}
