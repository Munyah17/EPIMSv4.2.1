import type { VercelRequest, VercelResponse } from '@vercel/node'
import { serviceClient } from './_lib/sessionAuth.js'
import { createClient, createPolicy, getActiveProducts, clientByNationalId, policiesForClient } from './_lib/bot/data.js'
import type { BotProduct } from './_lib/bot/types.js'
import { initiatePaynowPayment } from './_lib/paynowInitiate.js'
import { chargeEip, eipConfigured, normalizeMsisdn } from './_lib/ecocashInstant.js'

/**
 * POST /api/website-register — the motions.co.zw → portal bridge.
 *
 * The website must NEVER write to Supabase directly: this endpoint is
 * the single, validated, numbered, recorded path for a website signup.
 * Ordering is the safety design:
 *
 *   1. client row created (or an existing one reused by national_id)
 *   2. pending policy created with a real policy number
 *   3. payment initiated through OUR integrations — Paynow link or
 *      EcoCash push — only once the records exist
 *
 * So the two failure rules the client cares about hold by construction:
 *
 *   - registration fails  → no payment was ever initiated; the caller
 *     gets an error to show, nothing to refund. If step 2 dies after a
 *     NEW client was inserted, that row is deleted as compensation.
 *   - payment fails       → the client+policy exist as 'pending'; the
 *     caller shows "payment failed — try again" and a retry reuses the
 *     same policy (no duplicate). Our paynow-webhook is the single
 *     reconciler for confirmations and failures alike.
 *
 * Auth: machine secret — WEBSITE_API_SECRET, falling back to the shared
 * NOTIFY_SECRET/CRON_SECRET the website's other calls already use.
 * This is not a user-session endpoint.
 *
 * Actions:
 *   { }  full body → register + initiate payment
 *   { action:'status', reference } → paynow/policy status for tally-up
 */

interface DependantIn {
  name: string; nationalId?: string; dob?: string; relationship?: string; gender?: string
}

interface Body {
  action?: string
  reference?: string
  name?: string; nationalId?: string; phone?: string; email?: string
  dob?: string; gender?: string; address?: string; occupation?: string
  agentId?: string
  productCode?: string; productId?: string
  dependants?: DependantIn[]
  paymentMethod?: 'paynow' | 'ecocash'
  currency?: 'USD' | 'ZWG'
  ecocashNumber?: string
  payerEmail?: string
  origin?: string
}

