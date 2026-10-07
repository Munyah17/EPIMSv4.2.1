import { useState, useEffect } from 'react'
import type { ToastMessage } from '../../types'
import type { ActivePanel } from '../../App'
import { formatDate } from '../../lib/dateUtils'
import type { PolicyStatus } from '../../types'
import { useAuth } from '../../contexts/AuthContext'
import { premiumPeriodLabel } from '../../lib/productUtils'
import { premiumLines, policyBillablePremium, formatBillablePremium } from '../../lib/premium'
import { usePolicyholderScope } from '../../components/policyholder/usePolicyholderScope'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
  setActivePanel: (panel: ActivePanel) => void
}

// No .pill-waiting_period class exists — the bare .pill has no background,
// so a waiting-period policy rendered as an invisible tag. Amber "pending"
// is the closest honest state.
const STATUS_PILL: Partial<Record<PolicyStatus, string>> = {
  waiting_period: 'pill-pending',
}

export default function MyPolicies({ showToast, setActivePanel }: Props) {
  const { user } = useAuth()
  // Scoped by client/policy ID, not name — see usePolicyholderScope.
  const { policies: myPolicies, loading, error } = usePolicyholderScope()
  const [expandedId, setExpandedId] = useState<string | null>(null)

  useEffect(() => {
    if (error) showToast('error', error)
  }, [error, showToast])

  return (
    <div className="panel">
      <div className="info-banner info-banner-info" style={{ marginBottom: '1rem' }}>
        ℹ Welcome, {user?.name}! Your active policies and coverage details are shown below.
      </div>
      {loading ? (
        <div className="empty-state">Loading policies…</div>
      ) : error ? (
        <div className="empty-state">{error}</div>
      ) : myPolicies.length === 0 ? (
        <div className="empty-state">No policies found for your account. <button className="btn btn-primary btn-sm" onClick={() => setActivePanel('profile')}>Contact Us</button></div>
      ) : (
        <div className="products-grid">
          {myPolicies.map(p => {
            const category = p.productCategory ?? ''
            const lines = premiumLines(p, category)
            const expanded = expandedId === p.id
            return (
              <div key={p.id} className="product-card">
                <div className="product-card-header">
                  <div>
                    <div className="product-name">{p.productName}</div>
                    <div className="product-code mono">{p.policyNumber}</div>
                  </div>
                  <span className="status-pills">
                    <span className={`pill ${STATUS_PILL[p.status] ?? `pill-${p.status}`}`}>{p.status.replace('_', ' ')}</span>
                  </span>
                </div>
                <div className="product-stats">
                  <div className="product-stat">
                    <span className="product-stat-label">Premium</span>
                    {/* Billable total — every covered head, not just the
                        policyholder's own share (p.premium). */}
                    <span className="product-stat-value">{formatBillablePremium(p, category)}</span>
                  </div>
                  <div className="product-stat">
                    <span className="product-stat-label">Cover Amount</span>
                    <span className="product-stat-value">${p.coverAmount.toLocaleString()}</span>
                  </div>
                  <div className="product-stat">
                    <span className="product-stat-label">Start Date</span>
                    <span className="product-stat-value">{formatDate(p.startDate)}</span>
                  </div>
                  <div className="product-stat">
                    <span className="product-stat-label">Next Payment</span>
                    <span className="product-stat-value">{formatDate(p.nextPaymentDate)}</span>
                  </div>
                </div>
                <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setExpandedId(expanded ? null : p.id)}>
                  {expanded ? '▲ Hide details' : '▼ Who is covered & payment details'}
                </button>
                {expanded && (
                  <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div className="detail-label">Premium billed per person{premiumPeriodLabel(category)}</div>
                    {lines.map((l, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: '0.85rem' }}>
                        <span style={{ minWidth: 0 }}>
                          {l.name}
                          <span style={{ color: 'var(--muted)' }}> · {l.role === 'holder' ? 'policyholder' : l.planName}</span>
                        </span>
                        <span className="mono">${l.premium.toFixed(2)}</span>
                      </div>
                    ))}
                    {lines.length > 1 && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', fontWeight: 600, borderTop: '1px dashed var(--border)', paddingTop: 6 }}>
                        <span>Total</span>
                        <span className="mono">${policyBillablePremium(p, category).toFixed(2)}{premiumPeriodLabel(category)}</span>
                      </div>
                    )}
                    <div style={{ fontSize: '0.85rem', color: 'var(--muted)', marginTop: 4 }}>
                      Ends {formatDate(p.endDate)} · Payment via <strong>{p.paymentMethod}</strong>
                      {p.lastPaymentDate ? ` · Last paid ${formatDate(p.lastPaymentDate)}` : ''}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
