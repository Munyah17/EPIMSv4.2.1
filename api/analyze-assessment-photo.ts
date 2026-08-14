import type { VercelRequest, VercelResponse } from '@vercel/node'

/**
 * Runs an assessment photo through Claude's vision to help catch staged or
 * reused images — reads any visible burned-in date stamp, checks whether
 * the photo actually shows what it's labeled as (e.g. barn fire damage,
 * hail-damaged crop), and flags anything inconsistent. This is a second
 * opinion alongside the EXIF DateTimeOriginal check (src/lib/exifDate.ts)
 * done client-side — a photo can lack EXIF (screenshots, forwarded images)
 * or have a visible on-image stamp EXIF won't show, so both are used.
 *
 * Requires ANTHROPIC_API_KEY (server-side only). Without it, returns
 * { simulated: true } so the assessment flow can still be used — an AI
 * opinion is a fraud-detection aid, not a hard gate on submitting.
 */

interface Body {
  imageBase64: string
  mediaType: string
  label: string
  claimDescription?: string
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return res.status(200).json({ simulated: true, reason: 'ANTHROPIC_API_KEY not configured' })
  }

  const body: Body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {})
  if (!body.imageBase64 || !body.mediaType || !body.label) {
    return res.status(400).json({ error: 'imageBase64, mediaType, and label are required' })
  }

  const today = new Date().toISOString().split('T')[0]
  const prompt = `You are assisting an insurance assessor reviewing a photo submitted as evidence for an agriculture claim (label: "${body.label}"). Today's date is ${today}.${body.claimDescription ? ` Claim description: "${body.claimDescription}"` : ''}

Look at the image and answer, as strict JSON only (no markdown fences, no other text):
{
  "visibleDateStamp": string or null (a burned-in date/timestamp overlay printed on the photo by a camera app, if any — in YYYY-MM-DD format if found, else null),
  "contentMatchesLabel": boolean (does the image plausibly show what the label claims, e.g. barn fire damage, hail-damaged crop, wind-storm damage, flooded field, drought-affected crop, etc.),
  "flagged": boolean (true if anything raises fraud concern — the visible date stamp is more than 3 days before today, the image doesn't match the label, signs of screen-photography/reused stock imagery, or other inconsistency),
  "note": string (one or two sentences explaining your assessment, addressed to the assessor)
}`

  try {
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: body.mediaType, data: body.imageBase64 } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    })
    if (!apiRes.ok) {
      const text = await apiRes.text()
      return res.status(502).json({ error: `AI service error (HTTP ${apiRes.status}): ${text}` })
    }
    const data = await apiRes.json()
    const text = data?.content?.[0]?.text ?? '{}'
    let parsed: { visibleDateStamp?: string | null; contentMatchesLabel?: boolean; flagged?: boolean; note?: string }
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = { flagged: false, note: 'Could not parse AI response.' }
    }
    return res.status(200).json(parsed)
  } catch (e) {
    return res.status(502).json({ error: `Could not reach AI service: ${e}` })
  }
}
