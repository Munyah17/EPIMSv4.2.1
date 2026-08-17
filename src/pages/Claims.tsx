import { useState, useEffect } from 'react'
import type { ToastMessage, Claim, ClaimStatus, ClaimAssessment } from '../types'
import type { ActivePanel } from '../App'
import { db } from '../lib/db'
import ScoreBar from '../components/ui/ScoreBar'
import NewClaimModal from '../components/modals/NewClaimModal'
import NewAgricultureClaimModal, { type PendingOfflinePhoto } from '../components/modals/NewAgricultureClaimModal'
import ReviewClaimModal from '../components/modals/ReviewClaimModal'
import { notifyClaimCreated } from '../lib/claimNotifications'
import { useAuth } from '../contexts/AuthContext'
import { queueAssessment } from '../lib/offlineQueue'
import { checkAndRecordPhotoDuplicates } from '../lib/duplicatePhotoCheck'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
  setActivePanel: (panel: ActivePanel) => void
}

export default function Claims({ showToast }: Props) {
  const { hasPermission } = useAuth()
  const [claims, setClaims] = useState<Claim[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<ClaimStatus | 'all'>('all')
  const [newClaimKind, setNewClaimKind] = useState<'ordinary' | 'agriculture' | null>(null)
  const [reviewClaim, setReviewClaim] = useState<Claim | null>(null)

  useEffect(() => {
    db.claims.list().then(({ data, error }) => {
      if (error) showToast('error', 'Failed to load claims.')
      else if (data) setClaims(data)
      setLoading(false)
    })
  }, [showToast])

  const filtered = claims.filter(c => {
    const matchSearch = c.claimNumber.toLowerCase().includes(search.toLowerCase()) ||
      c.clientName.toLowerCase().includes(search.toLowerCase())
    const matchStatus = statusFilter === 'all' || c.status === statusFilter
    return matchSearch && matchStatus
  })

  const counts = {
    all: claims.length,
    pending: claims.filter(c => c.status === 'pending').length,
    under_review: claims.filter(c => c.status === 'under_review').length,
    approved: claims.filter(c => c.status === 'approved').length,
    rejected: claims.filter(c => c.status === 'rejected').length,
    paid: claims.filter(c => c.status === 'paid').length,
  }

  const finishClaimSubmission = async (data: Claim, fraudSignals: string[] | undefined) => {
    setClaims(prev => [data, ...prev])
    setNewClaimKind(null)
    try { notifyClaimCreated(data) } catch { /**/ }

    const FRAUD_REVIEW_THRESHOLD = 55
    if (data.fraudScore >= FRAUD_REVIEW_THRESHOLD) {
      await db.fraudCases.create(data.id, data.fraudScore, fraudSignals ?? [])
      showToast('warning', `Claim ${data.claimNumber} submitted, flagged for fraud review (score ${data.fraudScore}).`)
    } else {
      showToast('success', `Claim ${data.claimNumber} submitted successfully.`)
    }
  }

  const handleAdd = async (claim: Claim & { fraudSignals?: string[] }) => {
    const { data, error } = await db.claims.create(claim)
    if (error || !data) { showToast('error', 'Failed to submit claim.'); return }
    await finishClaimSubmission(data, claim.fraudSignals)
  }

  /** Agriculture claims capture the full physical assessment (photos, GPS,
   *  farmer + assessor signatures) at intake time in one modal rather than
   *  as a separate later step — the claim still starts at the normal
   *  'intake' stage and flows through assessment/final_review exactly like
   *  any other claim, but by the time it reaches the assessment stage the
   *  assessment is already there and complete (ReviewClaimModal's
   *  hasCompletedAssessment check picks it up automatically).
   *
   *  Any photos that couldn't upload while offline, or a failure attaching
   *  the assessment even when online, both fall back to the same
   *  offline-queue AgricultureAssessmentModal already uses — the claim
   *  itself is never left without its assessment silently. */
  const handleAddAgriculture = async (
    claim: Claim & { fraudSignals?: string[] },
    assessment: Omit<ClaimAssessment, 'id' | 'claimId' | 'claimNumber' | 'assessorName' | 'createdAt'>,
    offlinePhotos: PendingOfflinePhoto[],
  ) => {
    const { data, error } = await db.claims.create(claim)
    if (error || !data) { showToast('error', 'Failed to submit claim.'); return }

    const queueFallback = () => {
      const { photos, ...formData } = assessment
      queueAssessment('claim', data.id, { ...formData, _alreadyUploadedPhotos: photos }, offlinePhotos)
    }

    if (!navigator.onLine || offlinePhotos.length > 0) {
      queueFallback()
      showToast('warning', `Claim ${data.claimNumber} submitted; the assessment is saved on this device and will sync once you're back online.`)
    } else {
      const { error: assessError } = await db.claimAssessments.create({ ...assessment, claimId: data.id })
      if (assessError) {
        queueFallback()
        showToast('warning', `Claim ${data.claimNumber} submitted; the assessment couldn't attach (${assessError}), so it's queued to retry automatically.`)
      } else {
        // Index this claim's photos for future duplicate-detection lookups
        // — best-effort, never blocks the claim that's already been created.
        void checkAndRecordPhotoDuplicates(assessment.photos, 'claim', data.id, data.claimNumber)
      }
    }
    await finishClaimSubmission(data, claim.fraudSignals)
  }

  const handleUpdate = async (updated: Claim, notify: () => Promise<void>) => {
    const { data, error } = await db.claims.update(updated.id, updated)
    if (error || !data) { showToast('error', 'Failed to update claim.'); return }
    setClaims(prev => prev.map(c => c.id === data.id ? data : c))
    showToast('success', `Claim ${data.claimNumber} updated.`)
    setReviewClaim(null)
    try { await notify() } catch { /**/ }
  }

  return (
    <div className="panel">
      <div className="panel-toolbar">
        <div className="filter-row">
          <input
            className="search-input"
            placeholder="Search claim number or client…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <select title="Filter by status" className="filter-select" value={statusFilter} onChange={e => setStatusFilter(e.target.value as ClaimStatus | 'all')}>
            <option value="all">All ({counts.all})</option>
            <option value="pending">Pending ({counts.pending})</option>
            <option value="under_review">Under Review ({counts.under_review})</option>
            <option value="approved">Approved ({counts.approved})</option>
            <option value="rejected">Rejected ({counts.rejected})</option>
            <option value="paid">Paid ({counts.paid})</option>
          </select>
        </div>
        {hasPermission('claims.create') && (
          <button type="button" className="btn btn-primary" onClick={() => setNewClaimKind('ordinary')}>+ New Claim</button>
        )}
      </div>

      <div className="card">
        {loading ? (
          <div className="empty-state">Loading claims…</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Claim No.</th>
                <th>Client</th>
                <th>Product</th>
                <th>Type</th>
                <th>Amount</th>
                <th>Submitted</th>
                <th>Fraud Score</th>
                <th>Status</th>
                <th>Stage</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={10} className="td-empty">No claims found.</td></tr>
              ) : filtered.map(c => (
                <tr key={c.id}>
                  <td><span className="mono">{c.claimNumber}</span></td>
                  <td>{c.clientName}</td>
                  <td>{c.productName}</td>
                  <td>{c.claimType}</td>
                  <td>${c.amount.toLocaleString()}</td>
                  <td>{c.dateSubmitted}</td>
                  <td><ScoreBar score={c.fraudScore} /></td>
                  <td><span className={`pill pill-${c.status.replace('_', '-')}`}>{c.status.replace('_', ' ')}</span></td>
                  <td>
                    {c.stage === 'closed' ? '—' : (
                      <>
                        <span className="pill pill-active pill-xs">{c.stage.replace('_', ' ')}</span>
                        {c.assignedName && <span style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginTop: 2 }}>{c.assignedName}</span>}
                      </>
                    )}
                  </td>
                  <td>
                    <div className="action-btns">
                      {hasPermission('claims.edit') && (
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setReviewClaim(c)}>Review</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {newClaimKind === 'ordinary' && (
        <NewClaimModal
          onClose={() => setNewClaimKind(null)}
          onSave={handleAdd}
          showToast={showToast}
          claimKind={newClaimKind}
          onSwitchKind={setNewClaimKind}
        />
      )}
      {newClaimKind === 'agriculture' && (
        <NewAgricultureClaimModal
          onClose={() => setNewClaimKind(null)}
          onSave={handleAddAgriculture}
          showToast={showToast}
          claimKind={newClaimKind}
          onSwitchKind={setNewClaimKind}
        />
      )}
      {reviewClaim && (
        <ReviewClaimModal
          claim={reviewClaim}
          onClose={() => setReviewClaim(null)}
          onSave={handleUpdate}
          showToast={showToast}
        />
      )}
    </div>
  )
}
