import { useState, useEffect } from 'react'
import type { Claim, AppUser, ClaimAssessment } from '../../types'
import { db } from '../../lib/db'
import { formatDate } from '../../lib/dateUtils'
import { getDocumentUrl, documentDisplayName } from '../../lib/storage'
import { useAuth } from '../../contexts/AuthContext'
import {
  notifyClaimIntakeAccepted, notifyClaimIntakeRejected,
  notifyClaimEscalated, notifyClaimFinalDecision,
} from '../../lib/claimNotifications'
import AgricultureAssessmentModal from './AgricultureAssessmentModal'
import { exportClaimAssessmentReport } from '../../lib/exportUtils'

interface Props {
  claim: Claim
  onClose: () => void
  /** The modal resolves the whole transition (next claim state) itself —
   *  the parent just persists it and, on success, fires `notify`. */
  onSave: (claim: Claim, notify: () => Promise<void>) => void
  showToast: (type: 'success' | 'error' | 'warning' | 'info', message: string) => void
}

const STAGE_LABEL: Record<Claim['stage'], string> = {
  intake: 'Intake — Claims Receiver',
  assessment: 'Assessment — Claims Processor',
  final_review: 'Final Review — MD/COO',
  closed: 'Closed',
}

const isAgriculture = (claim: Claim) => claim.category === 'agriculture'

