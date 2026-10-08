import { useState, useEffect } from 'react'
import type { ActivePanel } from '../App'
import type { ToastMessage, Policy } from '../types'
import { db, type DashboardStats, type NotificationFailure } from '../lib/db'
import { formatPremium } from '../lib/productUtils'
import { formatDate } from '../lib/dateUtils'
import { useAuth } from '../contexts/AuthContext'
import { isStale, rateAgeLabel, type ExchangeRate } from '../lib/exchangeRate'
import { health } from '../lib/health'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
  setActivePanel: (panel: ActivePanel) => void
}

const CATEGORY_LABELS: Record<string, string> = {
  funeral: 'Funeral Cover',
  life: 'Life Cover',
  health: 'Hospital Cash',
  accident: 'Personal Accident',
  motor: 'Motor',
  property: 'Property',
  other: 'Other',
}

const CATEGORY_CLASS: Record<string, string> = {
  funeral: 'bar-fill-blue',
  life: 'bar-fill-teal',
  health: 'bar-fill-purple',
  accident: 'bar-fill-gold',
}

function timeAgo(iso: string | undefined): string {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return 'Just now'
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return formatDate(iso)
}

const EMPTY_STATS: DashboardStats = {
  activePolicies: 0, pendingClaims: 0, totalPremiums: 0, newLeads: 0, fraudAlerts: 0, lapseRate: 0, totalClients: 0,
  productBreakdown: [], recentPolicies: [], latestClaim: null, latestPayment: null, latestLead: null, latestFraud: null, latestClient: null,
}

