import type { VercelRequest, VercelResponse } from '@vercel/node'
import { Paynow } from 'paynow'
import { serviceClient, requireSession } from './_lib/sessionAuth.js'
import { initiatePaynowPayment, integrationFor, type PaynowCurrency } from './_lib/paynowInitiate.js'

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
 * Transaction creation lives in _lib/paynowInitiate.ts so the WhatsApp
 * bot can start payments the same way without a browser session.
 *
 * Credentials come from the server environment. Set PAYNOW_INTEGRATION_ID
 * and PAYNOW_INTEGRATION_KEY; the browser never sees them.
 */

interface InitiateBody {
  action?: string
  reference?: string
  /** Always USD -- the billed amount. Converted below when charging in
   *  another currency. */
  amount?: number
  currency?: string
  description?: string
  /** Only sent when it is genuinely the payer's address. An integration
   *  still in test mode rejects any authemail that is not the merchant's
   *  own registered address, so a blank one is simply omitted. */
  email?: string
  returnUrl?: string
  resultUrl?: string
  /** Poll url handed back by initiate, for action 'poll'. */
  pollUrl?: string
  /** Required for 'initiate' -- see paynow_transactions below. */
  policyId?: string
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  // Both actions ride our own Paynow integrations: 'initiate' creates real
  // payable transactions and 'poll' posts to Paynow from this function, so
  // neither is open to the anonymous internet -- every caller is inside a
  // login (staff on Billing, or a policyholder on the client portal).
  const admin = serviceClient()
  if (!admin) return res.status(500).json({ error: 'Server is not configured (missing Supabase service credentials).' })
  if (!(await requireSession(req, admin))) {
    return res.status(401).json({ error: 'Sign-in required.' })
  }

  const body = (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {})) as InitiateBody
  const origin = `https://${req.headers.host}`

  const currency: PaynowCurrency = body.currency === 'ZWG' ? 'ZWG' : 'USD'

  try {
    if (body.action === 'poll') {
      if (!body.pollUrl) return res.status(400).json({ error: 'pollUrl is required.' })
      // pollTransaction POSTs to whatever URL it is handed -- locked to
      // Paynow's own hosts so the endpoint can't be used to poke arbitrary
      // addresses from inside our function.
      let pollHost = ''
      try { pollHost = new URL(body.pollUrl).hostname } catch { pollHost = '' }
      if (pollHost !== 'paynow.co.zw' && !pollHost.endsWith('.paynow.co.zw')) {
        return res.status(400).json({ error: 'pollUrl is not a Paynow address.' })
      }
      // Same SDK call the public site uses: it POSTs (not GETs) as Paynow's
      // pollurl expects, and verifies the response hash before trusting it.
      const paynow = new Paynow('', integrationFor(currency).key ?? '', '', '')
      const response = await paynow.pollTransaction(body.pollUrl)
      const status = String(response?.status ?? '').toLowerCase()
      // Coerced to a real number (Paynow's SDK returns it as a string), so
      // the caller can compare it against the amount it expected rather
      // than just trusting the paid/status flag on its own -- "paid" tells
      // you the reference cleared, not that it cleared for what you asked.
      const rawAmount = (response as { amount?: unknown } | null)?.amount
      const amount = rawAmount !== undefined && rawAmount !== null && Number.isFinite(Number(rawAmount))
        ? Number(rawAmount) : null
      return res.status(200).json({
        status,
        paid: status === 'paid' || status === 'awaiting delivery',
        amount,
      })
    }

    if (body.action === 'initiate') {
      const reference = String(body.reference ?? '')
      const usdAmount = Number(body.amount)
      const policyId = String(body.policyId ?? '')
      if (!reference || !Number.isFinite(usdAmount) || usdAmount <= 0) {
        return res.status(400).json({ error: 'reference and a positive amount are required.' })
      }

      // Required, not optional: without it, api/paynow-webhook.ts has no
      // record of what this reference was actually FOR, and can only ever
      // trust Paynow's own "paid" flag blindly -- exactly the gap that lets
      // an amount mismatch through unnoticed. See paynow_transactions.
      // The UUID check fails fast: a malformed id makes the tracking-row
      // insert die silently below, which leaves the webhook with nothing
      // to reconcile a genuinely-paid transaction against.
      if (!policyId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(policyId)) {
        return res.status(400).json({ error: 'policyId is required and must be a valid UUID.' })
      }

      const result = await initiatePaynowPayment({
        reference, usdAmount, currency, policyId, origin, admin,
        description: body.description, email: body.email,
      })
      if (!result.ok) return res.status(result.error?.includes('Maintenance') ? 503 : 200).json({ ok: false, error: result.error })

      return res.status(200).json({
        ok: true,
        redirectUrl: result.redirectUrl,
        pollUrl: result.pollUrl,
        currency: result.currency,
        // What Paynow will actually charge, so the payer is shown the figure
        // they are about to be asked for rather than the USD equivalent.
        amount: result.amount,
      })
    }

    return res.status(400).json({ error: 'action must be "initiate" or "poll".' })
  } catch (e) {
    return res.status(502).json({ error: `Could not reach Paynow: ${e}` })
  }
}
