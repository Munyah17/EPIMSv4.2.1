import type { VercelRequest, VercelResponse } from '@vercel/node'
import type { SupabaseClient } from '@supabase/supabase-js'
import { serviceClient, requireSession } from './_lib/sessionAuth.js'

/**
 * ZIMRA FDMS — Virtual Fiscalisation (Option B: direct API interface).
 *
 * GET  /api/fdms
 *   → device-link status: config presence, masked device id, environment
 *     (test/live), and the currently open fiscal day.
 *
 * POST /api/fdms { action, ... }
 *   openDay    {}                          → open a fiscal day (auto-opens on first doc)
 *   closeDay   {}                          → close the open day; reports error count
 *   submit     { invoiceId }               → FiscalInvoice for a paid invoice (default)
 *   creditNote { originalReceiptId, reason, amount? } → CreditNote against a
 *                                            fiscalised document (partial if amount < original)
 *   debitNote  { originalReceiptId, reason, amount? } → DebitNote (surcharge)
 *   retry      { receiptId }               → resubmit a 'failed' document
 *
 * Every document lands in fdms_receipts (pending → fiscalised | failed),
 * inside an fdms_fiscal_days session whose receipt_counter runs
 * contiguously — a counter is consumed on issue even when ZIMRA rejects
 * the document, because gaps in the counter are themselves an audit flag.
 *
 * Required env vars:
 *   FDMS_BASE_URL  — test or live host, e.g. https://fdms.zimra.co.zw
 *   FDMS_DEVICE_ID — the registered virtual device ID
 *   FDMS_API_KEY   — device API key / certificate secret
 * Optional:
 *   FDMS_CURRENCY  — receipt currency code, defaults to 'USD'
 *
 * NOTE: the endpoint paths/payload below follow ZIMRA's Device/v1 surface
 * (OpenFiscalDay / CloseFiscalDay / SubmitReceipt). Verify each field name
 * against the Fiscalisation API document ZIMRA issues with your test
 * credentials — adjustments are isolated to buildReceiptPayload + the two
 * path constants at the top of fdmsPost calls.
 */
const REQUIRED_ENV = ['FDMS_BASE_URL', 'FDMS_DEVICE_ID', 'FDMS_API_KEY'] as const
const VAT_RATE = 15.5

type DocType = 'FiscalInvoice' | 'CreditNote' | 'DebitNote'
const DOC_PREFIX: Record<DocType, string> = { FiscalInvoice: '', CreditNote: 'CN-', DebitNote: 'DN-' }

interface FiscalDayRow {
  id: string
  device_id: string
  fiscal_day_no: string
  status: 'open' | 'closed' | 'closed_with_errors'
  opened_at: string
  opened_by: string | null
  closed_at: string | null
  closed_by: string | null
  receipt_counter: number
  docs_count: number
  upstream_error: string | null
}

interface ReceiptRow {
  id: string
  invoice_id: string | null
  receipt_number: string
  client_name: string
  amount: number
  status: string
  doc_type: DocType
  receipt_counter: number | null
  fiscal_day_id: string | null
  original_receipt_id: string | null
  global_no: number | null
  verification_code: string | null
  error: string | null
}

