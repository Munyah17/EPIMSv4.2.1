import { useEffect, useMemo, useState } from 'react'
import type { ToastMessage, Policy } from '../types'
import type { ActivePanel } from '../App'
import { db } from '../lib/db'
import { formatDate } from '../lib/dateUtils'
import ViewPolicyModal from '../components/modals/ViewPolicyModal'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
  setActivePanel: (panel: ActivePanel) => void
}

/**
 * The lapsed book — policies whose cover stopped for non-payment
 * ('lapsed') plus 'defaulted' (paused collections), the same set the
 * Reminders reinstatement list and the dashboard Lapse Rate card work
 * from. Reached from the sidebar, the dashboard Lapse Rate card, or
 * directly; edits happen back on the Policies register.
 */
export default function LapsedPolicies({ showToast, setActivePanel }: Props) {
  const [policies, setPolicies] = useState<Policy[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [viewPolicy, setViewPolicy] = useState<Policy | null>(null)

  useEffect(() => {
    db.policies.list().then(({ data, error }) => {
      if (error) showToast('error', 'Failed to load policies.')
      else if (data) setPolicies(data.filter(p => p.status === 'lapsed' || p.status === 'defaulted'))
      setLoading(false)
    }).catch(() => { showToast('error', 'Failed to load policies.'); setLoading(false) })
  }, [showToast])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return policies
    return policies.filter(p =>
      p.policyNumber.toLowerCase().includes(q) ||
      p.clientName.toLowerCase().includes(q) ||
      p.productName.toLowerCase().includes(q) ||
      (p.agentName ?? '').toLowerCase().includes(q) ||
      (p.growerNumber ?? '').toLowerCase().includes(q)
    )
  }, [policies, search])

  const premiumAtRisk = filtered.reduce((sum, p) => sum + p.premium, 0)

  const daysLapsed = (p: Policy) => {
    const end = new Date(p.endDate).getTime()
    if (isNaN(end)) return null
    return Math.max(0, Math.floor((Date.now() - end) / 86400000))
  }

  return (
    <div className="panel">
      <div className="panel-toolbar">
        <div className="filter-row">
          <input
            className="search-input"
            placeholder="Search policy no., client, product, agent, grower no.…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <button type="button" className="btn btn-ghost" onClick={() => setActivePanel('reminders')}>
          Send reinstatement reminders →
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setActivePanel('policies')}>
          ← Policies
        </button>
      </div>

      {!loading && filtered.length > 0 && (
        <div className="info-banner info-banner-warning" style={{ marginBottom: 14 }}>
          <strong>{filtered.length} {filtered.length === 1 ? 'policy' : 'policies'} off cover</strong>
          {' '}— ${premiumAtRisk.toFixed(2)} in premiums walking out the door. Win these back from the
          Reminders page before they churn for good.
        </div>
      )}

      <div className="card">
        {loading ? (
          <div className="empty-state">Loading lapsed policies…</div>
        ) : (
          <div className="tbl-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Policy No.</th>
                <th>Client</th>
                <th>Product</th>
                <th>Premium</th>
                <th>Cover Ended</th>
                <th>Days Off Cover</th>
                <th>Agent / Captured By</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={9} className="td-empty">
                  {policies.length === 0 ? 'No lapsed policies — the whole book is live.' : 'No policies match that search.'}
                </td></tr>
              ) : filtered.map(p => {
                const days = daysLapsed(p)
                return (
                  <tr key={p.id}>
                    <td><span className="mono">{p.policyNumber}</span></td>
                    <td><strong>{p.clientName}</strong></td>
                    <td>{p.productName}</td>
                    <td>${p.premium.toFixed(2)}</td>
                    <td>{formatDate(p.endDate)}</td>
                    <td>{days === null ? '—' : `${days}d`}</td>
                    <td>{p.agentName ?? p.capturedByName ?? '—'}</td>
                    <td><span className={`pill ${p.status === 'lapsed' ? 'pill-lapsed' : 'pill-warning'}`}>{p.status}</span></td>
                    <td>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setViewPolicy(p)}>View</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {viewPolicy && (
        <ViewPolicyModal
          policy={viewPolicy}
          onClose={() => setViewPolicy(null)}
          onEdit={() => { setViewPolicy(null); setActivePanel('policies') }}
          showToast={showToast}
        />
      )}
    </div>
  )
}
