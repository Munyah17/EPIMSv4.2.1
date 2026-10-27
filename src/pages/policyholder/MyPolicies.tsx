import { useState, useEffect } from 'react'
import type { ToastMessage } from '../../types'
import type { ActivePanel } from '../../App'
import { formatDate } from '../../lib/dateUtils'
import type { PolicyStatus } from '../../types'
import { useAuth } from '../../contexts/AuthContext'
import { premiumPeriodLabel, categoryIssuesMemberCards } from '../../lib/productUtils'
import { premiumLines, policyBillablePremium, formatBillablePremium } from '../../lib/premium'
import { policyMembers } from '../../lib/memberNumbers'
import type { PolicyMember } from '../../lib/memberNumbers'
import { memberPhotoMap } from '../../lib/memberPhotos'
import PhotoEditorModal from '../../components/modals/PhotoEditorModal'
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
  const [photos, setPhotos] = useState<Map<string, string>>(new Map())
  const [photoMember, setPhotoMember] = useState<PolicyMember | null>(null)

  // Photo URLs for the expanded policy's members — loaded once alongside
  // the policies; member_photos is readable by any signed-in user, so a
  // policyholder sees their own family's photos without staff RLS.
  useEffect(() => {
    memberPhotoMap().then(setPhotos).catch(() => { /**/ })
  }, [myPolicies])

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
                    <div className="detail-label">Premium billed per person{premiumPeriodLabel(category, p.productName, p.paymentMethod)}</div>
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
                        <span className="mono">${policyBillablePremium(p, category).toFixed(2)}{premiumPeriodLabel(category, p.productName, p.paymentMethod)}</span>
                      </div>
                    )}
                    <div style={{ fontSize: '0.85rem', color: 'var(--muted)', marginTop: 4 }}>
                      {/* Monthly cover doesn't end on a date — it runs
                          while paid. Only agriculture has a season end. */}
                      {category === 'agriculture'
                        ? `Ends ${formatDate(p.endDate)}`
                        : `Paid up to ${formatDate(p.nextPaymentDate)}`}
                      {' '}· Payment via <strong>{p.paymentMethod}</strong>
                      {p.lastPaymentDate ? ` · Last paid ${formatDate(p.lastPaymentDate)}` : ''}
                    </div>

                    {categoryIssuesMemberCards(category) && (
                      <div style={{ marginTop: 10 }}>
                        <div className="detail-label" style={{ marginBottom: 6 }}>Card photos</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                          {policyMembers(p).map(m => {
                            const hasPhoto = photos.has(m.memberNumber)
                            return (
                              <div key={m.memberNumber} style={{ display: 'flex', alignItems: 'center', gap: 6, border: '1px solid var(--border)', borderRadius: 8, padding: '5px 9px', fontSize: '0.8rem' }}>
                                {hasPhoto && (
                                  <img src={photos.get(m.memberNumber)} alt="" crossOrigin="anonymous"
                                    style={{ width: 22, height: 28, objectFit: 'cover', borderRadius: 3 }} />
                                )}
                                <span style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name || m.memberNumber}</span>
                                <button type="button" className="btn btn-ghost btn-sm" style={{ padding: '2px 8px', fontSize: '0.75rem' }}
                                  onClick={() => setPhotoMember(m)}>
                                  📷 {hasPhoto ? 'Edit' : 'Add'}
                                </button>
                              </div>
                            )
                          })}
                        </div>
                        <div style={{ fontSize: '0.72rem', color: 'var(--muted)', marginTop: 6 }}>
                          The photo on each person's membership card. Our office can also take it for you if you visit.
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {photoMember && (
        <PhotoEditorModal
          member={photoMember}
          staffName={user?.name}
          onClose={() => setPhotoMember(null)}
          onSaved={(memberNumber, url) => {
            setPhotos(prev => new Map(prev).set(memberNumber, url))
          }}
          showToast={showToast}
        />
      )}
    </div>
  )
}
