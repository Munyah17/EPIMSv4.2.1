import type { VercelRequest, VercelResponse } from '@vercel/node'
import { serviceClient, requireSession } from './_lib/sessionAuth.js'

/**
 * GET  /api/fdms — device-link status: which env vars are set so the FDMS
 *        tab can show "Configured" or a checklist of what's missing.
 * POST /api/fdms { invoiceId } — fiscalise a paid invoice: build the
 *        receipt, submit it to ZIMRA's Fiscalisation Device Management
 *        System, and log the outcome in fdms_receipts (which only the
 *        service role writes — no browser can forge a fiscalised row).
 *
 * Required env vars:
 *   FDMS_BASE_URL  — e.g. https://fdms.zimra.co.zw
 *   FDMS_DEVICE_ID — the registered fiscal device ID
 *   FDMS_API_KEY   — device API key / certificate secret
 * Optional:
 *   FDMS_CURRENCY  — receipt currency code, defaults to 'USD'
 */
const REQUIRED_ENV = ['FDMS_BASE_URL', 'FDMS_DEVICE_ID', 'FDMS_API_KEY'] as const

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const admin = serviceClient()
  if (!admin) return res.status(503).json({ error: 'Server is not configured.' })
  if (!(await requireSession(req, admin))) return res.status(401).json({ error: 'Sign-in required.' })

  const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
  const { data: { user } } = await admin.auth.getUser(token)
  const { data: profile } = await admin.from('profiles').select('role').eq('id', user!.id).maybeSingle()
  if (!['super_admin', 'admin', 'finance'].includes(profile?.role ?? '')) {
    return res.status(403).json({ error: 'Admins and finance only.' })
  }

  const missingEnv = REQUIRED_ENV.filter(k => !process.env[k])
  const baseUrl = (process.env.FDMS_BASE_URL ?? '').replace(/\/+$/, '')
  const deviceId = process.env.FDMS_DEVICE_ID ?? ''
  const currency = process.env.FDMS_CURRENCY ?? 'USD'

  if (req.method === 'GET') {
    return res.status(200).json({
      configured: missingEnv.length === 0,
      deviceId: deviceId ? `${deviceId.slice(0, 3)}…${deviceId.slice(-2)}` : undefined,
      baseUrl: baseUrl || undefined,
      missingEnv,
    })
  }

  // ── POST: fiscalise one paid invoice ────────────────────────────────
  if (missingEnv.length) {
    return res.status(503).json({ error: `FDMS is not configured on the server — set ${missingEnv.join(', ')}.` })
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {})
  const invoiceId = typeof body.invoiceId === 'string' ? body.invoiceId : ''
  if (!invoiceId) return res.status(400).json({ error: 'Pass { invoiceId }.' })

  const { data: inv } = await admin
    .from('invoices')
    .select('id, invoice_number, amount, status, issued_at, paid_at, client_id, clients!client_id(name)')
    .eq('id', invoiceId)
    .maybeSingle()
  if (!inv) return res.status(404).json({ error: 'Invoice not found.' })
  if (inv.status !== 'paid') return res.status(400).json({ error: 'Only paid invoices are fiscalised — record payment first.' })

  // Already fiscalised? Return the existing receipt instead of double-
  // submitting — ZIMRA counts every accepted document against the fiscal day.
  const { data: existing } = await admin
    .from('fdms_receipts')
    .select('*')
    .eq('invoice_id', invoiceId)
    .eq('status', 'fiscalised')
    .maybeSingle()
  if (existing) return res.status(200).json({ receipt: existing, alreadyFiscalised: true })

  const clientName = (inv.clients as { name?: string } | null)?.name ?? ''
  const amount = Number(inv.amount) || 0
  const vatAmount = Math.round(amount * 0.155 / 1.155 * 100) / 100 // VAT-inclusive split at 15.5%

  /** Receipt payload per ZIMRA FDMS SubmitReceipt — the device signs the
   *  document and ZIMRA returns the global number, verification code and
   *  QR data a fiscal audit checks. */
  const receipt = {
    receiptType: 'FiscalInvoice',
    receiptCurrency: currency,
    receiptCounter: 1,
    receiptDate: (inv.paid_at ?? inv.issued_at ?? new Date().toISOString()),
    invoiceNo: inv.invoice_number,
    buyerData: { buyerName: clientName },
    receiptTotal: amount,
    receiptTaxes: [{ taxCode: 'A', taxPercent: 15.5, taxAmount: vatAmount, salesAmountWithTax: amount }],
    receiptPayments: [{ moneyTypeCode: 'CASH', paymentAmount: amount }],
  }

  // Log the attempt first — even a failed submission stays on record.
  const { data: log } = await admin.from('fdms_receipts').insert({
    invoice_id: invoiceId,
    receipt_number: inv.invoice_number,
    client_name: clientName,
    amount,
    vat_amount: vatAmount,
    status: 'pending',
    device_id: deviceId,
  }).select().single()

  try {
    const resp = await fetch(`${baseUrl}/Device/v1/${deviceId}/SubmitReceipt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.FDMS_API_KEY}`,
      },
      body: JSON.stringify({ receipt }),
      signal: AbortSignal.timeout(30_000),
    })
    const result = await resp.json().catch(() => ({})) as Record<string, unknown>

    if (!resp.ok) {
      const msg = (result.message as string) || `FDMS responded ${resp.status}`
      if (log) await admin.from('fdms_receipts').update({ status: 'failed', error: msg }).eq('id', log.id)
      return res.status(502).json({ error: msg })
    }

    const update = {
      status: 'fiscalised' as const,
      fiscal_day: (result.fiscalDayNo ?? result.fiscalDay ?? null) as string | null,
      global_no: (result.receiptGlobalNo ?? result.globalNo ?? null) as number | null,
      verification_code: (result.receiptVerificationCode ?? result.verificationCode ?? null) as string | null,
      qr_data: (result.receiptQrData ?? result.qrData ?? result.verificationQRCode ?? null) as string | null,
      error: null,
    }
    if (log) {
      await admin.from('fdms_receipts').update(update).eq('id', log.id)
      return res.status(200).json({ receipt: { ...log, ...update } })
    }
    return res.status(200).json({ receipt: update })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'FDMS request failed'
    if (log) await admin.from('fdms_receipts').update({ status: 'failed', error: msg }).eq('id', log.id)
    return res.status(502).json({ error: msg })
  }
}
