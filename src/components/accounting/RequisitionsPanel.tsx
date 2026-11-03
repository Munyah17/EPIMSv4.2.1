import { useState, useEffect } from 'react'
import type { ToastMessage, Requisition, RequisitionStatus } from '../../types'
import { db } from '../../lib/db'
import { formatDate, formatDateTime } from '../../lib/dateUtils'
import { useAuth } from '../../contexts/AuthContext'
import { uploadDocument, getDocumentUrl, documentDisplayName } from '../../lib/storage'
import { exportRequisitionPdf } from '../../lib/billingDocsPdf'
import { notifyPhone } from '../../lib/notify'
import { supabase } from '../../lib/supabase'
import ValidationSummary, { MissingField, invalidClass, fieldId } from '../ui/ValidationSummary'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
}

const PILL: Record<RequisitionStatus, string> = {
  pending: 'pill-pending',
  approved: 'pill-active',
  paid: 'pill-active',
  rejected: 'pill-cancelled',
}

const CATEGORIES = ['General', 'Office Supplies', 'Travel', 'Claims Settlement', 'Marketing', 'IT & Equipment', 'Utilities', 'Other']

/** Money going out, with sign-off first. Any staff member can raise a
 *  requisition; only admin/finance roles approve or reject it, and an
 *  approved requisition is then marked paid when the money moves. */