function machineOk(req: VercelRequest): boolean {
  const secret = process.env.WEBSITE_API_SECRET || process.env.NOTIFY_SECRET || process.env.CRON_SECRET
  return !!secret && req.headers.authorization === `Bearer ${secret}`
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  if (!machineOk(req)) return res.status(401).json({ error: 'Bad machine credential.' })

  const admin = serviceClient()
  if (!admin) return res.status(503).json({ error: 'Server is not configured.' })

  const body = (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {})) as Body

  /* ---------------- status lookup — the tally-up read ---------------- */
  if (body.action === 'status') {
    const reference = String(body.reference ?? '')
    if (!reference) return res.status(400).json({ error: 'reference is required.' })
    const { data: txn } = await admin.from('paynow_transactions')
      .select('reference, status, expected_amount, confirmed_amount, currency, policy_id, created_at, updated_at')
      .eq('reference', reference).maybeSingle()
    if (!txn) return res.status(404).json({ ok: false, error: 'Unknown reference.' })
    let policy: { policy_number?: string; status?: string } | null = null
    if (txn.policy_id) {
      const { data } = await admin.from('policies').select('policy_number, status').eq('id', txn.policy_id).maybeSingle()
      policy = data
    }
    return res.status(200).json({ ok: true, transaction: txn, policy })
  }

  /* ------------------------------ register ------------------------------ */

  const name = String(body.name ?? '').trim()
  const nationalId = String(body.nationalId ?? '').trim()
  const phone = String(body.phone ?? '').trim()
  if (!name || !nationalId || !phone) {
    return res.status(400).json({ ok: false, error: 'name, nationalId and phone are required.' })
  }

  const paymentMethod = body.paymentMethod === 'ecocash' ? 'ecocash' : 'paynow'
  const currency = body.currency === 'ZWG' ? 'ZWG' : 'USD'

  // Product: resolve by id or by code — the website sends whichever its
  // checkout knows; the products table is the one source of truth either
  // way, so a product edited in the portal prices correctly here.
  const products = await getActiveProducts(admin)
  const product: BotProduct | undefined = products.find(p => p.id === body.productId)
    ?? products.find(p => p.code === String(body.productCode ?? '').toUpperCase())
    ?? products.find(p => p.name.toLowerCase() === String(body.productCode ?? '').toLowerCase())
  if (!product) {
    return res.status(400).json({ ok: false, error: `No active product matching '${body.productId ?? body.productCode}'.` })
  }

  const dependants = (body.dependants ?? []).slice(0, 10).map(d => ({
    name: String(d.name ?? '').trim(), nationalId: d.nationalId, dob: d.dob,
    relationship: d.relationship ?? 'dependant', gender: d.gender,
    premium: product.premium, coverAmount: product.coverAmount, productName: product.name,
  })).filter(d => d.name)

  let createdClientId: string | null = null
  try {
    // Idempotent by national_id: a retried submission reuses the client
    // and — if a pending policy exists — re-initiates payment on IT
    // instead of writing a duplicate.
    let client = await clientByNationalId(admin, nationalId)
    if (!client) {
      client = await createClient(admin, {
        name, nationalId, phone,
        email: body.email, dob: body.dob, gender: body.gender,
        agentId: body.agentId,
      })
      createdClientId = client.id
      // Address/occupation live on the client row; set when supplied.
      if (body.address || body.occupation) {
        await admin.from('clients').update({ address: body.address ?? '', occupation: body.occupation ?? null }).eq('id', client.id)
      }
    }

    const existing = await policiesForClient(admin, client.id)
    let policy = existing.find(p => p.status === 'pending' && p.productName === product.name)
      ?? existing.find(p => p.status === 'pending')
    if (!policy && existing.some(p => ['active', 'waiting_period'].includes(p.status) && p.productName === product.name)) {
      return res.status(409).json({ ok: false, error: 'This client already has a live policy on that product.', code: 'ALREADY_COVERED' })
    }

    if (!policy) {
      const start = new Date()
      const end = new Date(start); end.setFullYear(end.getFullYear() + 1)
      const created = await createPolicy(admin, {
        clientId: client.id, product,
        paymentMethod: paymentMethod === 'ecocash' ? 'EcoCash' : 'Paynow',
        agentId: body.agentId ?? undefined,
        startDate: start.toISOString().split('T')[0],
        endDate: end.toISOString().split('T')[0],
        source: 'motions_website',
      })
      if (dependants.length) {
        await admin.from('policies').update({ dependants }).eq('id', created.id)
      }
      policy = created
    }

    // ── Payment — LAST. Records exist; only now does money move. ──
    // Amount follows billablePremium(): one head per dependant, plus the
    // policyholder — the same total the webhook reconciles.
    const usdAmount = Math.round(policy.premium * (1 + dependants.length) * 100) / 100
    const reference = `${policy.policyNumber}-${Date.now().toString(36).toUpperCase()}`

    if (paymentMethod === 'ecocash') {
      if (!eipConfigured()) return res.status(503).json({ ok: false, error: 'EcoCash Instant is not configured on the server.', policyId: policy.id, policyNumber: policy.policyNumber })
      const ecocashTo = normalizeMsisdn(body.ecocashNumber ?? phone)
      if (!ecocashTo) return res.status(400).json({ ok: false, error: 'A valid EcoCash number is required for EcoCash payment.', policyId: policy.id, policyNumber: policy.policyNumber })
      const result = await chargeEip({ phone: ecocashTo, amount: usdAmount, reference, description: `${policy.policyNumber} premium` })
      if (result.result.outcome !== 'success') {
        // Payment failed → registration stays pending, caller retries.
        return res.status(402).json({
          ok: false, code: 'PAYMENT_FAILED',
          error: `EcoCash charge was not accepted — ask the client to check their phone or try again. (${result.result.outcome})`,
          clientId: client.id, policyId: policy.id, policyNumber: policy.policyNumber, reference,
        })
      }
      return res.status(200).json({
        ok: true, clientId: client.id, clientName: client.name,
        policyId: policy.id, policyNumber: policy.policyNumber, reference,
        method: 'ecocash', message: 'PIN prompt sent to the payer’s phone. Confirm via the lookup URL.',
        lookupUrl: result.lookupUrl,
      })
    }

    const origin = body.origin ?? 'https://www.motions.co.zw'
    const initiated = await initiatePaynowPayment({
      admin, reference, policyId: policy.id,
      usdAmount, currency, origin,
      description: `${policy.policyNumber} premium`,
      email: process.env.PAYNOW_LIVE === 'true' ? body.payerEmail : undefined,
    })
    if (!initiated.ok) {
      return res.status(402).json({
        ok: false, code: 'PAYMENT_FAILED',
        error: `Could not start the Paynow payment — the client can retry; no money was taken. (${initiated.error})`,
        clientId: client.id, policyId: policy.id, policyNumber: policy.policyNumber,
      })
    }

    return res.status(200).json({
      ok: true, clientId: client.id, clientName: client.name,
      policyId: policy.id, policyNumber: policy.policyNumber,
      reference, method: 'paynow',
      redirectUrl: initiated.redirectUrl, pollUrl: initiated.pollUrl,
      amount: initiated.amount,
      message: 'Redirect the payer to redirectUrl. Confirmation arrives at the portal’s paynow webhook — poll the pollUrl or call {action:\'status\', reference} to tally it up.',
    })
  } catch (e) {
    // Registration blew up mid-write — remove a NEWLY-created client row
    // so the failure leaves nothing behind (a reused client is kept).
    if (createdClientId) {
      try { await admin.from('clients').delete().eq('id', createdClientId) } catch { /**/ }
    }
    const msg = e instanceof Error ? e.message : String(e)
    console.error('website-register failed:', msg)
    return res.status(500).json({ ok: false, code: 'REGISTRATION_FAILED', error: `Registration failed before any payment was initiated — nothing was charged. (${msg})` })
  }
}
