import { useState, useEffect } from 'react'
import type { Claim, Policy } from '../../types'
import { db } from '../../lib/db'
import { scoreClaimFraud } from '../../lib/aiService'
import { uploadDocument, deleteDocument, ACCEPTED_DOCUMENT_TYPES } from '../../lib/storage'

interface Props {
  onClose: () => void
  onSave: (claim: Claim) => void
  showToast?: (type: 'success' | 'error' | 'warning' | 'info', message: string) => void
}

interface DocSlot {
  label: string
  path: string | null
  uploading: boolean
}

export default function NewClaimModal({ onClose, onSave, showToast }: Props) {
  const [policies, setPolicies] = useState<Policy[]>([])
  const [allClaims, setAllClaims] = useState<Claim[]>([])
  const [loading, setLoading] = useState(true)
  const [policyNumberInput, setPolicyNumberInput] = useState('')
  const [claimType, setClaimType] = useState('Death Benefit')
  const [amount, setAmount] = useState('')
  const [dateOfEvent, setDateOfEvent] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)
  // National ID and one supporting document (burial order / doctor's note /
  // police report — whichever applies) are compulsory; "+ Upload More" adds
  // one additional slot at a time, same pattern throughout.
  const [docSlots, setDocSlots] = useState<DocSlot[]>([
    { label: 'National ID', path: null, uploading: false },
    { label: 'Claim Document 1', path: null, uploading: false },
  ])
  // Stable for the life of this form so uploaded files land in one folder,
  // even though it isn't the real claim id the DB will assign on insert —
  // staff Storage access isn't scoped by it (see add_document_storage.sql).
  const [draftId] = useState(() => `cl${Date.now()}`)

  useEffect(() => {
    Promise.all([db.policies.list(), db.claims.list()]).then(([polRes, claimRes]) => {
      if (polRes.data) setPolicies(polRes.data)
      if (claimRes.data) setAllClaims(claimRes.data)
      setLoading(false)
    })
  }, [])

  const policy = policies.find(p => p.policyNumber.toLowerCase() === policyNumberInput.trim().toLowerCase())
  const policyId = policy?.id ?? ''

  // Auto-fill amount when policy is selected
  useEffect(() => {
    if (policy) {
      setAmount(policy.coverAmount.toString())
    } else {
      setAmount('')
    }
  }, [policy])

  const CLAIM_TYPES = ['Death Benefit', 'Hospitalisation', 'Accidental Injury', 'Disability Benefit', 'Repatriation', 'Other']

  const addDocSlot = () => {
    const claimDocCount = docSlots.filter(s => s.label.startsWith('Claim Document')).length
    setDocSlots(prev => [...prev, { label: `Claim Document ${claimDocCount + 1}`, path: null, uploading: false }])
  }

  const handleSlotFile = async (index: number, file: File | null) => {
    if (!file) return
    const label = docSlots[index].label
    setDocSlots(prev => prev.map((s, i) => i === index ? { ...s, uploading: true } : s))
    // Bake the slot's label into the stored filename — documents is a flat
    // TEXT[] of paths, this is how "which document is this" survives without
    // a schema change.
    const renamed = new File([file], `${label.replace(/\s+/g, '-')}_${file.name}`, { type: file.type })
    const { data, error } = await uploadDocument('claims', draftId, renamed)
    if (error) {
      if (showToast) showToast('error', error)
      setDocSlots(prev => prev.map((s, i) => i === index ? { ...s, uploading: false } : s))
      return
    }
    setDocSlots(prev => prev.map((s, i) => i === index ? { ...s, path: data!.path, uploading: false } : s))
  }

  const removeSlotFile = async (index: number) => {
    const slot = docSlots[index]
    if (slot.path) await deleteDocument(slot.path)
    setDocSlots(prev => prev.map((s, i) => i === index ? { ...s, path: null } : s))
  }

  const requiredDocsMissing = !docSlots[0]?.path || !docSlots[1]?.path

  const handleSave = async () => {
    if (!policyId || !amount || !dateOfEvent || !description || !policy || requiredDocsMissing) return
    setSaving(true)
    const dateSubmitted = new Date().toISOString().split('T')[0]
    const priorClaimsOnPolicy = allClaims.filter(c => c.policyId === policyId).length
    let fraudScore = 20
    let signals: string[] = []
    try {
      const result = await scoreClaimFraud({
        claimType, amount: Number(amount), coverAmount: policy.coverAmount,
        dateOfEvent, policyStartDate: policy.startDate, dateSubmitted, description, priorClaimsOnPolicy,
      })
      fraudScore = result.score
      signals = result.signals
    } finally {
      const claimNumber = `CLM${new Date().getFullYear()}${String(Date.now()).slice(-3)}`
      const claim: Claim & { fraudSignals?: string[] } = {
        id: draftId,
        claimNumber,
        policyId,
        policyNumber: policy.policyNumber,
        clientId: policy.clientId,
        clientName: policy.clientName,
        productName: policy.productName,
        claimType,
        amount: Number(amount),
        status: 'pending',
        dateOfEvent,
        dateSubmitted,
        description,
        fraudScore,
        documents: docSlots.filter(s => s.path).map(s => s.path as string),
        fraudSignals: signals,
      }
      setSaving(false)
      onSave(claim)
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-header">
          <h3>New Claim</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label>Policy Number *</label>
            <input
              className="form-control"
              list="claim-policy-numbers"
              placeholder={loading ? 'Loading policies…' : 'Enter or select a policy number'}
              value={policyNumberInput}
              onChange={e => setPolicyNumberInput(e.target.value)}
              disabled={loading}
            />
            <datalist id="claim-policy-numbers">
              {policies.map(p => <option key={p.id} value={p.policyNumber} />)}
            </datalist>
          </div>
          {policyNumberInput.trim() && !policy && !loading && (
            <div className="info-banner info-banner-warning" style={{ marginBottom: '1rem' }}>
              No policy found with that number.
            </div>
          )}
          {policy && (
            <div className="info-banner info-banner-info" style={{ marginBottom: '1rem' }}>
              {policy.clientName} · {policy.productName} · Max cover: ${policy.coverAmount.toLocaleString()} · Status: {policy.status}
            </div>
          )}
          <div className="form-row">
            <div className="form-group">
              <label>Claim Type *</label>
              <select className="form-control" value={claimType} onChange={e => setClaimType(e.target.value)}>
                {CLAIM_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>Claim Amount ($) *</label>
              <input
                type="number" className="form-control" min={0} value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder="Auto-filled from policy"
                disabled={!!policy}
                style={policy ? { opacity: 0.6 } : undefined}
              />
            </div>
          </div>
          <div className="form-group">
            <label>Date of Event *</label>
            <input type="date" className="form-control" value={dateOfEvent} onChange={e => setDateOfEvent(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Description *</label>
            <textarea className="form-control" rows={4} value={description} onChange={e => setDescription(e.target.value)} placeholder="Describe the incident…" />
          </div>
          <div className="form-group">
            <label>Supporting Documents</label>
            {docSlots.map((slot, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 12, width: 130, flexShrink: 0 }}>{slot.label} *</span>
                {slot.path ? (
                  <>
                    <span style={{ fontSize: 12, color: 'var(--success)', flex: 1 }}>✓ Uploaded</span>
                    <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} onClick={() => removeSlotFile(i)}>Remove</button>
                  </>
                ) : (
                  <input
                    type="file"
                    accept={ACCEPTED_DOCUMENT_TYPES}
                    disabled={slot.uploading}
                    onChange={e => handleSlotFile(i, e.target.files?.[0] ?? null)}
                    style={{ fontSize: 11, flex: 1 }}
                  />
                )}
                {slot.uploading && <span style={{ fontSize: 11, color: 'var(--muted)' }}>Uploading…</span>}
              </div>
            ))}
            <button type="button" className="btn btn-ghost btn-sm" onClick={addDocSlot} style={{ marginTop: 4 }}>+ Upload More</button>
            <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>PDF, Word, CSV, Excel, RTF, PNG, JPEG, JPG, or WEBP — up to 10MB each.</p>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving || !policyId || !amount || !dateOfEvent || !description || requiredDocsMissing}>
            {saving ? 'Analysing & Submitting…' : 'Submit Claim'}
          </button>
        </div>
      </div>
    </div>
  )
}