export default function RequisitionsPanel({ showToast }: Props) {
  const { user } = useAuth()
  // Only Super Admin decides — enforced again by the
  // guard_requisition_decision DB trigger, this gate is just the UI.
  const canDecide = user?.role === 'super_admin'
  const [items, setItems] = useState<Requisition[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = () => {
    setLoading(true)
    db.requisitions.list().then(({ data, error }) => {
      if (error) showToast('error', error)
      setItems(data)
    }).finally(() => setLoading(false))
  }
  useEffect(load, []) // eslint-disable-line react-hooks/exhaustive-deps

  const pendingTotal = items.filter(r => r.status === 'pending').reduce((s, r) => s + r.amount, 0)
  const approvedUnpaid = items.filter(r => r.status === 'approved').reduce((s, r) => s + r.amount, 0)
  const paidTotal = items.filter(r => r.status === 'paid').reduce((s, r) => s + r.amount, 0)

  /** The staff member who raised the requisition hears the outcome by
   *  SMS — approved, rejected or paid — without watching the table. */
  const notifyRequester = async (r: Requisition, outcome: string) => {
    if (!r.requestedBy) return
    const { data: profile } = await supabase.from('profiles').select('phone').eq('id', r.requestedBy).maybeSingle()
    if (profile?.phone) {
      notifyPhone(profile.phone, `Requisition ${r.requisitionNumber} (${r.payee}, $${r.amount.toFixed(2)}) ${outcome}.`, 'general', r.requisitionNumber)
    }
  }

  const decide = async (r: Requisition, status: 'approved' | 'rejected') => {
    if (status === 'rejected' && !window.confirm(`Reject ${r.requisitionNumber} (${r.payee}, $${r.amount.toFixed(2)})?`)) return
    const { data, error } = await db.requisitions.decide(r.id, status, user?.id, user?.name)
    if (error || !data) { showToast('error', error ?? 'Failed to update the requisition.'); return }
    setItems(prev => prev.map(x => x.id === data.id ? data : x))
    showToast('success', `${r.requisitionNumber} ${status}.`)
    void notifyRequester(r, status === 'approved' ? 'was approved' : 'was rejected')
  }

  const markPaid = async (r: Requisition) => {
    const { data, error } = await db.requisitions.markPaid(r.id)
    if (error || !data) { showToast('error', error ?? 'Failed to mark paid.'); return }
    setItems(prev => prev.map(x => x.id === data.id ? data : x))
    showToast('success', `${r.requisitionNumber} marked paid.`)
    void notifyRequester(r, 'was paid')
  }

  const exportPdf = async (r: Requisition) => {
    try { await exportRequisitionPdf(r) } catch { showToast('error', 'Could not generate the PDF.') }
  }

  const openAttachment = async (path: string) => {
    const url = await getDocumentUrl(path)
    if (url) window.open(url, '_blank')
    else showToast('error', 'Could not open the attachment.')
  }

  /** Add a file to an already-submitted requisition (still pending —
   *  decided rows are read-only evidence). */
  const attachTo = async (r: Requisition, files: FileList | null) => {
    if (!files?.length) return
    const paths = [...(r.attachments ?? [])]
    for (const f of Array.from(files)) {
      const { data, error } = await uploadDocument('requisitions', r.id, f)
      if (error || !data) { showToast('error', error ?? `Could not upload ${f.name}.`); return }
      paths.push(data.path)
    }
    const { data, error } = await db.requisitions.setAttachments(r.id, paths)
    if (error || !data) { showToast('error', error ?? 'Failed to save attachments.'); return }
    setItems(prev => prev.map(x => x.id === data.id ? data : x))
    showToast('success', `${files.length} file${files.length === 1 ? '' : 's'} attached.`)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="stats-grid">
        <div className="stat-card"><div className="stat-value">${pendingTotal.toFixed(2)}</div><div className="stat-label">Awaiting Approval</div></div>
        <div className="stat-card"><div className="stat-value">${approvedUnpaid.toFixed(2)}</div><div className="stat-label">Approved, Unpaid</div></div>
        <div className="stat-card"><div className="stat-value">${paidTotal.toFixed(2)}</div><div className="stat-label">Paid Out</div></div>
      </div>
      <div className="card">
        <div className="card-header">
          <span className="card-title">Requisitions</span>
          <button className="btn btn-primary btn-sm" onClick={() => setShowForm(true)}>＋ New Requisition</button>
        </div>
        {loading ? (
          <div className="empty-state">Loading requisitions…</div>
        ) : items.length === 0 ? (
          <div className="empty-state">No requisitions raised yet.</div>
        ) : (
          <div className="tbl-scroll">
          <table className="table">
            <thead>
              <tr><th>Req #</th><th>Payee</th><th>Purpose</th><th>Category</th><th>Amount</th><th>Requested By</th><th>Status</th><th>Decided / Paid</th><th>Docs</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {items.map(r => (
                <tr key={r.id}>
                  <td><span className="mono">{r.requisitionNumber}</span></td>
                  <td>{r.payee}</td>
                  <td title={r.purpose}>{r.purpose.length > 40 ? `${r.purpose.slice(0, 40)}…` : r.purpose}</td>
                  <td>{r.category}</td>
                  <td>${r.amount.toFixed(2)}</td>
                  <td>{r.requestedByName ?? '—'}</td>
                  <td><span className={`pill ${PILL[r.status]}`}>{r.status}</span></td>
                  <td style={{ fontSize: 11 }}>
                    {r.status === 'approved' || r.status === 'rejected' || r.status === 'paid'
                      ? <>{r.approvedByName ?? '—'}<br />{formatDateTime(r.approvedAt)}</>
                      : '—'}
                    {r.status === 'paid' && r.paidAt && <><br />Paid {formatDate(r.paidAt)}</>}
                  </td>
                  <td style={{ fontSize: 11 }}>
                    {(r.attachments ?? []).map((p, i) => (
                      <button key={p} className="btn btn-ghost btn-sm" style={{ padding: '1px 4px' }}
                        onClick={() => void openAttachment(p)} title={documentDisplayName(p)}>
                        {i + 1}. {documentDisplayName(p).length > 18 ? `${documentDisplayName(p).slice(0, 18)}…` : documentDisplayName(p)}
                      </button>
                    ))}
                    {r.status === 'pending' && (
                      <label className="btn btn-ghost btn-sm" style={{ padding: '1px 4px', cursor: 'pointer' }}>
                        ＋ Attach
                        <input type="file" multiple hidden onChange={e => { void attachTo(r, e.target.files); e.target.value = '' }} />
                      </label>
                    )}
                  </td>
                  <td>
                    <div className="action-btns">
                      <button className="btn btn-ghost btn-sm" onClick={() => void exportPdf(r)}>PDF</button>
                      {r.status === 'pending' && canDecide && (
                        <>
                          <button className="btn btn-ghost btn-sm" style={{ color: 'var(--success)' }} onClick={() => decide(r, 'approved')}>Approve</button>
                          <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} onClick={() => decide(r, 'rejected')}>Reject</button>
                        </>
                      )}
                      {r.status === 'approved' && canDecide && (
                        <button className="btn btn-ghost btn-sm" style={{ color: 'var(--success)' }} onClick={() => markPaid(r)}>Mark Paid</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
        {showForm && (
          <NewRequisitionModal
            saving={saving}
            onClose={() => setShowForm(false)}
            onSave={async (input, files) => {
              setSaving(true)
              const { data, error } = await db.requisitions.create({ ...input, requestedBy: user?.id, requestedByName: user?.name })
              if (error || !data) { setSaving(false); showToast('error', error ?? 'Failed to submit the requisition.'); return }
              let created = data
              if (files.length) {
                const paths: string[] = []
                for (const f of files) {
                  const up = await uploadDocument('requisitions', data.id, f)
                  if (up.error || !up.data) { showToast('error', up.error ?? `Could not upload ${f.name}.`) }
                  else paths.push(up.data.path)
                }
                if (paths.length) {
                  const upd = await db.requisitions.setAttachments(data.id, paths)
                  if (upd.data) created = upd.data
                }
              }
              setSaving(false)
              setItems(prev => [created, ...prev])
              setShowForm(false)
              showToast('success', `Requisition ${created.requisitionNumber} submitted — Super Admin will decide.`)
            }}
          />
        )}
      </div>
    </div>
  )
}

function NewRequisitionModal({ onClose, onSave, saving }: {
  onClose: () => void
  onSave: (r: { payee: string; purpose: string; category: string; amount: number; notes?: string }, files: File[]) => void
  saving: boolean
}) {
  const [payee, setPayee] = useState('')
  const [purpose, setPurpose] = useState('')
  const [category, setCategory] = useState('General')
  const [amount, setAmount] = useState('')
  const [notes, setNotes] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [attempted, setAttempted] = useState(false)

  const missing: MissingField[] = []
  if (!payee.trim()) missing.push({ key: 'payee', label: 'Payee' })
  if (!purpose.trim()) missing.push({ key: 'purpose', label: 'Purpose' })
  if (!amount || Number(amount) <= 0) missing.push({ key: 'amount', label: 'Amount' })

  const handleSave = () => {
    setAttempted(true)
    if (missing.length > 0) return
    onSave({ payee: payee.trim(), purpose: purpose.trim(), category, amount: Number(amount), notes: notes.trim() || undefined }, files)
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 520 }}>
        <div className="modal-header">
          <h3>New Requisition</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <ValidationSummary missing={missing} attempted={attempted} />
          <div className="form-group" id={fieldId('payee')}>
            <label>Payee *</label>
            <input className={invalidClass(missing, attempted, 'payee')} value={payee} onChange={e => setPayee(e.target.value)} placeholder="Who is being paid" />
          </div>
          <div className="form-group" id={fieldId('purpose')}>
            <label>Purpose *</label>
            <textarea className={invalidClass(missing, attempted, 'purpose')} rows={3} value={purpose} onChange={e => setPurpose(e.target.value)} placeholder="What the money is for…" />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Category</label>
              <select className="form-control" value={category} onChange={e => setCategory(e.target.value)}>
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="form-group" id={fieldId('amount')}>
              <label>Amount ($) *</label>
              <input type="number" min="0" step="0.01" className={invalidClass(missing, attempted, 'amount')} value={amount} onChange={e => setAmount(e.target.value)} />
            </div>
          </div>
          <div className="form-group">
            <label>Notes</label>
            <input className="form-control" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional — PO number, reference…" />
          </div>
          <div className="form-group">
            <label>Supporting documents — invoice, PoP, receipt (any file type)</label>
            <input type="file" multiple className="form-control" onChange={e => setFiles(Array.from(e.target.files ?? []))} />
            {files.length > 0 && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{files.map(f => f.name).join(', ')}</div>}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Submitting…' : 'Submit for Approval'}
          </button>
        </div>
      </div>
    </div>
  )
}
