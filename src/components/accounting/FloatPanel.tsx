import { useState, useEffect } from 'react'
import type { ToastMessage, FloatEntry, FloatEntryType, AppUser } from '../../types'
import { db } from '../../lib/db'
import { formatDateTime } from '../../lib/dateUtils'
import { useAuth } from '../../contexts/AuthContext'
import ValidationSummary, { MissingField, invalidClass, fieldId } from '../ui/ValidationSummary'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
}

const TYPE_LABEL: Record<FloatEntryType, string> = { issue: 'Issued', spend: 'Spent', return: 'Returned' }

/** Cash advanced to a staff member or agent to spend on the organisation's
 *  behalf. The ledger is append-only; each holder's outstanding float is
 *  derived: issued − spent − returned. */
export default function FloatPanel({ showToast }: Props) {
  const { user } = useAuth()
  const [entries, setEntries] = useState<FloatEntry[]>([])
  const [staff, setStaff] = useState<AppUser[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [formType, setFormType] = useState<FloatEntryType>('issue')
  const [saving, setSaving] = useState(false)

  const load = () => {
    setLoading(true)
    db.floatEntries.list().then(({ data, error }) => {
      if (error) showToast('error', error)
      setEntries(data)
    }).finally(() => setLoading(false))
  }
  useEffect(load, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { db.staff.list().then(({ data }) => setStaff(data ?? [])) }, [])

  /** Outstanding float per holder, newest holders first. */
  const holders = new Map<string, { issued: number; spent: number; returned: number }>()
  for (const e of entries) {
    const h = holders.get(e.holderName) ?? { issued: 0, spent: 0, returned: 0 }
    if (e.type === 'issue') h.issued += e.amount
    else if (e.type === 'spend') h.spent += e.amount
    else h.returned += e.amount
    holders.set(e.holderName, h)
  }
  const holderRows = [...holders.entries()].map(([name, h]) => ({ name, ...h, outstanding: h.issued - h.spent - h.returned }))
  const totalOutstanding = holderRows.reduce((s, h) => s + h.outstanding, 0)

  const openForm = (type: FloatEntryType) => { setFormType(type); setShowForm(true) }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="stats-grid">
        <div className="stat-card"><div className="stat-value">${totalOutstanding.toFixed(2)}</div><div className="stat-label">Total Float Outstanding</div></div>
        <div className="stat-card"><div className="stat-value">{holderRows.length}</div><div className="stat-label">Float Holders</div></div>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">Float by Holder</span>
          <div className="action-btns">
            <button className="btn btn-primary btn-sm" onClick={() => openForm('issue')}>＋ Issue Float</button>
            <button className="btn btn-ghost btn-sm" onClick={() => openForm('spend')}>Record Spend</button>
            <button className="btn btn-ghost btn-sm" onClick={() => openForm('return')}>Record Return</button>
          </div>
        </div>
        {holderRows.length === 0 ? (
          <div className="empty-state">No float issued yet.</div>
        ) : (
          <div className="tbl-scroll">
          <table className="table">
            <thead><tr><th>Holder</th><th>Issued</th><th>Spent</th><th>Returned</th><th>Outstanding</th></tr></thead>
            <tbody>
              {holderRows.map(h => (
                <tr key={h.name}>
                  <td>{h.name}</td>
                  <td>${h.issued.toFixed(2)}</td>
                  <td>${h.spent.toFixed(2)}</td>
                  <td>${h.returned.toFixed(2)}</td>
                  <td style={{ fontWeight: 600, color: h.outstanding > 0 ? 'var(--warning)' : 'var(--success)' }}>${h.outstanding.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-header"><span className="card-title">Float Ledger</span></div>
        {loading ? (
          <div className="empty-state">Loading float entries…</div>
        ) : entries.length === 0 ? (
          <div className="empty-state">No entries yet.</div>
        ) : (
          <div className="tbl-scroll">
          <table className="table">
            <thead><tr><th>Date</th><th>Holder</th><th>Type</th><th>Amount</th><th>Description</th><th>Recorded By</th></tr></thead>
            <tbody>
              {entries.map(e => (
                <tr key={e.id}>
                  <td>{formatDateTime(e.createdAt)}</td>
                  <td>{e.holderName}</td>
                  <td><span className={`pill ${e.type === 'issue' ? 'pill-pending' : e.type === 'spend' ? 'pill-cancelled' : 'pill-active'}`}>{TYPE_LABEL[e.type]}</span></td>
                  <td>${e.amount.toFixed(2)}</td>
                  <td>{e.description}</td>
                  <td>{e.recordedByName ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {showForm && (
        <FloatEntryModal
          type={formType}
          staff={staff}
          knownHolders={holderRows.map(h => h.name)}
          saving={saving}
          onClose={() => setShowForm(false)}
          onSave={async (input) => {
            setSaving(true)
            const { data, error } = await db.floatEntries.create({ ...input, recordedBy: user?.id, recordedByName: user?.name })
            setSaving(false)
            if (error || !data) { showToast('error', error ?? 'Failed to record the entry.'); return }
            setEntries(prev => [data, ...prev])
            setShowForm(false)
            showToast('success', `${TYPE_LABEL[data.type]} $${data.amount.toFixed(2)} for ${data.holderName}.`)
          }}
        />
      )}
    </div>
  )
}

function FloatEntryModal({ type, staff, knownHolders, onClose, onSave, saving }: {
  type: FloatEntryType
  staff: AppUser[]
  knownHolders: string[]
  onClose: () => void
  onSave: (e: { holderId?: string; holderName: string; type: FloatEntryType; amount: number; description: string }) => void
  saving: boolean
}) {
  const [holderName, setHolderName] = useState('')
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [attempted, setAttempted] = useState(false)

  const missing: MissingField[] = []
  if (!holderName.trim()) missing.push({ key: 'holder', label: 'Holder' })
  if (!amount || Number(amount) <= 0) missing.push({ key: 'amount', label: 'Amount' })
  if (type !== 'issue' && !description.trim()) missing.push({ key: 'description', label: 'Description', hint: 'What was spent / returned' })

  const handleSave = () => {
    setAttempted(true)
    if (missing.length > 0) return
    const name = holderName.trim()
    const member = staff.find(s => s.name === name)
    onSave({ holderId: member?.id, holderName: name, type, amount: Number(amount), description: description.trim() || TYPE_LABEL[type] })
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 480 }}>
        <div className="modal-header">
          <h3>{type === 'issue' ? 'Issue Float' : type === 'spend' ? 'Record Spend' : 'Record Return'}</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <ValidationSummary missing={missing} attempted={attempted} />
          <div className="form-group" id={fieldId('holder')}>
            <label>Holder *</label>
            <input className={invalidClass(missing, attempted, 'holder')} value={holderName} onChange={e => setHolderName(e.target.value)}
              list="float-holders" placeholder="Staff member or agent holding the cash" />
            <datalist id="float-holders">
              {[...new Set([...staff.map(s => s.name), ...knownHolders])].map(n => <option key={n} value={n} />)}
            </datalist>
          </div>
          <div className="form-group" id={fieldId('amount')}>
            <label>Amount ($) *</label>
            <input type="number" min="0" step="0.01" className={invalidClass(missing, attempted, 'amount')} value={amount} onChange={e => setAmount(e.target.value)} />
          </div>
          <div className="form-group" id={fieldId('description')}>
            <label>Description {type !== 'issue' && '*'}</label>
            <input className={invalidClass(missing, attempted, 'description')} value={description} onChange={e => setDescription(e.target.value)}
              placeholder={type === 'issue' ? 'Purpose of the float (optional)' : 'What was spent / returned'} />
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
