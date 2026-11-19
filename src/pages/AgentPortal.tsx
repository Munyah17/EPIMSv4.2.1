import { useEffect, useState } from 'react'
import type { AgentProfile, ToastMessage } from '../types'
import { db } from '../lib/db'
import { useAuth } from '../contexts/AuthContext'
import { agentReferralLink, copyAgentReferralLink } from '../lib/agentReferrals'
import { formatDate } from '../lib/dateUtils'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
}

/** The field-agent home: the persistent recruitment link, contract file and
 *  book of business. Agents sign in through the client portal URL, but this
 *  view remains distinct from policyholder cover pages. */
export default function AgentPortal({ showToast }: Props) {
  const { user } = useAuth()
  const [profile, setProfile] = useState<AgentProfile | null>(null)
  const [stats, setStats] = useState<{ clients: number; policies: number; premium: number } | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (user?.role !== 'agent') { setLoading(false); return }
    let cancelled = false
    void Promise.all([
      db.agentProfiles.get(user.id),
      db.agentProfiles.bookStats([user.id]),
    ]).then(([profileResult, statsResult]) => {
      if (cancelled) return
      if (profileResult.data) setProfile(profileResult.data)
      if (statsResult.error) showToast('warning', statsResult.error)
      else setStats(statsResult.data.get(user.id) ?? { clients: 0, policies: 0, premium: 0 })
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [showToast, user])

  if (user?.role !== 'agent') {
    return <div className="panel"><div className="empty-state">This page is for field-agent accounts.</div></div>
  }
  if (loading) return <div className="panel"><div className="empty-state">Loading agent portal…</div></div>

  const link = agentReferralLink(profile?.referralCode)

  return (
    <div className="panel">
      <div className="card" style={{ borderLeft: '4px solid var(--primary)' }}>
        <div className="card-header">
          <div>
            <h3 style={{ fontSize: '1.05rem', fontWeight: 700 }}>Your Referral Link</h3>
            <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 4 }}>
              Share this permanent link when recruiting clients. Website applications completed through it are credited to your book.
            </p>
          </div>
        </div>
        {link ? (
          <>
            <div className="form-group">
              <input className="form-control" value={link} readOnly onFocus={e => e.currentTarget.select()} />
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-primary" onClick={async () => {
                await copyAgentReferralLink(profile?.referralCode)
                showToast('success', 'Referral link copied.')
              }}>
                Copy Link
              </button>
              <a className="btn btn-ghost" href={link} target="_blank" rel="noreferrer">Open Public Application</a>
            </div>
          </>
        ) : (
          <div className="info-banner info-banner-warning">
            Your referral link has not been issued yet. Contact the office so they can backfill the agent register.
          </div>
        )}
      </div>

      <div className="stats-grid" style={{ marginTop: 16 }}>
        <div className="stat-card"><div className="stat-body"><div className="stat-value">{stats?.clients ?? 0}</div><div className="stat-label">Clients Referred</div></div></div>
        <div className="stat-card"><div className="stat-body"><div className="stat-value">{stats?.policies ?? 0}</div><div className="stat-label">Policies Attributed</div></div></div>
        <div className="stat-card"><div className="stat-body"><div className="stat-value">${(stats?.premium ?? 0).toFixed(2)}</div><div className="stat-label">Monthly Premium Book</div></div></div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: 12 }}>Agent File</h3>
        <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
          <div className="stat-card"><div className="stat-body"><div className="stat-value" style={{ fontSize: 16 }}>{profile?.referralCode ?? '—'}</div><div className="stat-label">Referral Code</div></div></div>
          <div className="stat-card"><div className="stat-body"><div className="stat-value" style={{ fontSize: 16 }}>{profile?.territory ?? '—'}</div><div className="stat-label">Territory</div></div></div>
          <div className="stat-card"><div className="stat-body"><div className="stat-value" style={{ fontSize: 16 }}>{profile?.contractStart ? formatDate(profile.contractStart) : '—'}</div><div className="stat-label">Contract Start</div></div></div>
          <div className="stat-card"><div className="stat-body"><div className="stat-value" style={{ fontSize: 16 }}>{profile?.commissionPct != null ? `${profile.commissionPct}%` : 'Product default'}</div><div className="stat-label">Commission</div></div></div>
        </div>
      </div>
    </div>
  )
}
