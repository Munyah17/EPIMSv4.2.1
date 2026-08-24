import type { VercelRequest, VercelResponse } from '@vercel/node'
import { Paynow } from 'paynow'

/**
 * Paynow, through Paynow's own SDK.
 *
 * The browser used to build the request by hand -- concatenating fields and
 * signing them itself -- and it signed with MD5. Paynow signs with SHA512,
 * so it answered "Invalid Hash. Hash should start with: ..." and no
 * transaction was ever created, whatever integration key was configured.
 *
 * Nothing here reimplements Paynow's protocol. The SDK owns the field
 * order, the signature, the response parsing and the hash verification,
 * exactly as motions-website/api/create-checkout.ts does -- which is the
 * copy that has always worked. It lives on the server because the SDK is a
 * Node library and Paynow rejects direct browser calls via CORS.
 *
 * Credentials come from the server environment. Set PAYNOW_INTEGRATION_ID
 * and PAYNOW_INTEGRATION_KEY; the browser never sees them.
 */

interface InitiateBody {
  action?: string
  reference?: string
  amount?: number
  description?: string
  /** Only sent when it is genuinely the payer's address. An integration
   *  still in test mode rejects any authemail that is not the merchant's
   *  own registered address, so a blank one is simply omitted. */
  email?: string
  returnUrl?: string
  resultUrl?: string
  /** Poll url handed back by initiate, for action 'poll'. */
  pollUrl?: string
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const integrationId = process.env.PAYNOW_INTEGRATION_ID
  const integrationKey = process.env.PAYNOW_INTEGRATION_KEY
  if (!integrationId || !integrationKey) {
    return res.status(503).json({ error: 'Paynow is not configured on the server (PAYNOW_INTEGRATION_ID / PAYNOW_INTEGRATION_KEY).' })
  }

  const body = (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {})) as InitiateBody
  const origin = `https://${req.headers.host}`

  try {
    if (body.action === 'poll') {
      if (!body.pollUrl) return res.status(400).json({ error: 'pollUrl is required.' })
      // Same SDK call the public site uses: it POSTs (not GETs) as Paynow's
      // pollurl expects, and verifies the response hash before trusting it.
      const paynow = new Paynow('', integrationKey, '', '')
      const response = await paynow.pollTransaction(body.pollUrl)
      const status = String(response?.status ?? '').toLowerCase()
      return res.status(200).json({
        status,
        paid: status === 'paid' || status === 'awaiting delivery',
        amount: (response as { amount?: unknown } | null)?.amount ?? null,
      })
    }

    if (body.action === 'initiate') {
      const reference = String(body.reference ?? '')
      const amount = Number(body.amount)
      if (!reference || !Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ error: 'reference and a positive amount are required.' })
      }

      const paynow = new Paynow(
        integrationId,
        integrationKey,
        body.resultUrl || `${origin}/api/paynow-webhook`,
        body.returnUrl || `${origin}/payment/return`,
      )
      // A hosted payment: Paynow's own page presents its rail picker, so no
      // method is pre-selected on the payer's behalf.
      const payment = paynow.createPayment(reference, body.email || '')
      payment.add(body.description || 'Insurance Premium', amount)

      const response = await paynow.send(payment)
      if (!response || !response.success) {
        // Paynow's own words: "in test mode, authemail must match the
        // merchant's address", "not a site integration", "currently
        // inactive". Those name the fix; our paraphrase would not.
        return res.status(200).json({ ok: false, error: String(response?.error ?? 'Paynow declined the request.') })
      }
      return res.status(200).json({
        ok: true,
        redirectUrl: String(response.redirectUrl ?? ''),
        pollUrl: String(response.pollUrl ?? ''),
      })
    }

    return res.status(400).json({ error: 'action must be "initiate" or "poll".' })
  } catch (e) {
    return res.status(502).json({ error: `Could not reach Paynow: ${e}` })
  }
}
