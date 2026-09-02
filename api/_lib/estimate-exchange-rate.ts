import type { VercelRequest, VercelResponse } from '@vercel/node'
import { callGroq, extractJson } from './groq.js'

/**
 * A suggested USD/ZiG rate, for a super admin to consider before typing one.
 *
 * IMPORTANT: this is not a rate feed. The model has no network access and no
 * live market data -- it can only recall what it saw during training, which
 * on a currency that moves weekly will be out of date and may be wrong by a
 * wide margin. So this returns a suggestion plus the model's own confidence
 * and its stated basis, and the caller is expected to present it as
 * something to check, never to apply on its own. Anything saved from it is
 * recorded with source='estimate' so it is distinguishable from a rate
 * someone actually verified.
 *
 * The response deliberately carries `asOf` -- the model's own claim about
 * when its figure was current -- because a confident number with no date is
 * the most misleading thing it could return.
 */

interface Body {
  /** The rate currently on record, if any, for context in the reply. */
  currentRate?: number
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) {
    return res.status(200).json({
      available: false,
      note: 'Rate suggestions are not configured on this server.',
    })
  }

  const body: Body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {})
  const today = new Date().toISOString().split('T')[0]

  const prompt = `Today is ${today}. You are helping a Zimbabwean insurer sanity-check the USD to ZiG (Zimbabwe Gold, ZWG) exchange rate before entering it by hand.

You have NO access to live data. Do not pretend otherwise. Report only what you actually recall, and say plainly how out of date it is likely to be.

${body.currentRate ? `The rate currently on record is ${body.currentRate} ZiG per 1 USD.` : 'No rate is currently on record.'}

Respond with ONLY a JSON object, no markdown and no text outside it:
{"officialRate": <number or null: ZiG per 1 USD, the official/RBZ rate as best you recall>,
 "parallelRate": <number or null: the parallel/street rate if you recall one, else null>,
 "asOf": "<the approximate date your figures were current, YYYY-MM or YYYY-MM-DD, or 'unknown'>",
 "confidence": "<one of: low, medium, high>",
 "basis": "<one sentence, under 25 words, on where this recollection comes from and how stale it likely is>"}`

  const result = await callGroq(apiKey, [{ role: 'user', content: prompt }], { maxTokens: 300, temperature: 0 })
  if (!result.ok) {
    return res.status(200).json({ available: false, note: 'Could not reach the suggestion service.' })
  }

  const parsed = extractJson(result.content) as {
    officialRate?: unknown; parallelRate?: unknown; asOf?: unknown; confidence?: unknown; basis?: unknown
  } | null
  if (!parsed) {
    return res.status(200).json({ available: false, note: 'No usable suggestion was returned.' })
  }

  const num = (v: unknown): number | null => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : null
  }

  return res.status(200).json({
    available: true,
    officialRate: num(parsed.officialRate),
    parallelRate: num(parsed.parallelRate),
    asOf: typeof parsed.asOf === 'string' ? parsed.asOf : 'unknown',
    confidence: parsed.confidence === 'high' || parsed.confidence === 'medium' ? parsed.confidence : 'low',
    basis: typeof parsed.basis === 'string' ? parsed.basis : '',
  })
}
