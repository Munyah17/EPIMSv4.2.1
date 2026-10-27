import { useState, useEffect } from 'react'
import type { ToastMessage, FdmsReceipt } from '../../types'
import { db } from '../../lib/db'
import { formatDateTime } from '../../lib/dateUtils'
import { supabase } from '../../lib/supabase'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
}

interface FdmsStatus {
  configured: boolean
  deviceId?: string
  baseUrl?: string
  missingEnv?: string[]
}

/** ZIMRA Fiscalisation Device Management System. The actual submission
 *  happens server-side (/api/fdms) where the device credentials live in
 *  env vars — this tab shows whether the link is configured and lists
 *  every document ZIMRA has signed (or rejected). Fiscalise from the
 *  Invoicing tab on a paid invoice. */
export default function FdmsPanel({ showToast }: Props) {
  const [receipts, setReceipts] = useState<FdmsReceipt[]>([])
  const [status, setStatus] = useState<FdmsStatus | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      db.fdmsReceipts.list(),
      supabase.auth.getSession().then(({ data: { session } }) =>
        session ? fetch('/api/fdms', { headers: { Authorization: `Bearer ${session.access_token}` } })
          .then(r => r.json()).catch(() => null) : null),
    ]).then(([rec, st]) => {
      if (rec.error) showToast('error', rec.error)
      setReceipts(rec.data)
      setStatus(st)
    }).finally(() => setLoading(false))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const fiscalised = receipts.filter(r => r.status === 'fiscalised')
  const failed = receipts.filter(r => r.status === 'failed')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="card">
        <div className="card-header"><span className="card-title">FDMS Device Link</span></div>
        {status === null ? (
          <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>Checking device configuration…</p>
        ) : status.configured ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="pill pill-active">Configured</span>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              Device <span className="mono">{status.deviceId}</span> → <span className="mono">{status.baseUrl}</span>
            </span>
          </div>
        ) : (
          <>
            <span className="pill pill-cancelled">Not configured</span>
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: '10px 0 0' }}>
              Fiscalisation needs the FDMS credentials on the server — set these environment variables
              where the API runs (Vercel project settings), then redeploy:
            </p>
            <ul style={{ fontSize: 12, color: 'var(--muted)', margin: '8px 0 0', paddingLeft: 18 }}>
              <li><span className="mono">FDMS_BASE_URL</span> — ZIMRA FDMS endpoint (e.g. https://fdms.zimra.co.zw)</li>
              <li><span className="mono">FDMS_DEVICE_ID</span> — registered fiscal device ID</li>
              <li><span className="mono">FDMS_API_KEY</span> — device certificate / API key</li>
              <li><span className="mono">FDMS_CURRENCY</span> — receipt currency, defaults to USD</li>
            </ul>
            {status.missingEnv && status.missingEnv.length > 0 && (
              <p style={{ fontSize: 11, color: 'var(--danger)', margin: '8px 0 0' }}>
                Missing: <span className="mono">{status.missingEnv.join(', ')}</span>
              </p>
            )}
          </>
        )}
      </div>

      <div className="stats-grid">
        <div className="stat-card"><div className="stat-value">{fiscalised.length}</div><div className="stat-label">Fiscalised Documents</div></div>
        <div className="stat-card"><div className="stat-value" style={{ color: failed.length ? 'var(--danger)' : undefined }}>{failed.length}</div><div className="stat-label">Failed Submissions</div></div>
        <div className="stat-card"><div className="stat-value">${fiscalised.reduce((s, r) => s + r.amount, 0).toFixed(2)}</div><div className="stat-label">Fiscalised Value</div></div>
      </div>

      <div className="card">
        <div className="card-header"><span className="card-title">Fiscalised Documents</span></div>
        <p style={{ fontSize: 11, color: 'var(--muted)', margin: '0 0 12px' }}>
          Paid invoices are submitted to ZIMRA from the Invoicing tab (Fiscalise action). Each accepted
          receipt carries ZIMRA's global number and verification code — what a fiscal audit checks.
        </p>
        {loading ? (
          <div className="empty-state">Loading FDMS receipts…</div>
        ) : receipts.length === 0 ? (
          <div className="empty-state">No documents submitted to FDMS yet.</div>
        ) : (
          <div className="tbl-scroll">
          <table className="table">
            <thead>
              <tr><th>Submitted</th><th>Receipt</th><th>Customer</th><th>Amount</th><th>VAT</th><th>Status</th><th>Global No</th><th>Verification</th><th>Fiscal Day</th><th>Error</th></tr>
            </thead>
            <tbody>
              {receipts.map(r => (
                <tr key={r.id}>
                  <td>{formatDateTime(r.createdAt)}</td>
                  <td><span className="mono">{r.receiptNumber}</span></td>
                  <td>{r.clientName}</td>
                  <td>${r.amount.toFixed(2)}</td>
                  <td>{r.vatAmount != null ? `$${r.vatAmount.toFixed(2)}` : '—'}</td>
                  <td><span className={`pill ${r.status === 'fiscalised' ? 'pill-active' : r.status === 'failed' ? 'pill-cancelled' : 'pill-pending'}`}>{r.status}</span></td>
                  <td>{r.globalNo != null ? <span className="mono">{r.globalNo}</span> : '—'}</td>
                  <td>{r.verificationCode ? <span className="mono">{r.verificationCode}</span> : '—'}</td>
                  <td>{r.fiscalDay ?? '—'}</td>
                  <td style={{ fontSize: 11, color: 'var(--danger)', maxWidth: 200 }}>{r.error ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  )
}
