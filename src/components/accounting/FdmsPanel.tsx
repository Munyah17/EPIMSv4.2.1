import { useState, useEffect, useCallback } from 'react'
import type { ToastMessage, FdmsReceipt, FdmsFiscalDay, FdmsDocType } from '../../types'
import { db } from '../../lib/db'
import { formatDateTime, formatDate } from '../../lib/dateUtils'
import { supabase } from '../../lib/supabase'
import { downloadFiscalDocument } from '../../lib/fiscalDoc'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
}

interface FdmsStatus {
  configured: boolean
  deviceId?: string
  baseUrl?: string
  environment?: 'test' | 'live'
  missingEnv?: string[]
  openDay?: FdmsFiscalDay | null
}

const DOC_PILL: Record<FdmsDocType, string> = {
  FiscalInvoice: 'pill-active',
  CreditNote: 'pill-warning',
  DebitNote: 'pill-caution',
}
const DOC_SHORT: Record<FdmsDocType, string> = {
  FiscalInvoice: 'Invoice',
  CreditNote: 'Credit Note',
  DebitNote: 'Debit Note',
}

/**
 * ZIMRA FDMS — Virtual Fiscalisation (Option B, direct API interface).
 * The submission surface is /api/fdms; this tab runs the whole lifecycle
 * ZIMRA's onboarding describes: fiscal-day open/close, all three document
 * types (Fiscal Tax Invoice, Credit Note, Debit Note) with their QR
 * imprint, failed-document retry, and the approval checklist status.
 * Invoices are still fiscalised from the Invoicing tab; everything a
 * sample/approval pack needs lives here.
 */