/** One FDMS round-trip on the Device/v1 surface. */
async function fdmsPost(baseUrl: string, deviceId: string, path: string, payload: unknown) {
  const resp = await fetch(`${baseUrl}/Device/v1/${deviceId}/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.FDMS_API_KEY}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  })
  const data = await resp.json().catch(() => ({})) as Record<string, unknown>
  if (!resp.ok) {
    return { ok: false as const, error: (data.message as string) || (data.error as string) || `FDMS responded ${resp.status}`, data }
  }
  return { ok: true as const, data }
}

/** The receipt document as ZIMRA's SubmitReceipt expects it — invoice,
 *  credit note and debit note share the shape; notes additionally carry
 *  the reference to the document they adjust. Verify field names against
 *  ZIMRA's issued API doc before live submission. */
function buildReceiptPayload(p: {
  docType: DocType
  counter: number
  currency: string
  receiptNumber: string
  clientName: string
  amount: number
  vatAmount: number
  receiptDate: string
  reason?: string
  original?: { receipt_number: string; global_no: number | null }
}) {
  return {
    receiptType: p.docType,
    receiptCurrency: p.currency,
    receiptCounter: p.counter,
    receiptDate: p.receiptDate,
    invoiceNo: p.receiptNumber,
    buyerData: { buyerName: p.clientName },
    receiptTotal: p.amount,
    receiptTaxes: [{ taxCode: 'A', taxPercent: VAT_RATE, taxAmount: p.vatAmount, salesAmountWithTax: p.amount }],
    receiptPayments: [{ moneyTypeCode: 'CASH', paymentAmount: p.amount }],
    ...(p.original ? {
      originalReceiptNo: p.original.receipt_number,
      originalReceiptGlobalNo: p.original.global_no ?? undefined,
      creditDebitReason: p.reason ?? undefined,
    } : {}),
  }
}

/** The open fiscal day for this device, or null. */
async function getOpenDay(admin: SupabaseClient, deviceId: string): Promise<FiscalDayRow | null> {
  const { data } = await admin
    .from('fdms_fiscal_days')
    .select('*')
    .eq('device_id', deviceId)
    .eq('status', 'open')
    .order('opened_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as FiscalDayRow | null) ?? null
}

/**
 * The open day, creating one when none exists — ZIMRA requires a day open
 * before any document issues. The upstream OpenFiscalDay call is best-
 * effort: a locally-opened day still consumes counters and queues
 * documents, which lets the flow be exercised while test credentials are
 * pending; the upstream failure is stored on the day for the panel.
 */
async function ensureOpenDay(
  admin: SupabaseClient, baseUrl: string, deviceId: string, actorName: string,
): Promise<{ day: FiscalDayRow | null; error?: string }> {
  const existing = await getOpenDay(admin, deviceId)
  if (existing) return { day: existing }

  const { count } = await admin
    .from('fdms_fiscal_days')
    .select('id', { count: 'exact', head: true })
    .eq('device_id', deviceId)
  const localNo = `FD-${String((count ?? 0) + 1).padStart(4, '0')}`

  const { data: day, error: insErr } = await admin
    .from('fdms_fiscal_days')
    .insert({ device_id: deviceId, fiscal_day_no: localNo, status: 'open', opened_by: actorName })
    .select()
    .single()
  if (insErr || !day) return { day: null, error: insErr?.message ?? 'Could not open a fiscal day — run database/extend_fdms_fiscalisation.sql.' }

  // Tell ZIMRA the day opened; on failure the day stays open locally with
  // the error recorded — each document's own submission is what ZIMRA
  // ultimately accepts or rejects.
  const open = await fdmsPost(baseUrl, deviceId, 'OpenFiscalDay', { fiscalDayNo: localNo }).catch(e => ({
    ok: false as const, error: e instanceof Error ? e.message : 'OpenFiscalDay failed', data: {},
  }))
  if (!open.ok) {
    await admin.from('fdms_fiscal_days').update({ upstream_error: `OpenFiscalDay: ${open.error}` }).eq('id', day.id)
    return { day: { ...(day as FiscalDayRow), upstream_error: `OpenFiscalDay: ${open.error}` } }
  }
  const zimraNo = (open.data.fiscalDayNo ?? open.data.fiscalDay ?? null) as string | null
  if (zimraNo && zimraNo !== localNo) {
    await admin.from('fdms_fiscal_days').update({ fiscal_day_no: zimraNo }).eq('id', day.id)
    return { day: { ...(day as FiscalDayRow), fiscal_day_no: zimraNo } }
  }
  return { day: day as FiscalDayRow }
}

/**
 * Issue a document inside the open day: consume the next counter, log the
 * row, submit to ZIMRA, record the verdict, advance the day.
 */
async function issueDocument(
  admin: SupabaseClient, baseUrl: string, deviceId: string, currency: string, day: FiscalDayRow,
  params: {
    docType: DocType
    receiptNumber: string       // bare document number (prefix added here)
    clientName: string
    amount: number
    invoiceId?: string
    receiptDate: string
    reason?: string
    original?: { id: string; receipt_number: string; global_no: number | null }
    /** Re-use an existing failed row instead of inserting (retry). */
    existingReceiptId?: string
    existingCounter?: number
  },
) {
  const counter = params.existingCounter ?? (day.receipt_counter + 1)
  const vatAmount = Math.round(params.amount * VAT_RATE / (100 + VAT_RATE) * 100) / 100
  const receiptNumber = `${DOC_PREFIX[params.docType]}${params.receiptNumber}`

  // The counter is consumed the moment the document is issued — an
  // upstream rejection does NOT hand it back, or the sequence gets holes.
  if (!params.existingReceiptId) {
    await admin.from('fdms_fiscal_days')
      .update({ receipt_counter: counter, docs_count: day.docs_count + 1 })
      .eq('id', day.id)
  }

  let logId = params.existingReceiptId ?? null
  if (!logId) {
    const { data: log } = await admin.from('fdms_receipts').insert({
      invoice_id: params.invoiceId ?? null,
      receipt_number: receiptNumber,
      client_name: params.clientName,
      amount: params.amount,
      vat_amount: vatAmount,
      status: 'pending',
      doc_type: params.docType,
      receipt_counter: counter,
      fiscal_day_id: day.id,
      original_receipt_id: params.original?.id ?? null,
      reason: params.reason ?? null,
      device_id: deviceId,
    }).select().single()
    logId = log?.id ?? null
  }

  const payload = buildReceiptPayload({
    docType: params.docType,
    counter,
    currency,
    receiptNumber,
    clientName: params.clientName,
    amount: params.amount,
    vatAmount,
    receiptDate: params.receiptDate,
    reason: params.reason,
    original: params.original ? { receipt_number: params.original.receipt_number, global_no: params.original.global_no } : undefined,
  })

  const submitted = await fdmsPost(baseUrl, deviceId, 'SubmitReceipt', { receipt: payload }).catch(e => ({
    ok: false as const, error: e instanceof Error ? e.message : 'FDMS request failed', data: {},
  }))

  if (!submitted.ok) {
    if (logId) await admin.from('fdms_receipts').update({ status: 'failed', error: submitted.error }).eq('id', logId)
    await admin.from('fdms_fiscal_days').update({ upstream_error: submitted.error }).eq('id', day.id)
    return { error: submitted.error }
  }

  const result = submitted.data
  const update = {
    status: 'fiscalised' as const,
    fiscal_day: (result.fiscalDayNo ?? result.fiscalDay ?? day.fiscal_day_no) as string,
    global_no: (result.receiptGlobalNo ?? result.globalNo ?? null) as number | null,
    verification_code: (result.receiptVerificationCode ?? result.verificationCode ?? null) as string | null,
    qr_data: (result.receiptQrData ?? result.qrData ?? result.verificationQRCode ?? null) as string | null,
    error: null,
  }
  if (logId) {
    const { data: updated } = await admin.from('fdms_receipts').update(update).eq('id', logId).select().single()
    return { receipt: updated ?? { id: logId, ...update } }
  }
  return { receipt: update }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const admin = serviceClient()
  if (!admin) return res.status(503).json({ error: 'Server is not configured.' })
  if (!(await requireSession(req, admin))) return res.status(401).json({ error: 'Sign-in required.' })

  const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
  const { data: { user } } = await admin.auth.getUser(token)
  const { data: profile } = await admin.from('profiles').select('role, name').eq('id', user!.id).maybeSingle()
  if (!['super_admin', 'admin', 'finance'].includes(profile?.role ?? '')) {
    return res.status(403).json({ error: 'Admins and finance only.' })
  }
  const actorName = (profile?.name as string | undefined) ?? user?.email ?? 'staff'

  const missingEnv = REQUIRED_ENV.filter(k => !process.env[k])
  const baseUrl = (process.env.FDMS_BASE_URL ?? '').replace(/\/+$/, '')
  const deviceId = process.env.FDMS_DEVICE_ID ?? ''
  const currency = process.env.FDMS_CURRENCY ?? 'USD'
  const environment = /test|sandbox|dev/i.test(baseUrl) ? 'test' : 'live'

  if (req.method === 'GET') {
    const openDay = deviceId ? await getOpenDay(admin, deviceId).catch(() => null) : null
    return res.status(200).json({
      configured: missingEnv.length === 0,
      deviceId: deviceId ? `${deviceId.slice(0, 3)}…${deviceId.slice(-2)}` : undefined,
      baseUrl: baseUrl || undefined,
      environment,
      missingEnv,
      openDay,
    })
  }

  // ── POST ─────────────────────────────────────────────────────────
  if (missingEnv.length) {
    return res.status(503).json({ error: `FDMS is not configured on the server — set ${missingEnv.join(', ')}.` })
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {})
  const action: string = typeof body.action === 'string' ? body.action : 'submit'

  // ── openDay ──────────────────────────────────────────────────────
  if (action === 'openDay') {
    const { day, error } = await ensureOpenDay(admin, baseUrl, deviceId, actorName)
    if (!day) return res.status(500).json({ error: error ?? 'Could not open a fiscal day.' })
    return res.status(200).json({ day, upstreamWarning: day.upstream_error ?? undefined })
  }

  // ── closeDay ─────────────────────────────────────────────────────
  if (action === 'closeDay') {
    const day = await getOpenDay(admin, deviceId)
    if (!day) return res.status(400).json({ error: 'No open fiscal day to close.' })

    // A clean close — zero failed/pending documents — is what ZIMRA's
    // approval flow checks for before registering the device live.
    const { count: errorDocs } = await admin
      .from('fdms_receipts')
      .select('id', { count: 'exact', head: true })
      .eq('fiscal_day_id', day.id)
      .neq('status', 'fiscalised')

    const closed = await fdmsPost(baseUrl, deviceId, 'CloseFiscalDay', { fiscalDayNo: day.fiscal_day_no }).catch(e => ({
      ok: false as const, error: e instanceof Error ? e.message : 'CloseFiscalDay failed', data: {},
    }))

    const status = (errorDocs ?? 0) > 0 ? 'closed_with_errors' : 'closed'
    const upstreamError = closed.ok ? null : `CloseFiscalDay: ${closed.error}`
    const { data: updated } = await admin.from('fdms_fiscal_days')
      .update({ status, closed_at: new Date().toISOString(), closed_by: actorName, upstream_error: upstreamError ?? day.upstream_error })
      .eq('id', day.id).select().single()
    return res.status(200).json({
      day: updated ?? { ...day, status },
      errorDocs: errorDocs ?? 0,
      upstreamWarning: closed.ok ? undefined : closed.error,
    })
  }

  // ── retry a failed document ──────────────────────────────────────
  if (action === 'retry') {
    const receiptId = typeof body.receiptId === 'string' ? body.receiptId : ''
    if (!receiptId) return res.status(400).json({ error: 'Pass { receiptId }.' })
    const { data: row } = await admin.from('fdms_receipts').select('*').eq('id', receiptId).maybeSingle()
    const doc = row as ReceiptRow | null
    if (!doc) return res.status(404).json({ error: 'Document not found.' })
    if (doc.status === 'fiscalised') return res.status(400).json({ error: 'Already fiscalised — ZIMRA has it.' })

    const day = doc.fiscal_day_id
      ? (await admin.from('fdms_fiscal_days').select('*').eq('id', doc.fiscal_day_id).maybeSingle()).data as FiscalDayRow | null
      : await getOpenDay(admin, deviceId)
    if (!day || day.status !== 'open') {
      return res.status(400).json({ error: 'The fiscal day this document belongs to is closed — issue a credit/debit note instead of retrying.' })
    }

    const original = doc.original_receipt_id
      ? (await admin.from('fdms_receipts').select('id, receipt_number, global_no').eq('id', doc.original_receipt_id).maybeSingle()).data
      : null

    const out = await issueDocument(admin, baseUrl, deviceId, currency, day, {
      docType: doc.doc_type ?? 'FiscalInvoice',
      receiptNumber: doc.receipt_number.replace(/^(CN|DN)-/, ''),
      clientName: doc.client_name,
      amount: Number(doc.amount) || 0,
      invoiceId: doc.invoice_id ?? undefined,
      receiptDate: new Date().toISOString(),
      original: original ? { id: original.id, receipt_number: original.receipt_number, global_no: original.global_no } : undefined,
      existingReceiptId: doc.id,
      existingCounter: doc.receipt_counter ?? undefined,
    })
    if (out.error) return res.status(502).json({ error: out.error })
    return res.status(200).json({ receipt: out.receipt, retried: true })
  }

  // ── creditNote / debitNote ───────────────────────────────────────
  if (action === 'creditNote' || action === 'debitNote') {
    const docType: DocType = action === 'creditNote' ? 'CreditNote' : 'DebitNote'
    const originalReceiptId = typeof body.originalReceiptId === 'string' ? body.originalReceiptId : ''
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (!originalReceiptId) return res.status(400).json({ error: 'Pass { originalReceiptId }.' })
    if (!reason) return res.status(400).json({ error: 'A note needs a reason — ZIMRA records it on the document.' })

    const { data: orig } = await admin.from('fdms_receipts').select('*').eq('id', originalReceiptId).maybeSingle()
    const original = orig as ReceiptRow | null
    if (!original || original.status !== 'fiscalised') {
      return res.status(400).json({ error: 'Notes can only be issued against a fiscalised document.' })
    }
    const amount = typeof body.amount === 'number' && body.amount > 0 ? body.amount : Number(original.amount) || 0

    const { day, error } = await ensureOpenDay(admin, baseUrl, deviceId, actorName)
    if (!day) return res.status(500).json({ error: error ?? 'Could not open a fiscal day.' })

    const out = await issueDocument(admin, baseUrl, deviceId, currency, day, {
      docType,
      receiptNumber: original.receipt_number.replace(/^(CN|DN)-/, ''),
      clientName: original.client_name,
      amount,
      invoiceId: original.invoice_id ?? undefined,
      receiptDate: new Date().toISOString(),
      reason,
      original: { id: original.id, receipt_number: original.receipt_number, global_no: original.global_no },
    })
    if (out.error) return res.status(502).json({ error: out.error })
    return res.status(200).json({ receipt: out.receipt })
  }

  // ── submit (default): fiscalise one paid invoice ─────────────────
  const invoiceId = typeof body.invoiceId === 'string' ? body.invoiceId : ''
  if (!invoiceId) return res.status(400).json({ error: 'Pass { invoiceId } (or an action: openDay, closeDay, creditNote, debitNote, retry).' })

  const { data: inv } = await admin
    .from('invoices')
    .select('id, invoice_number, amount, status, issued_at, paid_at, client_id, clients!client_id(name)')
    .eq('id', invoiceId)
    .maybeSingle()
  if (!inv) return res.status(404).json({ error: 'Invoice not found.' })
  if (inv.status !== 'paid') return res.status(400).json({ error: 'Only paid invoices are fiscalised — record payment first.' })

  // Already fiscalised? Return the existing receipt instead of double-
  // submitting — ZIMRA counts every accepted document against the day.
  const { data: existing } = await admin
    .from('fdms_receipts')
    .select('*')
    .eq('invoice_id', invoiceId)
    .eq('status', 'fiscalised')
    .maybeSingle()
  if (existing) return res.status(200).json({ receipt: existing, alreadyFiscalised: true })

  const { day, error: dayErr } = await ensureOpenDay(admin, baseUrl, deviceId, actorName)
  if (!day) return res.status(500).json({ error: dayErr ?? 'Could not open a fiscal day.' })

  const out = await issueDocument(admin, baseUrl, deviceId, currency, day, {
    docType: 'FiscalInvoice',
    receiptNumber: inv.invoice_number,
    clientName: (inv.clients as { name?: string } | null)?.name ?? '',
    amount: Number(inv.amount) || 0,
    invoiceId,
    receiptDate: (inv.paid_at ?? inv.issued_at ?? new Date().toISOString()),
  })
  if (out.error) return res.status(502).json({ error: out.error })
  return res.status(200).json({ receipt: out.receipt })
}
