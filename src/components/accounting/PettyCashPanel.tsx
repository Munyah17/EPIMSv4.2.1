import { useState, useEffect } from 'react'
import type { ToastMessage, PettyCashEntry, PettyCashEntryType } from '../../types'
import { db } from '../../lib/db'
import { formatDateTime } from '../../lib/dateUtils'
import { useAuth } from '../../contexts/AuthContext'
import ValidationSummary, { MissingField, invalidClass, fieldId } from '../ui/ValidationSummary'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
}

const CATEGORIES = ['General', 'Office Supplies', 'Refreshments', 'Transport', 'Postage & Courier', 'Repairs', 'Cleaning', 'Other']

/** The office imprest. Replenish tops the box up, expense draws it down —
 *  the balance is a sum of the ledger, never an editable figure. */
export default function PettyCashPanel({ showToast }: Props) {
  const { user } = useAuth()
  const [entries, setEntries] = useState<PettyCashEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [formType, setFormType] = useState<PettyCashEntryType>('expense')
  const [saving, setSaving] = useState(false)

  const load = () => {
    setLoading(true)
    db.pettyCashEntries.list().then(({ data, error }) => {
      if (error) showToast('error', error)
      setEntries(data)
    }).finally(() => setLoading(false))
  }
  useEffect(load, []) // eslint-disable-line react-hooks/exhaustive-deps

  const replenished = entries.filter(e => e.type === 'replenish').reduce((s, e) => s + e.amount, 0)
  const spent = entries.filter(e => e.type === 'expense').reduce((s, e) => s + e.amount, 0)
  const balance = replenished - spent

  const openForm = (type: PettyCashEntryType) => { setFormType(type); setShowForm(true) }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="stats-grid">
        <div className="stat-card"><div className="stat-value" style={{ color: balance < 0 ? 'var(--danger)' : undefined }}>${balance.toFixed(2)}</div><div className="stat-label">Cash in Box</div></div>
        <div className="stat-card"><div className="stat-value">${replenished.toFixed(2)}</div><div className="stat-label">Total Replenished</div></div>
        <div className="stat-card"><div className="stat-value">${spent.toFixed(2)}</div><div className="stat-label">Total Spent</div></div>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">Petty Cash Ledger</span>
          <div className="action-btns">
            <button className="btn btn-primary btn-sm" onClick={() => openForm('expense')}>＋ Record Expense</button>
            <button className="btn btn-ghost btn-sm" onClick={() => openForm('replenish')}>Replenish</button>
          </div>
        </div>
        {loading ? (
          <div className="empty-state">Loading petty cash…</div>
        ) : entries.length === 0 ? (
          <div className="empty-state">No entries yet — replenish the box to get started.</div>
        ) : (
          <div className="tbl-scroll">
          <table className="table">
            <thead><tr><th>Date</th><th>Type</th><th>Category</th><th>Payee</th><th>Description</th><th>Receipt</th><th>Amount</th><th>By</th></tr></thead>
            <tbody>
              {entries.map(e => (
                <tr key={e.id}>
                  <td>{formatDateTime(e.createdAt)}</td>
                  <td><span className={`pill ${e.type === 'replenish' ? 'pill-active' : 'pill-cancelled'}`}>{e.type === 'replenish' ? 'In' : 'Out'}</span></td>
                  <td>{e.category}</td>
                  <td>{e.payee ?? '—'}</td>
                  <td>{e.description}</td>
                  <td>{e.receiptRef ? <span className="mono">{e.receiptRef}</span> : '—'}</td>
                  <td style={{ color: e.type === 'expense' ? 'var(--danger)' : 'var(--success)' }}>
                    {e.type === 'expense' ? '−' : '+'}${e.amount.toFixed(2)}
                  </td>
                  <td>{e.recordedByName ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {showForm && (
        <PettyCashModal
          type={formType}
          balance={balance}
          saving={saving}
          onClose={() => setShowForm(false)}
          onSave={async (input) => {
            setSaving(true)
            const { data, error } = await db.pettyCashEntries.create({ ...input, recordedBy: user?.id, recordedByName: user?.name })
            setSaving(false)
            if (error || !data) { showToast('error', error ?? 'Failed to record the entry.'); return }
            setEntries(prev => [data, ...prev])
            setShowForm(false)
            showToast('success', `${data.type === 'expense' ? 'Expense' : 'Replenishment'} of $${data.amount.toFixed(2)} recorded.`)
          }}
        />
      )}
    </div>
  )
}

function PettyCashModal({ type, balance, onClose, onSave, saving }: {
  type: PettyCashEntryType
  balance: number
  onClose: () => void
  onSave: (e: { type: PettyCashEntryType; category: string; payee?: string; description: string; amount: number; receiptRef?: string }) => void
  saving: boolean
}) {
  const [category, setCategory] = useState('General')
  const [payee, setPayee] = useState('')
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [receiptRef, setReceiptRef] = useState('')
  const [attempted, setAttempted] = useState(false)

  const missing: MissingField[] = []
  if (!description.trim()) missing.push({ key: 'description', label: 'Description' })
  if (!amount || Number(amount) <= 0) missing.push({ key: 'amount', label: 'Amount' })
  if (type === 'expense' && Number(amount) > balance) missing.push({ key: 'amount', label: 'Amount', hint: `Exceeds the $${balance.toFixed(2)} in the box` })

  const handleSave = () => {
    setAttempted(true)
    if (missing.length > 0) return
    onSave({ type, category, payee: payee.trim() || undefined, description: description.trim(), amount: Number(amount), receiptRef: receiptRef.trim() || undefined })
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 480 }}>
        <div className="modal-header">
          <h3>{type === 'expense' ? 'Record Petty Cash Expense' : 'Replenish Petty Cash'}</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <ValidationSummary missing={missing} attempted={attempted} />
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
              {type === 'expense' && <span style={{ fontSize: 10, color: 'var(--muted)' }}>${balance.toFixed(2)} in the box</span>}
            </div>
          </div>
          {type === 'expense' && (
            <div className="form-group">
              <label>Paid to</label>
              <input className="form-control" value={payee} onChange={e => setPayee(e.target.value)} placeholder="Who received the cash" />
            </div>
          )}
          <div className="form-group" id={fieldId('description')}>
            <label>Description *</label>
            <input className={invalidClass(missing, attempted, 'description')} value={description} onChange={e => setDescription(e.target.value)}
              placeholder={type === 'expense' ? 'What was bought' : 'Where the top-up came from'} />
          </div>
          <div className="form-group">
            <label>Receipt / voucher ref</label>
            <input className="form-control" value={receiptRef} onChange={e => setReceiptRef(e.target.value)} placeholder="Optional" />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save Entry'}
          </button>
        </div>
      </div>
    </div>
  )
}