export default function FdmsPanel({ showToast }: Props) {
  const [receipts, setReceipts] = useState<FdmsReceipt[]>([])
  const [days, setDays] = useState<FdmsFiscalDay[]>([])
  const [status, setStatus] = useState<FdmsStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ mode: 'creditNote' | 'debitNote'; receipt: FdmsReceipt } | null>(null)
  const [noteReason, setNoteReason] = useState('')
  const [noteAmount, setNoteAmount] = useState('')
  const [docBusyId, setDocBusyId] = useState<string | null>(null)

  const apiPost = useCallback(async (body: Record<string, unknown>) => {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { showToast('error', 'Not signed in.'); return null }
    const res = await fetch('/api/fdms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
      body: JSON.stringify(body),
    })
    return res.json().catch(() => ({})) as Promise<Record<string, unknown> & { error?: string }>
  }, [showToast])

  const load = useCallback(() => {
    setLoading(true)
    Promise.all([
      db.fdmsReceipts.list(),
      db.fdmsFiscalDays.list(),
      supabase.auth.getSession().then(({ data: { session } }) =>
        session ? fetch('/api/fdms', { headers: { Authorization: `Bearer ${session.access_token}` } })
          .then(r => r.json()).catch(() => null) : null),
    ]).then(([rec, dy, st]) => {
      if (rec.error) showToast('error', rec.error)
      if (dy.error) showToast('error', dy.error)
      setReceipts(rec.data)
      setDays(dy.data)
      setStatus(st)
    }).finally(() => setLoading(false))
  }, [showToast])
  useEffect(load, [load])

  const openDay = days.find(d => d.status === 'open') ?? status?.openDay ?? null
  const fiscalised = receipts.filter(r => r.status === 'fiscalised')
  const failed = receipts.filter(r => r.status === 'failed')

  // ── Day lifecycle ──────────────────────────────────────────────────
  const openFiscalDay = async () => {
    setBusy('open')
    const out = await apiPost({ action: 'openDay' })
    setBusy(null)
    if (!out) return
    if (out.error) { showToast('error', out.error); return }
    showToast('success', `Fiscal day ${(out.day as { fiscal_day_no?: string } | undefined)?.fiscal_day_no ?? ''} opened.${out.upstreamWarning ? ` (ZIMRA upstream: ${out.upstreamWarning})` : ''}`)
    load()
  }

  const closeFiscalDay = async () => {
    if (!openDay) return
    if (!window.confirm(`Close fiscal day ${openDay.fiscalDayNo}? No further documents can be issued in it.`)) return
    setBusy('close')
    const out = await apiPost({ action: 'closeDay' })
    setBusy(null)
    if (!out) return
    if (out.error) { showToast('error', out.error); return }
    const errs = Number(out.errorDocs) || 0
    showToast(errs > 0 ? 'warning' : 'success',
      errs > 0
        ? `Day closed with ${errs} unresolved ${errs === 1 ? 'error' : 'errors'} — ZIMRA approval needs a clean close.`
        : `Fiscal day ${openDay.fiscalDayNo} closed clean.${out.upstreamWarning ? ` (upstream: ${out.upstreamWarning})` : ''}`)
    load()
  }

  // ── Documents ──────────────────────────────────────────────────────
  const retryDoc = async (r: FdmsReceipt) => {
    setDocBusyId(r.id)
    const out = await apiPost({ action: 'retry', receiptId: r.id })
    setDocBusyId(null)
    if (!out) return
    if (out.error) { showToast('error', out.error); return }
    showToast('success', `${r.receiptNumber} resubmitted and fiscalised.`)
    load()
  }

  const submitNote = async () => {
    if (!note) return
    if (!noteReason.trim()) { showToast('error', 'Enter the reason — ZIMRA records it on the note.'); return }
    setBusy('note')
    const out = await apiPost({
      action: note.mode,
      originalReceiptId: note.receipt.id,
      reason: noteReason.trim(),
      ...(noteAmount && Number(noteAmount) > 0 ? { amount: Number(noteAmount) } : {}),
    })
    setBusy(null)
    if (!out) return
    if (out.error) { showToast('error', out.error); return }
    showToast('success', `${note.mode === 'creditNote' ? 'Credit' : 'Debit'} note issued and fiscalised.`)
    setNote(null); setNoteReason(''); setNoteAmount('')
    load()
  }

  const downloadDoc = async (r: FdmsReceipt) => {
    setDocBusyId(r.id)
    try {
      const original = r.originalReceiptId ? receipts.find(x => x.id === r.originalReceiptId) : undefined
      await downloadFiscalDocument(r, original)
    } catch {
      showToast('error', 'Could not generate the fiscal document — run npm install if the QR library is missing.')
    } finally {
      setDocBusyId(null)
    }
  }

  // ── Onboarding checklist (ZIMRA Option B) ──────────────────────────
  const steps: { label: string; detail: string; done: boolean }[] = [
    { label: 'API documentation', detail: 'Download ZIMRA\'s Fiscalisation API document', done: true },
    { label: 'Test registration', detail: 'Email ZIMRA for test-environment access and your virtual device credentials', done: !!status?.configured },
    { label: 'Device configured', detail: 'FDMS_BASE_URL / FDMS_DEVICE_ID / FDMS_API_KEY set on the server', done: !!status?.configured },
    { label: 'Fiscal day opened', detail: 'A day must be open before any document issues', done: !!openDay || days.length > 0 },
    { label: 'Sample Fiscal Tax Invoice', detail: 'Fiscalise a paid invoice on the test environment', done: fiscalised.some(r => r.docType === 'FiscalInvoice') },
    { label: 'Sample Credit Note', detail: 'Issue a credit note against a fiscalised invoice', done: fiscalised.some(r => r.docType === 'CreditNote') },
    { label: 'Sample Debit Note', detail: 'Issue a debit note against a fiscalised invoice', done: fiscalised.some(r => r.docType === 'DebitNote') },
    { label: 'Clean fiscal-day close', detail: 'Close a day with zero errors — this is what ZIMRA inspects', done: days.some(d => d.status === 'closed') },
    { label: 'Submit samples to ZIMRA', detail: 'Send the QR-imprinted documents for approval → live registration', done: false },
  ]
  const doneCount = steps.filter(s => s.done).length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

      {/* ── Device link + fiscal day ── */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">FDMS Device Link</span>
          {status?.environment && (
            <span className={`pill ${status.environment === 'test' ? 'pill-warning' : 'pill-active'}`}>
              {status.environment === 'test' ? 'TEST environment' : 'LIVE'}
            </span>
          )}
        </div>
        {status === null ? (
          <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>Checking device configuration…</p>
        ) : !status.configured ? (
          <>
            <span className="pill pill-cancelled">Not configured</span>
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: '10px 0 0' }}>
              Set these on the server (Vercel project settings) once ZIMRA issues your test credentials, then redeploy:
            </p>
            <ul style={{ fontSize: 12, color: 'var(--muted)', margin: '8px 0 0', paddingLeft: 18 }}>
              <li><span className="mono">FDMS_BASE_URL</span> — FDMS endpoint ZIMRA gives you (test first, then live)</li>
              <li><span className="mono">FDMS_DEVICE_ID</span> — registered virtual device ID</li>
              <li><span className="mono">FDMS_API_KEY</span> — device certificate / API key</li>
              <li><span className="mono">FDMS_CURRENCY</span> — receipt currency, defaults to USD</li>
            </ul>
            {status.missingEnv && status.missingEnv.length > 0 && (
              <p style={{ fontSize: 11, color: 'var(--danger)', margin: '8px 0 0' }}>
                Missing: <span className="mono">{status.missingEnv.join(', ')}</span>
              </p>
            )}
          </>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span className="pill pill-active">Configured</span>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              Device <span className="mono">{status.deviceId}</span> → <span className="mono">{status.baseUrl}</span>
            </span>
          </div>
        )}
      </div>

      {/* ── Fiscal day ── */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">Fiscal Day</span>
          {openDay
            ? <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} onClick={closeFiscalDay} disabled={busy === 'close' || !status?.configured}>
                {busy === 'close' ? 'Closing…' : 'Close Fiscal Day'}
              </button>
            : <button className="btn btn-primary btn-sm" onClick={openFiscalDay} disabled={busy === 'open' || !status?.configured}>
                {busy === 'open' ? 'Opening…' : 'Open Fiscal Day'}
              </button>}
        </div>
        {openDay ? (
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            <span className="pill pill-active" style={{ marginRight: 8 }}>OPEN</span>
            <span className="mono">{openDay.fiscalDayNo}</span>
            {' '}· opened {formatDateTime(openDay.openedAt)} by {openDay.openedBy ?? '—'}
            {' '}· {openDay.docsCount} {openDay.docsCount === 1 ? 'document' : 'documents'} · counter at {openDay.receiptCounter}
            {openDay.upstreamError && (
              <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 6 }}>Upstream: {openDay.upstreamError}</div>
            )}
          </div>
        ) : (
          <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>
            No open fiscal day. Documents auto-open one when issued — opening explicitly first is what
            ZIMRA's test checklist expects, and what a clean close is measured against.
          </p>
        )}
        {days.filter(d => d.status !== 'open').length > 0 && (
          <div className="tbl-scroll" style={{ marginTop: 12 }}>
            <table className="table">
              <thead><tr><th>Day</th><th>Opened</th><th>Closed</th><th>Docs</th><th>Status</th></tr></thead>
              <tbody>
                {days.filter(d => d.status !== 'open').slice(0, 8).map(d => (
                  <tr key={d.id}>
                    <td><span className="mono">{d.fiscalDayNo}</span></td>
                    <td>{formatDate(d.openedAt)}</td>
                    <td>{d.closedAt ? formatDateTime(d.closedAt) : '—'}</td>
                    <td>{d.docsCount}</td>
                    <td>
                      <span className={`pill ${d.status === 'closed' ? 'pill-active' : 'pill-warning'}`}
                        title={d.upstreamError ?? undefined}>
                        {d.status === 'closed' ? 'closed clean' : 'closed with errors'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── ZIMRA onboarding checklist ── */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">ZIMRA Onboarding — Virtual Fiscalisation</span>
          <span className="pill pill-pending">{doneCount}/{steps.length}</span>
        </div>
        <p style={{ fontSize: 11, color: 'var(--muted)', margin: '0 0 10px' }}>
          The Option-B path (direct API interface): test in the FDMS test environment, produce a clean
          sample pack (invoice + credit note + debit note, clean day close), submit to ZIMRA, go live.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {steps.map((s, i) => (
            <div key={s.label} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 12 }}>
              <span style={{
                flexShrink: 0, width: 18, height: 18, borderRadius: '50%', display: 'inline-flex',
                alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700,
                background: s.done ? 'var(--success)' : 'var(--surface2, #E2E8F0)',
                color: s.done ? '#fff' : 'var(--muted)',
              }}>{s.done ? '✓' : i + 1}</span>
              <div>
                <div style={{ fontWeight: 500, color: s.done ? 'var(--muted)' : 'var(--text)', textDecoration: s.done ? 'line-through' : 'none' }}>
                  {s.label}
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>{s.detail}</div>
              </div>
            </div>
          ))}
        </div>
        <p style={{ fontSize: 11, color: 'var(--muted)', margin: '10px 0 0' }}>
          Docs: <a href="https://www.zimra.co.zw/downloads/category/9-domestic-taxes" target="_blank" rel="noreferrer">zimra.co.zw → Domestic Taxes downloads</a>
          {' '}· Verification portal: <a href="https://fdms.zimra.co.zw" target="_blank" rel="noreferrer" className="mono">fdms.zimra.co.zw</a>
        </p>
      </div>

      {/* ── Stats ── */}
      <div className="stats-grid">
        <div className="stat-card"><div className="stat-value">{fiscalised.length}</div><div className="stat-label">Fiscalised Documents</div></div>
        <div className="stat-card"><div className="stat-value" style={{ color: failed.length ? 'var(--danger)' : undefined }}>{failed.length}</div><div className="stat-label">Failed Submissions</div></div>
        <div className="stat-card"><div className="stat-value">${fiscalised.reduce((s, r) => s + r.amount, 0).toFixed(2)}</div><div className="stat-label">Fiscalised Value</div></div>
        <div className="stat-card"><div className="stat-value">{fiscalised.filter(r => r.docType === 'CreditNote').length + fiscalised.filter(r => r.docType === 'DebitNote').length}</div><div className="stat-label">Notes Issued</div></div>
      </div>

      {/* ── Documents ── */}
      <div className="card">
        <div className="card-header"><span className="card-title">Fiscal Documents</span></div>
        <p style={{ fontSize: 11, color: 'var(--muted)', margin: '0 0 12px' }}>
          Every document FDMS has signed or rejected. <strong>Fiscal Doc</strong> downloads the QR-imprinted
          document — that's the sample ZIMRA approves. Credit/debit notes adjust a fiscalised invoice;
          a failed document can be retried while its day is still open.
        </p>
        {loading ? (
          <div className="empty-state">Loading FDMS receipts…</div>
        ) : receipts.length === 0 ? (
          <div className="empty-state">No documents submitted to FDMS yet — fiscalise a paid invoice from the Invoicing tab.</div>
        ) : (
          <div className="tbl-scroll">
          <table className="table">
            <thead>
              <tr><th>Submitted</th><th>Type</th><th>Receipt</th><th>#</th><th>Customer</th><th>Amount</th><th>VAT</th><th>Status</th><th>Global No</th><th>Verification</th><th>Day</th><th>Error / Reason</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {receipts.map(r => (
                <tr key={r.id}>
                  <td>{formatDateTime(r.createdAt)}</td>
                  <td><span className={`pill ${DOC_PILL[r.docType] ?? 'pill-gray'}`}>{DOC_SHORT[r.docType] ?? r.docType}</span></td>
                  <td><span className="mono">{r.receiptNumber}</span></td>
                  <td>{r.receiptCounter ?? '—'}</td>
                  <td>{r.clientName}</td>
                  <td>${r.amount.toFixed(2)}</td>
                  <td>{r.vatAmount != null ? `$${r.vatAmount.toFixed(2)}` : '—'}</td>
                  <td><span className={`pill ${r.status === 'fiscalised' ? 'pill-active' : r.status === 'failed' ? 'pill-cancelled' : 'pill-pending'}`}>{r.status}</span></td>
                  <td>{r.globalNo != null ? <span className="mono">{r.globalNo}</span> : '—'}</td>
                  <td>{r.verificationCode ? <span className="mono">{r.verificationCode}</span> : '—'}</td>
                  <td>{r.fiscalDay ?? '—'}</td>
                  <td style={{ fontSize: 11, color: r.error ? 'var(--danger)' : 'var(--muted)', maxWidth: 200 }}>{r.error ?? r.reason ?? ''}</td>
                  <td>
                    <div className="action-btns">
                      <button className="btn btn-ghost btn-sm" disabled={docBusyId === r.id} onClick={() => void downloadDoc(r)}>
                        Fiscal Doc
                      </button>
                      {r.status === 'failed' && (
                        <button className="btn btn-ghost btn-sm" style={{ color: 'var(--accent)' }} disabled={docBusyId === r.id} onClick={() => void retryDoc(r)}>
                          Retry
                        </button>
                      )}
                      {r.status === 'fiscalised' && r.docType === 'FiscalInvoice' && (
                        <>
                          <button className="btn btn-ghost btn-sm" style={{ color: 'var(--warning)' }}
                            onClick={() => { setNote({ mode: 'creditNote', receipt: r }); setNoteAmount(String(r.amount)); setNoteReason('') }}>
                            Credit Note
                          </button>
                          <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }}
                            onClick={() => { setNote({ mode: 'debitNote', receipt: r }); setNoteAmount(String(r.amount)); setNoteReason('') }}>
                            Debit Note
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {/* ── Credit / debit note modal ── */}
      {note && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 440 }}>
            <div className="modal-header">
              <h3>{note.mode === 'creditNote' ? 'Credit Note' : 'Debit Note'} — {note.receipt.receiptNumber}</h3>
              <button className="modal-close" onClick={() => setNote(null)}>✕</button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 12px' }}>
                {note.mode === 'creditNote'
                  ? 'Reduces the fiscalised sale — refund, overcharge correction, cancelled cover.'
                  : 'Increases the fiscalised sale — surcharge or undercharge correction.'}
                {' '}Issued against {note.receipt.receiptNumber} (${note.receipt.amount.toFixed(2)}, global no {note.receipt.globalNo ?? '—'}).
              </p>
              <div className="form-group">
                <label>Reason *</label>
                <input className="form-control" value={noteReason} onChange={e => setNoteReason(e.target.value)}
                  placeholder={note.mode === 'creditNote' ? 'e.g. Client refunded — policy cancelled' : 'e.g. Additional members added'} />
              </div>
              <div className="form-group">
                <label>Amount ($) — defaults to the full document</label>
                <input type="number" min="0" step="0.01" className="form-control" value={noteAmount} onChange={e => setNoteAmount(e.target.value)} />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setNote(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={() => void submitNote()} disabled={busy === 'note'}>
                {busy === 'note' ? 'Issuing…' : `Issue ${note.mode === 'creditNote' ? 'Credit' : 'Debit'} Note`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
