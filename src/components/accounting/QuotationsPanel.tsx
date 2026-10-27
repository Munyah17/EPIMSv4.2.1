import { useState, useEffect } from 'react'
import type { ToastMessage, Quotation, QuotationStatus, Client, Product } from '../../types'
import { db } from '../../lib/db'
import { formatDate } from '../../lib/dateUtils'
import { useAuth } from '../../contexts/AuthContext'
import ValidationSummary, { MissingField, invalidClass, fieldId } from '../ui/ValidationSummary'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
}

const PILL: Record<QuotationStatus, string> = {
  draft: 'pill-pending',
  sent: 'pill-pending',
  accepted: 'pill-active',
  declined: 'pill-cancelled',
  expired: 'pill-cancelled',
}

/** Quotes a price before any cover exists. A quotation can reference an
 *  existing client (dropdown) or a pure prospect (typed name) — the quote
 *  number, status trail and product/premium snapshot are what matter. */
export default function QuotationsPanel({ showToast }: Props) {
  const { user } = useAuth()
  const [items, setItems] = useState<Quotation[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = () => {
    setLoading(true)
    db.quotations.list().then(({ data, error }) => {
      if (error) showToast('error', error)
      setItems(data)
    }).finally(() => setLoading(false))
  }
  useEffect(load, []) // eslint-disable-line react-hooks/exhaustive-deps

  const setStatus = async (q: Quotation, status: QuotationStatus) => {
    const { data, error } = await db.quotations.setStatus(q.id, status)
    if (error || !data) { showToast('error', error ?? 'Failed to update the quotation.'); return }
    setItems(prev => prev.map(x => x.id === data.id ? data : x))
    showToast('success', `${q.quotationNumber} → ${status}.`)
  }

  const remove = async (q: Quotation) => {
    if (!window.confirm(`Delete quotation ${q.quotationNumber}?`)) return
    const { error } = await db.quotations.remove(q.id)
    if (error) { showToast('error', error); return }
    setItems(prev => prev.filter(x => x.id !== q.id))
    showToast('success', `${q.quotationNumber} deleted.`)
  }

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">Quotations</span>
        <button className="btn btn-primary btn-sm" onClick={() => setShowForm(true)}>＋ New Quotation</button>
      </div>
      <p style={{ fontSize: 11, color: 'var(--muted)', margin: '0 0 12px' }}>
        Price a product for a prospect or existing client before cover exists. Send it, then mark
        whether the customer accepted — an accepted quotation is the hand-off point for issuing a policy.
      </p>
      {loading ? (
        <div className="empty-state">Loading quotations…</div>
      ) : items.length === 0 ? (
        <div className="empty-state">No quotations yet.</div>
      ) : (
        <div className="tbl-scroll">
        <table className="table">
          <thead>
            <tr><th>Quote</th><th>Customer</th><th>Product</th><th>Premium</th><th>Cover</th><th>Valid Until</th><th>Status</th><th>By</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {items.map(q => (
              <tr key={q.id}>
                <td><span className="mono">{q.quotationNumber}</span></td>
                <td>{q.clientName}</td>
                <td>{q.productName || '—'}</td>
                <td>${q.premium.toFixed(2)}</td>
                <td>{q.coverAmount != null ? `$${q.coverAmount.toFixed(2)}` : '—'}</td>
                <td>{formatDate(q.validUntil)}</td>
                <td><span className={`pill ${PILL[q.status]}`}>{q.status}</span></td>
                <td>{q.createdByName ?? '—'}</td>
                <td>
                  <div className="action-btns">
                    {q.status === 'draft' && (
                      <button className="btn btn-ghost btn-sm" style={{ color: 'var(--accent)' }} onClick={() => setStatus(q, 'sent')}>Send</button>
                    )}
                    {(q.status === 'draft' || q.status === 'sent') && (
                      <>
                        <button className="btn btn-ghost btn-sm" style={{ color: 'var(--success)' }} onClick={() => setStatus(q, 'accepted')}>Accept</button>
                        <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} onClick={() => setStatus(q, 'declined')}>Decline</button>
                      </>
                    )}
                    {q.status === 'draft' && (
                      <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} onClick={() => remove(q)}>Delete</button>
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
        <NewQuotationModal
          createdBy={user?.id}
          createdByName={user?.name}
          saving={saving}
          onClose={() => setShowForm(false)}
          onSave={async (input) => {
            setSaving(true)
            const { data, error } = await db.quotations.create(input)
            setSaving(false)
            if (error || !data) { showToast('error', error ?? 'Failed to save the quotation.'); return }
            setItems(prev => [data, ...prev])
            setShowForm(false)
            showToast('success', `Quotation ${data.quotationNumber} created.`)
          }}
        />
      )}
    </div>
  )
}

function NewQuotationModal({ onClose, onSave, saving, createdBy, createdByName }: {
  onClose: () => void
  onSave: (q: Omit<Quotation, 'id' | 'quotationNumber' | 'status' | 'createdAt' | 'updatedAt'>) => void
  saving: boolean
  createdBy?: string
  createdByName?: string
}) {
  const [clients, setClients] = useState<Client[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [clientId, setClientId] = useState('')
  const [prospectName, setProspectName] = useState('')
  const [productId, setProductId] = useState('')
  const [premium, setPremium] = useState('')
  const [coverAmount, setCoverAmount] = useState('')
  const [validUntil, setValidUntil] = useState('')
  const [notes, setNotes] = useState('')
  const [attempted, setAttempted] = useState(false)

  useEffect(() => {
    db.clients.list().then(({ data }) => setClients(data ?? []))
    db.products.list().then(({ data }) => setProducts((data ?? []).filter(p => p.active)))
  }, [])

  const client = clients.find(c => c.id === clientId)
  const product = products.find(p => p.id === productId)

  const pickProduct = (id: string) => {
    setProductId(id)
    const p = products.find(x => x.id === id)
    if (p) { setPremium(String(p.premium)); setCoverAmount(String(p.coverAmount)) }
  }

  const missing: MissingField[] = []
  if (!clientId && !prospectName.trim()) missing.push({ key: 'customer', label: 'Customer', hint: 'Pick a client or type a prospect name' })
  if (!productId) missing.push({ key: 'product', label: 'Product' })
  if (!premium || Number(premium) <= 0) missing.push({ key: 'premium', label: 'Premium' })

  const handleSave = () => {
    setAttempted(true)
    if (missing.length > 0) return
    onSave({
      clientId: clientId || undefined,
      clientName: client?.name ?? prospectName.trim(),
      productId: product?.id,
      productName: product?.name ?? '',
      premium: Number(premium),
      coverAmount: coverAmount ? Number(coverAmount) : undefined,
      validUntil: validUntil || undefined,
      notes: notes.trim() || undefined,
      createdBy,
      createdByName,
    })
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 520 }}>
        <div className="modal-header">
          <h3>New Quotation</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <ValidationSummary missing={missing} attempted={attempted} />
          <div className="form-group" id={fieldId('customer')}>
            <label>Existing client</label>
            <select className={invalidClass(missing, attempted, 'customer')} value={clientId} onChange={e => { setClientId(e.target.value); if (e.target.value) setProspectName('') }}>
              <option value="">— or type a prospect name below —</option>
              {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          {!clientId && (
            <div className="form-group">
              <label>Prospect name</label>
              <input className={invalidClass(missing, attempted, 'customer')} value={prospectName} onChange={e => setProspectName(e.target.value)} placeholder="Customer not yet a client…" />
            </div>
          )}
          <div className="form-group" id={fieldId('product')}>
            <label>Product *</label>
            <select className={invalidClass(missing, attempted, 'product')} value={productId} onChange={e => pickProduct(e.target.value)}>
              <option value="">Select product…</option>
              {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="form-row">
            <div className="form-group" id={fieldId('premium')}>
              <label>Premium ($) *</label>
              <input type="number" min="0" step="0.01" className={invalidClass(missing, attempted, 'premium')} value={premium} onChange={e => setPremium(e.target.value)} />
            </div>
            <div className="form-group">
              <label>Cover amount ($)</label>
              <input type="number" min="0" step="0.01" className="form-control" value={coverAmount} onChange={e => setCoverAmount(e.target.value)} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Valid until</label>
              <input type="date" className="form-control" value={validUntil} onChange={e => setValidUntil(e.target.value)} />
            </div>
            <div className="form-group">
              <label>Notes</label>
              <input className="form-control" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional…" />
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save Quotation'}
          </button>
        </div>
      </div>
    </div>
  )
}
