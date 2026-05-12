import { useState, useEffect } from 'react'
import type { Claim, ClaimStatus, AppUser } from '../../types'
import { db } from '../../lib/db'

interface Props {
  claim: Claim
  onClose: () => void
  onSave: (claim: Claim) => void
}

export default function ReviewClaimModal({ claim, onClose, onSave }: Props) {
  const [status, setStatus] = useState<ClaimStatus>(claim.status)
  const [notes, setNotes] = useState(claim.notes ?? '')
  const [assignedTo, setAssignedTo] = useState(claim.assignedTo ?? '')
  const [staff, setStaff] = useState<AppUser[]>([])

  useEffect(() => {
    db.staff.list().then(({ data }) => {
      if (data) {
        setStaff(data.filter(u => ['claims_officer', 'admin', 'super_admin'].includes(u.role)))
      }
    })
  }, [])

  const handleSave = () => {
    onSave({
      ...claim,
      status,
      notes,
      assignedTo: assignedTo || undefined,
      resolvedAt: ['approved', 'rejected', 'paid'].includes(status) ? new Date().toISOString() : claim.resolvedAt,
    })
  }

  const scoreColor = claim.fraudScore >= 70 ? 'var(--danger)' : claim.fraudScore >= 40 ? 'var(--gold)' : 'var(--teal)'

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-header">
          <h3>Review Claim — {claim.claimNumber}</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {claim.fraudScore >= 40 && (
            <div className={`info-banner info-banner-${claim.fraudScore >= 70 ? 'danger' : 'warning'}`} style={{ marginBottom: '1rem' }}>
              ⚠ Fraud score: <strong>{claim.fraudScore}%</strong> — {claim.fraudScore >= 70 ? 'HIGH RISK — Investigate before processing.' : 'Moderate risk — Verify documents carefully.'}
            </div>
          )}
          <div className="detail-grid">
            <div className="detail-item"><span className="detail-label">Client</span><span>{claim.clientName}</span></div>
            <div className="detail-item"><span className="detail-label">Policy</span><span className="mono">{claim.policyNumber}</span></div>
            <div className="detail-item"><span className="detail-label">Product</span><span>{claim.productName}</span></div>
            <div className="detail-item"><span className="detail-label">Type</span><span>{claim.claimType}</span></div>
            <div className="detail-item"><span className="detail-label">Amount</span><span>${claim.amount.toLocaleString()}</span></div>
            <div className="detail-item"><span className="detail-label">Date of Event</span><span>{claim.dateOfEvent}</span></div>
            <div className="detail-item"><span className="detail-label">Submitted</span><span>{claim.dateSubmitted}</span></div>
            <div className="detail-item">
              <span className="detail-label">Fraud Score</span>
              <span style={{ color: scoreColor, fontWeight: 600 }}>{claim.fraudScore}%</span>
            </div>
          </div>
          <div className="form-group" style={{ marginTop: '1rem' }}>
            <label>Description</label>
            <p style={{ color: 'var(--text)', fontSize: '0.9rem', lineHeight: 1.6 }}>{claim.description}</p>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Update Status</label>
              <select className="form-control" value={status} onChange={e => setStatus(e.target.value as ClaimStatus)}>
                <option value="pending">Pending</option>
                <option value="under_review">Under Review</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
                <option value="paid">Paid</option>
              </select>
            </div>
            <div className="form-group">
              <label>Assign To</label>
              <select className="form-control" value={assignedTo} onChange={e => setAssignedTo(e.target.value)}>
                <option value="">Unassigned</option>
                {staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          </div>
          <div className="form-group">
            <label>Internal Notes</label>
            <textarea className="form-control" rows={3} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Add review notes…" />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave}>Save Review</button>
        </div>
      </div>
    </div>
  )
}
