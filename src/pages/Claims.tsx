import { useState, useEffect } from 'react'
import type { ToastMessage, Claim, ClaimStatus } from '../types'
import type { ActivePanel } from '../App'
import { db } from '../lib/db'
import ScoreBar from '../components/ui/ScoreBar'
import NewClaimModal from '../components/modals/NewClaimModal'
import ReviewClaimModal from '../components/modals/ReviewClaimModal'
import { notifyClaimCreated, notifyClaimStatusChanged } from '../lib/claimNotifications'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
  setActivePanel: (panel: ActivePanel) => void
}

export default function Claims({ showToast }: Props) {
  const [claims, setClaims] = useState<Claim[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<ClaimStatus | 'all'>('all')
  const [showNew, setShowNew] = useState(false)
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

  const handleAdd = async (claim: Claim & { fraudSignals?: string[] }) => {
    const { data, error } = await db.claims.create(claim)
    if (error || !data) { showToast('error', 'Failed to submit claim.'); return }
    setClaims(prev => [data, ...prev])
    setShowNew(false)
    try { notifyClaimCreated(data) } catch { /**/ }

    const FRAUD_REVIEW_THRESHOLD = 55
    if (data.fraudScore >= FRAUD_REVIEW_THRESHOLD) {
      await db.fraudCases.create(data.id, data.fraudScore, claim.fraudSignals ?? [])
      showToast('warning', `Claim ${data.claimNumber} submitted — flagged for fraud review (score ${data.fraudScore}).`)
    } else {
      showToast('success', `Claim ${data.claimNumber} submitted successfully.`)
    }
  }

  const handleUpdate = async (updated: Claim) => {
    const previous = claims.find(c => c.id === updated.id)
    const { data, error } = await db.claims.update(updated.id, updated)
    if (error || !data) { showToast('error', 'Failed to update claim.'); return }
    setClaims(prev => prev.map(c => c.id === data.id ? data : c))
    showToast('success', `Claim ${data.claimNumber} updated.`)
    setReviewClaim(null)
    if (previous && data.status !== previous.status) {
      try { notifyClaimStatusChanged(data, previous.status) } catch { /**/ }
    }
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
        <button type="button" className="btn btn-primary" onClick={() => setShowNew(true)}>+ New Claim</button>
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
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={9} className="td-empty">No claims found.</td></tr>
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
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setReviewClaim(c)}>Review</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showNew && (
        <NewClaimModal onClose={() => setShowNew(false)} onSave={handleAdd} />
      )}
      {reviewClaim && (
        <ReviewClaimModal
          claim={reviewClaim}
          onClose={() => setReviewClaim(null)}
          onSave={handleUpdate}
        />
      )}
    </div>
  )
}