export default function Dashboard({ setActivePanel }: Props) {
  const [stats, setStats] = useState<DashboardStats>(EMPTY_STATS)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [chartPeriod, setChartPeriod] = useState<'week' | 'month' | 'quarter'>('month')
  const [rate, setRate] = useState<ExchangeRate | null>(null)
  const [rateLoaded, setRateLoaded] = useState(false)

  useEffect(() => {
    db.dashboardStats.load()
      .then(({ data }) => { setStats(data); setLoading(false) })
      .catch(() => { setLoadError(true); setLoading(false) })
  }, [])

  const { user } = useAuth()
  const isSuperAdmin = user?.role === 'super_admin'
  // Admin-level at-a-glance system status — the same health tracker the
  // full System Health page reads, condensed to a dashboard strip.
  const canSeeHealth = user?.role === 'super_admin' || user?.role === 'admin'
  const [healthSnap, setHealthSnap] = useState(() => health.stats)
  useEffect(() => {
    if (!canSeeHealth) return
    return health.subscribe(() => setHealthSnap(health.stats))
  }, [canSeeHealth])

  // Failed notification deliveries (SMS/email/WhatsApp) in the last 24h —
  // the thing health.stats cannot see, since it only tracks DB reads and
  // writes. Sits next to the health strip so "100% but nobody got the
  // confirmation" is contradicted on the same screen.
  const [notifyFails, setNotifyFails] = useState<NotificationFailure[]>([])
  useEffect(() => {
    if (!canSeeHealth) return
    let cancelled = false
    const load = () => db.notificationLog.recentFailures(24).then(f => { if (!cancelled) setNotifyFails(f) }).catch(() => { /**/ })
    void load()
    const t = setInterval(load, 60000)
    return () => { cancelled = true; clearInterval(t) }
  }, [canSeeHealth])

  useEffect(() => {
    if (!isSuperAdmin) return
    // Only flag "no rate set" when the read actually succeeded — a failed
    // read says nothing about whether a rate exists, so it must not raise
    // the banner under a false claim.
    db.exchangeRates.current()
      .then(({ data, error }) => { if (!error) { setRate(data); setRateLoaded(true) } })
      .catch(() => { /**/ })
  }, [isSuperAdmin])

  const recentPolicies: Policy[] = stats.recentPolicies
  const maxCount = Math.max(...stats.productBreakdown.map(p => p.count), 1)

  const activity = [
    stats.latestClient && { icon: '👤', text: `New client registered: ${stats.latestClient.name}`, at: stats.latestClient.at, cls: 'activity-icon-purple' },
    recentPolicies[0] && { icon: '🛡', text: `New policy issued to ${recentPolicies[0].clientName}`, at: recentPolicies[0].createdAt, cls: 'activity-icon-blue' },
    stats.latestClaim && { icon: '📋', text: `Claim ${stats.latestClaim.claimNumber} submitted by ${stats.latestClaim.clientName}`, at: stats.latestClaim.at, cls: 'activity-icon-gold' },
    stats.latestPayment && { icon: '💳', text: `Payment received from ${stats.latestPayment.clientName}: $${stats.latestPayment.amount}`, at: stats.latestPayment.at, cls: 'activity-icon-teal' },
    stats.latestLead && { icon: '🎯', text: `New lead: ${stats.latestLead.name} via ${stats.latestLead.source}`, at: stats.latestLead.at, cls: 'activity-icon-purple' },
    stats.latestFraud && { icon: '⚠', text: `Fraud alert on claim ${stats.latestFraud.claimNumber}: Score ${stats.latestFraud.fraudScore}%`, at: stats.latestFraud.at, cls: 'activity-icon-danger' },
  ].filter(Boolean).map(a => ({ ...(a as { icon: string; text: string; at: string; cls: string }), time: timeAgo((a as { at: string }).at) }))
    .sort((a, b) => new Date(b.at || 0).getTime() - new Date(a.at || 0).getTime())

  if (loading) return <div className="panel"><div className="empty-state">Loading dashboard…</div></div>
  if (loadError) return <div className="panel"><div className="empty-state">Dashboard data could not be loaded. Check your connection and refresh.</div></div>

  const rateNeedsAttention = isSuperAdmin && rateLoaded && isStale(rate)

  return (
    <div className="panel">
      {rateNeedsAttention && (
        <div className="dash-alert" role="status">
          <span className="dash-alert-icon">💱</span>
          <div className="dash-alert-body">
            <span className="dash-alert-title">
              {rate ? 'The exchange rate is due for review' : 'No exchange rate is set'}
            </span>
            <span className="dash-alert-text">
              {rate
                ? `1 USD = ${rate.rate} ZiG, effective ${formatDate(rate.effectiveDate)}. ${rateAgeLabel(rate)}.`
                : 'ZiG payments are refused until a rate is set.'}
            </span>
          </div>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setActivePanel('settings')}>
            Update
          </button>
        </div>
      )}

      <div className="stats-grid">
        <div className="stat-card stat-card-clickable" onClick={() => setActivePanel('policies')}>
          <div className="stat-icon stat-icon-blue">🛡</div>
          <div className="stat-body">
            <div className="stat-value">{stats.activePolicies}</div>
            <div className="stat-label">Active Policies</div>
          </div>
        </div>
        <div className="stat-card stat-card-clickable" onClick={() => setActivePanel('clients')}>
          <div className="stat-icon stat-icon-purple">👥</div>
          <div className="stat-body">
            <div className="stat-value">{stats.totalClients}</div>
            <div className="stat-label">Total Clients</div>
          </div>
        </div>
        <div className="stat-card stat-card-clickable" onClick={() => setActivePanel('claims')}>
          <div className="stat-icon stat-icon-gold">📋</div>
          <div className="stat-body">
            <div className="stat-value">{stats.pendingClaims}</div>
            <div className="stat-label">Pending Claims</div>
            <div className="stat-delta negative">{stats.pendingClaims > 0 ? 'Requires attention' : 'All clear'}</div>
          </div>
        </div>
        <div className="stat-card stat-card-clickable" onClick={() => setActivePanel('payments')}>
          <div className="stat-icon stat-icon-teal">💳</div>
          <div className="stat-body">
            <div className="stat-value">${stats.totalPremiums.toFixed(0)}</div>
            <div className="stat-label">Premiums Collected</div>
            <div className="stat-delta positive">All time</div>
          </div>
        </div>
        <div className="stat-card stat-card-clickable" onClick={() => setActivePanel('leads')}>
          <div className="stat-icon stat-icon-purple">🎯</div>
          <div className="stat-body">
            <div className="stat-value">{stats.newLeads}</div>
            <div className="stat-label">New Leads</div>
            <div className="stat-delta positive">{stats.newLeads > 0 ? 'Awaiting follow-up' : 'All clear'}</div>
          </div>
        </div>
        <div className="stat-card stat-card-clickable" onClick={() => setActivePanel('fraud')}>
          <div className="stat-icon stat-icon-danger">⚠</div>
          <div className="stat-body">
            <div className="stat-value">{stats.fraudAlerts}</div>
            <div className="stat-label">Fraud Alerts</div>
            <div className="stat-delta negative">{stats.fraudAlerts > 0 ? 'Investigate now' : 'All clear'}</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon stat-icon-danger">📉</div>
          <div className="stat-body">
            <div className="stat-value">{stats.lapseRate}%</div>
            <div className="stat-label">Lapse Rate</div>
            <div className="stat-delta negative">Monitor closely</div>
          </div>
        </div>
      </div>

      {canSeeHealth && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-header">
            <h3 className="card-title">🖥 System Health</h3>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setActivePanel('system_health')}>Open System Health →</button>
          </div>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center', fontSize: 13 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
              <span className="syshealth-dot" style={{
                background: healthSnap.overall === 'healthy' ? '#10B981' : healthSnap.overall === 'degraded' ? '#F59E0B' : '#EF4444',
              }} />
              <strong>{healthSnap.overall.toUpperCase()}</strong>
            </span>
            <span style={{ color: 'var(--muted)' }}>Database: <strong style={{ color: 'var(--text)' }}>{healthSnap.sbConnected ? 'Connected' : 'Not connected'}</strong></span>
            <span style={{ color: 'var(--muted)' }}>Ops this session: <strong style={{ color: 'var(--text)' }}>{healthSnap.totalOps}</strong></span>
            <span style={{ color: 'var(--muted)' }}>Avg latency: <strong style={{ color: 'var(--text)' }}>{healthSnap.avgMs}ms</strong></span>
            <span style={{ color: 'var(--muted)' }}>Success: <strong style={{ color: 'var(--text)' }}>{healthSnap.sbSuccessPct}%</strong></span>
            {healthSnap.localMode && <span className="pill pill-warning pill-xs">Using cached data</span>}
            <span style={{ color: 'var(--muted)' }}>
              Notifications (24h): <strong style={{ color: notifyFails.length ? 'var(--danger)' : 'var(--text)' }}>{notifyFails.length === 0 ? 'all delivered' : `${notifyFails.length} failed`}</strong>
            </span>
          </div>
          {notifyFails.length > 0 && (
            <div className="info-banner info-banner-warning" style={{ marginTop: 12 }}>
              ⚠ {notifyFails.length} notification{notifyFails.length === 1 ? '' : 's'} failed to send in the last 24h.
              Latest: {notifyFails[0].channel} → {notifyFails[0].recipient}
              {notifyFails[0].ref ? ` (${notifyFails[0].ref})` : ''}
              {notifyFails[0].detail ? ` — ${notifyFails[0].detail.slice(0, 120)}` : ''}.
              Clients may not have received their confirmations — check the delivery log.
            </div>
          )}
        </div>
      )}

      <div className="dashboard-grid">
        <div className="card dashboard-card-wide">
          <div className="card-header">
            <h3 className="card-title">Recent Policies</h3>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setActivePanel('policies')}>View All</button>
          </div>
          <div className="tbl-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Policy No.</th>
                <th>Client</th>
                <th>Product</th>
                <th>Premium</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {recentPolicies.length === 0 ? (
                <tr><td colSpan={5} className="td-empty">No policies yet.</td></tr>
              ) : recentPolicies.map(p => (
                <tr key={p.id}>
                  <td><span className="mono">{p.policyNumber}</span></td>
                  <td>{p.clientName}</td>
                  <td>{p.productName}</td>
                  <td>{formatPremium(p.premium, p.productCategory ?? '')}</td>
                  <td><span className={`pill pill-${p.status}`}>{p.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Portfolio Mix</h3>
            <div className="chart-tabs">
              {(['week', 'month', 'quarter'] as const).map(p => (
                <button
                  type="button"
                  key={p}
                  className={`chart-tab${chartPeriod === p ? ' active' : ''}`}
                  onClick={() => setChartPeriod(p)}
                >{p}</button>
              ))}
            </div>
          </div>
          <div className="bar-chart">
            {stats.productBreakdown.map(pb => (
              <div key={pb.category} className="bar-item">
                <div className="bar-label">{CATEGORY_LABELS[pb.category] ?? pb.category}</div>
                <div className="bar-track">
                  <div
                    className={`bar-fill ${CATEGORY_CLASS[pb.category] ?? 'bar-fill-blue'}`}
                    style={{ width: `${(pb.count / maxCount) * 100}%` }}
                  />
                </div>
                <div className="bar-value">{pb.count}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Recent Activity</h3>
          </div>
          <div className="activity-list">
            {activity.map((a, i) => (
              <div key={i} className="activity-item">
                <div className={`activity-icon ${a.cls}`}>{a.icon}</div>
                <div className="activity-body">
                  <div className="activity-text">{a.text}</div>
                  <div className="activity-time">{a.time}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Quick Actions</h3>
          </div>
          <div className="quick-actions">
            <button type="button" className="btn btn-primary btn-full" onClick={() => setActivePanel('policies')}>
              🛡 New Policy
            </button>
            <button type="button" className="btn btn-secondary btn-full" onClick={() => setActivePanel('claims')}>
              📋 New Claim
            </button>
            <button type="button" className="btn btn-ghost btn-full" onClick={() => setActivePanel('clients')}>
              👥 Register Client
            </button>
            <button type="button" className="btn btn-ghost btn-full" onClick={() => setActivePanel('payments')}>
              💳 Record Payment
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
