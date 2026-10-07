import { useState, useEffect } from 'react'
import type { ToastMessage } from '../../types'
import type { ActivePanel } from '../../App'
import { db } from '../../lib/db'
import { formatDate } from '../../lib/dateUtils'
import type { Payment, PaymentStatus } from '../../types'
import { usePolicyholderScope } from '../../components/policyholder/usePolicyholderScope'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
  setActivePanel: (panel: ActivePanel) => void
}

// Payments used to style every non-completed status as amber "pending",
// which told a policyholder a failed or reversed payment was still in
// flight. Map each real status to an existing pill class.
const STATUS_PILL: Record<PaymentStatus, string> = {
  completed: 'pill-paid',
  pending: 'pill-pending',
  failed: 'pill-rejected',
  reversed: 'pill-cancelled',
}

export default function MyPayments({ showToast }: Props) {
  // Scoped by policy ID — payments carry policy_id, not client_id —
  // see usePolicyholderScope for why this is not a name match.
  const { policyIds, loading: scopeLoading, error: scopeError } = usePolicyholderScope()
  const [payments, setPayments] = useState<Payment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    db.payments.list().then(({ data, error }) => {
      if (data) setPayments(data)
      if (error) setError(error)
      setLoading(false)
    }).catch(() => { setError('Could not load payments.'); setLoading(false) })
  }, [])

  const loadError = scopeError ?? error
  useEffect(() => {
    if (loadError) showToast('error', loadError)
  }, [loadError, showToast])

  const myPayments = payments.filter(p => policyIds.has(p.policyId))
  const total = myPayments.filter(p => p.status === 'completed').reduce((s, p) => s + p.amount, 0)

  return (
    <div className="panel">
      <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(2,1fr)', marginBottom: '1.5rem' }}>
        <div className="stat-card">
          <div className="stat-icon" style={{ background: 'rgba(16,185,129,0.15)', color: 'var(--teal)' }}>💰</div>
          <div className="stat-body">
            <div className="stat-value">${total.toFixed(2)}</div>
            <div className="stat-label">Total Paid</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon" style={{ background: 'rgba(91,127,232,0.15)', color: 'var(--blue)' }}>🧾</div>
          <div className="stat-body">
            <div className="stat-value">{myPayments.length}</div>
            <div className="stat-label">Transactions</div>
          </div>
        </div>
      </div>

      {loading || scopeLoading ? (
        <div className="empty-state">Loading payments…</div>
      ) : loadError ? (
        <div className="empty-state">{loadError}</div>
      ) : myPayments.length === 0 ? (
        <div className="empty-state">No payments found for your account.</div>
      ) : (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>Reference</th>
                <th>Policy</th>
                <th>Amount</th>
                <th>Method</th>
                <th>Date</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {myPayments.map(p => (
                <tr key={p.id}>
                  <td><span className="mono">{p.reference}</span></td>
                  <td><span className="mono">{p.policyNumber}</span></td>
                  <td><strong>${p.amount.toFixed(2)}</strong></td>
                  <td>{p.method}</td>
                  <td>{formatDate(p.date)}</td>
                  <td><span className="status-pills"><span className={`pill ${STATUS_PILL[p.status]}`}>{p.status}</span></span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
