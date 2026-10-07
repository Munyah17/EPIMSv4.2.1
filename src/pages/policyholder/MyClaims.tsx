import { useState, useEffect } from 'react'
import type { ToastMessage } from '../../types'
import type { ActivePanel } from '../../App'
import { db } from '../../lib/db'
import { formatDate } from '../../lib/dateUtils'
import type { Claim } from '../../types'
import { usePolicyholderScope } from '../../components/policyholder/usePolicyholderScope'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
  setActivePanel: (panel: ActivePanel) => void
}

export default function MyClaims({ showToast }: Props) {
  // Scoped by client/policy ID, not name — see usePolicyholderScope.
  const { clientIds, policyIds, loading: scopeLoading, error: scopeError } = usePolicyholderScope()
  const [claims, setClaims] = useState<Claim[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    db.claims.list().then(({ data, error }) => {
      if (data) setClaims(data)
      if (error) setError(error)
      setLoading(false)
    }).catch(() => { setError('Could not load claims.'); setLoading(false) })
  }, [])

  const loadError = scopeError ?? error
  useEffect(() => {
    if (loadError) showToast('error', loadError)
  }, [loadError, showToast])

  // A claim is theirs if it points at their client record or at one of
  // their policies (claims_select_own scopes by policy at the DB; the ID
  // check here guards the shared offline cache — see the hook).
  const myClaims = claims.filter(c => clientIds.has(c.clientId) || policyIds.has(c.policyId))

  return (
    <div className="panel">
      {loading || scopeLoading ? (
        <div className="empty-state">Loading claims…</div>
      ) : loadError ? (
        <div className="empty-state">{loadError}</div>
      ) : myClaims.length === 0 ? (
        <div className="empty-state">No claims found for your account.</div>
      ) : (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>Claim No.</th>
                <th>Product</th>
                <th>Type</th>
                <th>Amount</th>
                <th>Submitted</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {myClaims.map(c => (
                <tr key={c.id}>
                  <td><span className="mono">{c.claimNumber}</span></td>
                  <td>{c.productName}</td>
                  <td>{c.claimType}</td>
                  <td>${c.amount.toLocaleString()}</td>
                  <td>{formatDate(c.dateSubmitted)}</td>
                  <td><span className="status-pills"><span className={`pill pill-${c.status.replace('_', '-')}`}>{c.status.replace('_', ' ')}</span></span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