export default function ReviewClaimModal({ claim, onClose, onSave, showToast }: Props) {
  const { hasPermission } = useAuth()
  const [notes, setNotes] = useState(claim.notes ?? '')
  const [assessmentNotes, setAssessmentNotes] = useState(claim.assessmentNotes ?? '')
  const [nextStaffId, setNextStaffId] = useState('')
  const [staff, setStaff] = useState<AppUser[]>([])
  const [busy, setBusy] = useState(false)
  const [physicalAssessments, setPhysicalAssessments] = useState<ClaimAssessment[]>([])
  const [showAssessmentModal, setShowAssessmentModal] = useState(false)

  useEffect(() => {
    db.staff.list().then(({ data }) => { if (data) setStaff(data.filter(u => u.active)) })
    if (isAgriculture(claim)) {
      db.claimAssessments.listForClaim(claim.id).then(({ data }) => setPhysicalAssessments(data))
    }
  }, [claim])

  const hasCompletedAssessment = physicalAssessments.some(a => !!a.submittedAt)

  const printAssessment = () => {
    const completed = physicalAssessments.find(a => !!a.submittedAt)
    if (completed) void exportClaimAssessmentReport(completed, claim.claimNumber, claim.policyNumber, claim.clientName)
  }

  const scoreColor = claim.fraudScore >= 70 ? 'var(--danger)' : claim.fraudScore >= 40 ? 'var(--gold)' : 'var(--teal)'

  const openDocument = async (path: string) => {
    const url = await getDocumentUrl(path)
    if (url) window.open(url, '_blank', 'noopener,noreferrer')
  }

  const describeDocument = (path: string) => {
    const raw = documentDisplayName(path)
    const [label, ...rest] = raw.split('_')
    return rest.length ? `${label.replace(/-/g, ' ')}: ${rest.join('_')}` : raw
  }

  const saveNotesOnly = () => {
    onSave({ ...claim, notes }, async () => { /* internal note edit — nothing to notify */ })
  }

  const acceptIntake = async () => {
    const processor = staff.find(s => s.id === nextStaffId)
    if (!processor) return
    setBusy(true)
    const updated: Claim = { ...claim, notes, stage: 'assessment', status: 'under_review', assignedTo: processor.id, assignedName: processor.name }
    onSave(updated, () => notifyClaimIntakeAccepted(updated, { email: processor.email, phone: processor.phone, name: processor.name }))
  }

  const rejectIntake = () => {
    setBusy(true)
    const updated: Claim = { ...claim, notes, stage: 'closed', status: 'rejected', resolvedAt: new Date().toISOString() }
    onSave(updated, () => notifyClaimIntakeRejected(updated))
  }

  const escalateToFinalReview = () => {
    const reviewer = staff.find(s => s.id === nextStaffId)
    if (!reviewer) return
    setBusy(true)
    const updated: Claim = { ...claim, notes, assessmentNotes, stage: 'final_review', assignedTo: reviewer.id, assignedName: reviewer.name }
    onSave(updated, () => notifyClaimEscalated(updated, { email: reviewer.email, phone: reviewer.phone, name: reviewer.name }))
  }

  const finalDecision = (approve: boolean) => {
    setBusy(true)
    const updated: Claim = { ...claim, notes, stage: 'closed', status: approve ? 'approved' : 'rejected', resolvedAt: new Date().toISOString() }
    onSave(updated, () => notifyClaimFinalDecision(updated))
  }

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
          <div className="info-banner info-banner-info" style={{ marginBottom: '1rem' }}>
            Stage: <strong>{STAGE_LABEL[claim.stage]}</strong>
            {claim.assignedName && claim.stage !== 'closed' && <> — assigned to <strong>{claim.assignedName}</strong></>}
          </div>
          <div className="detail-grid">
            <div className="detail-item"><span className="detail-label">Client</span><span>{claim.clientName}</span></div>
            <div className="detail-item"><span className="detail-label">Policy</span><span className="mono">{claim.policyNumber}</span></div>
            <div className="detail-item"><span className="detail-label">Product</span><span>{claim.productName}</span></div>
            <div className="detail-item"><span className="detail-label">Type</span><span>{claim.claimType}</span></div>
            <div className="detail-item"><span className="detail-label">Amount</span><span>${claim.amount.toLocaleString()}</span></div>
            <div className="detail-item"><span className="detail-label">Date of Event</span><span>{formatDate(claim.dateOfEvent)}</span></div>
            <div className="detail-item"><span className="detail-label">Submitted</span><span>{formatDate(claim.dateSubmitted)}</span></div>
            <div className="detail-item">
              <span className="detail-label">Fraud Score</span>
              <span style={{ color: scoreColor, fontWeight: 600 }}>{claim.fraudScore}%</span>
            </div>
          </div>
          <div className="form-group" style={{ marginTop: '1rem' }}>
            <label>Description</label>
            <p style={{ color: 'var(--text)', fontSize: '0.9rem', lineHeight: 1.6 }}>{claim.description}</p>
          </div>
          {claim.documents.length > 0 && (
            <div className="form-group">
              <label>Supporting Documents</label>
              <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
                {claim.documents.map(path => (
                  <li key={path}>
                    <button type="button" onClick={() => openDocument(path)} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--blue)', textDecoration: 'underline', cursor: 'pointer', fontSize: 12 }}>
                      📄 {describeDocument(path)}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {claim.assessmentNotes && claim.stage !== 'assessment' && (
            <div className="form-group">
              <label>Assessment Notes</label>
              <p style={{ color: 'var(--text)', fontSize: '0.85rem', lineHeight: 1.6 }}>{claim.assessmentNotes}</p>
            </div>
          )}

          <div className="form-group">
            <label>Internal Notes</label>
            <textarea className="form-control" rows={3} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Add review notes…" />
          </div>

          {/* ── Stage-specific action area ─────────────────────────── */}
          {claim.stage === 'intake' && hasPermission('claims.intake') && (
            <div className="claim-stage-action">
              <label>Accept &amp; Assign to Claims Processor</label>
              <select className="form-control" value={nextStaffId} onChange={e => setNextStaffId(e.target.value)}>
                <option value="">Select processor…</option>
                {staff.map(s => <option key={s.id} value={s.id}>{s.name} ({s.role.replace(/_/g, ' ')})</option>)}
              </select>
              <div className="claim-stage-action-btns">
                <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} disabled={busy} onClick={rejectIntake}>Reject Claim</button>
                <button type="button" className="btn btn-primary btn-sm" disabled={busy || !nextStaffId} onClick={acceptIntake}>Accept &amp; Assign</button>
              </div>
            </div>
          )}

          {claim.stage === 'assessment' && isAgriculture(claim) && (
            <div className="claim-stage-action">
              <label>Physical Assessment {hasCompletedAssessment ? '✓ Completed' : '(required before final review)'}</label>
              {hasCompletedAssessment ? (
                <p style={{ fontSize: 12, color: 'var(--success)' }}>
                  Submitted {formatDate(physicalAssessments.find(a => a.submittedAt)?.submittedAt)} by {physicalAssessments.find(a => a.submittedAt)?.assessorName}.
                </p>
              ) : (
                <p style={{ fontSize: 12, color: 'var(--muted)' }}>An Assessor must complete a site visit before this claim can go to final review.</p>
              )}
              <div className="claim-stage-action-btns">
                {hasCompletedAssessment && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={printAssessment}>🖨 Print Assessment</button>
                )}
                {hasPermission('claims.physical_assessment') && (
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => setShowAssessmentModal(true)}>
                    {hasCompletedAssessment ? 'View / Redo Assessment' : '📷 Start Physical Assessment'}
                  </button>
                )}
              </div>
            </div>
          )}

          {claim.stage === 'assessment' && hasPermission('claims.assess') && (
            <div className="claim-stage-action">
              <label>Assessment Notes</label>
              <textarea className="form-control" rows={3} value={assessmentNotes} onChange={e => setAssessmentNotes(e.target.value)} placeholder="Record your analysis of this claim…" />
              <label style={{ marginTop: 8 }}>Escalate to Final Reviewer (MD/COO)</label>
              <select className="form-control" value={nextStaffId} onChange={e => setNextStaffId(e.target.value)}>
                <option value="">Select final reviewer…</option>
                {staff.map(s => <option key={s.id} value={s.id}>{s.name} ({s.role.replace(/_/g, ' ')})</option>)}
              </select>
              {isAgriculture(claim) && !hasCompletedAssessment && (
                <p style={{ fontSize: 11, color: 'var(--danger)', marginTop: 4 }}>Complete the physical assessment above before escalating.</p>
              )}
              <div className="claim-stage-action-btns">
                <button type="button" className="btn btn-primary btn-sm" disabled={busy || !nextStaffId || (isAgriculture(claim) && !hasCompletedAssessment)} onClick={escalateToFinalReview}>Submit for Final Review</button>
              </div>
            </div>
          )}

          {claim.stage === 'final_review' && (hasPermission('claims.approve') || hasPermission('claims.reject')) && (
            <div className="claim-stage-action">
              <label>Final Decision</label>
              <div className="claim-stage-action-btns">
                {hasPermission('claims.reject') && (
                  <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} disabled={busy} onClick={() => finalDecision(false)}>Decline</button>
                )}
                {hasPermission('claims.approve') && (
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => finalDecision(true)}>Approve</button>
                )}
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
          <button className="btn btn-primary" onClick={saveNotesOnly} disabled={busy}>Save Notes</button>
        </div>
      </div>
      {showAssessmentModal && (
        <AgricultureAssessmentModal
          claimId={claim.id}
          claimNumber={claim.claimNumber}
          claimDescription={claim.description}
          onClose={() => setShowAssessmentModal(false)}
          onSubmitted={() => {
            setShowAssessmentModal(false)
            db.claimAssessments.listForClaim(claim.id).then(({ data }) => setPhysicalAssessments(data))
          }}
          showToast={showToast}
        />
      )}
    </div>
  )
}
