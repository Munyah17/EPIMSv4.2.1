import { useState, useEffect } from 'react'
import type { Claim, Policy } from '../../types'
import { db } from '../../lib/db'
import { scoreClaimFraud } from '../../lib/aiService'

interface Props {
  onClose: () => void
  onSave: (claim: Claim) => void
}

export default function NewClaimModal({ onClose, onSave }: Props) {
  const [policies, setPolicies] = useState<Policy[]>([])
  const [allClaims, setAllClaims] = useState<Claim[]>([])
  const [loading, setLoading] = useState(true)
  const [policyId, setPolicyId] = useState('')
  const [claimType, setClaimType] = useState('Death Benefit')
  const [amount, setAmount] = useState('')
  const [dateOfEvent, setDateOfEvent] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    Promise.all([db.policies.list(), db.claims.list()]).then(([polRes, claimRes]) => {
      if (polRes.data) setPolicies(polRes.data)
      if (claimRes.data) setAllClaims(claimRes.data)
      setLoading(false)
    })
  }, [])

  const policy = policies.find(p => p.id === policyId)

  // Auto-fill amount when policy is selected
  useEffect(() => {
    if (policy) {
      setAmount(policy.coverAmount.toString())
    } else {
      setAmount('')
    }
  }, [policy])

  const CLAIM_TYPES = ['Death Benefit', 'Hospitalisation', 'Accidental Injury', 'Disability Benefit', 'Repatriation', 'Other']

  const handleSave = async () => {
    if (!policyId || !amount || !dateOfEvent || !description || !policy) return
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
        id: `cl${Date.now()}`,
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
        documents: [],
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
            <label>Policy *</label>
            {loading ? (
              <select className="form-control" disabled>
                <option>Loading policies…</option>
              </select>
            ) : (
              <select className="form-control" value={policyId} onChange={e => setPolicyId(e.target.value)}>
                <option value="">Select policy…</option>
                {policies.map(p => (
                  <option key={p.id} value={p.id}>{p.policyNumber} — {p.clientName} ({p.productName})</option>
                ))}
              </select>
            )}
          </div>
          {policy && (
            <div className="info-banner info-banner-info" style={{ marginBottom: '1rem' }}>
              Max cover: ${policy.coverAmount.toLocaleString()} · Status: {policy.status}
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
              <input type="number" className="form-control" min={0} value={amount} onChange={e => setAmount(e.target.value)} placeholder="Auto-filled from policy" />
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
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving || !policyId || !amount || !dateOfEvent || !description}>
            {saving ? 'Analysing & Submitting…' : 'Submit Claim'}
          </button>
        </div>
      </div>
    </div>
  )
}
