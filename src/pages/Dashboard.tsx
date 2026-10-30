import { useState, useEffect } from 'react'
import type { ActivePanel } from '../App'
import type { ToastMessage, Policy } from '../types'
import { db, type DashboardStats, type NotificationFailure } from '../lib/db'
import { formatPremium } from '../lib/productUtils'
import { formatDate } from '../lib/dateUtils'
import { useAuth } from '../contexts/AuthContext'
import { isStale, rateAgeLabel, type ExchangeRate } from '../lib/exchangeRate'
import { health } from '../lib/health'
import { runSystemCheck, type SystemCheckResult } from '../lib/aiService'
import { supabase } from '../lib/supabase'
import { isGatewayFlaggedDown, getGatewayWatchStatus, pingSmsGateway, sendSms, SMS_GATEWAY_EVENT, restartSmsGateway, isSmsSafeMode, setSmsSafeMode, getSmsOutboxCount } from '../lib/smsService'

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
  totalPolicies: 0, activePolicies: 0, pendingClaims: 0, totalPremiums: 0, newLeads: 0, fraudAlerts: 0, lapseRate: 0, totalClients: 0,
  unpaidInvoices: 0, unpaidInvoiceAmount: 0,
  clientsNoPolicyCount: 0, clientsNoPolicy: [],
  productBreakdown: [], recentPolicies: [], latestClaim: null, latestPayment: null, latestLead: null, latestFraud: null, latestClient: null,
}

export default function Dashboard({ showToast, setActivePanel }: Props) {
  const [stats, setStats] = useState<DashboardStats>(EMPTY_STATS)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [chartPeriod, setChartPeriod] = useState<'week' | 'month' | 'quarter'>('month')
  const [rate, setRate] = useState<ExchangeRate | null>(null)
  const [rateLoaded, setRateLoaded] = useState(false)

  // Afrosoft outage banner — the background gateway watch flips this on
  // the moment a probe fails and off when it recovers. Persisted in
  // localStorage so a mid-outage refresh keeps the warning up; the flag
  // and the banner outlast the check that set them.
  const [gatewayDown, setGatewayDown] = useState<{ down: boolean; source?: string; reason?: string }>(() =>
    isGatewayFlaggedDown() ? { down: true } : { down: false })
  const [gatewayStatus, setGatewayStatus] = useState(() => getGatewayWatchStatus())
  const [smsTestNumber, setSmsTestNumber] = useState('')
  const [smsTestMessage, setSmsTestMessage] = useState('')
  const [smsTestSending, setSmsTestSending] = useState(false)
  const [smsRestarting, setSmsRestarting] = useState(false)
  const [smsSafeMode, setSmsSafeModeState] = useState(isSmsSafeMode())
  const [smsOutboxCount, setSmsOutboxCount] = useState(getSmsOutboxCount())
  useEffect(() => {
    const onStatus = (e: Event) => {
      setGatewayDown((e as CustomEvent<{ down: boolean; source?: string; reason?: string }>).detail)
      setGatewayStatus(getGatewayWatchStatus())
      // A live probe auto-exits Safe Mode — re-read it on every check so
      // the pill disappears the moment the gateway answers again.
      setSmsSafeModeState(isSmsSafeMode())
      setSmsOutboxCount(getSmsOutboxCount())
    }
    window.addEventListener(SMS_GATEWAY_EVENT, onStatus)
    return () => window.removeEventListener(SMS_GATEWAY_EVENT, onStatus)
  }, [])

  /**
   * "Restart the SMS server" — there is no process to bounce on a
   * serverless stack, so the button does the real equivalent: wipes the
   * outage flag and failure streak, probes the gateway live (warming the
   * function on the way), flushes queued texts, and stamps the SMS rows
   * in notification_log dismissed so the error board clears with the
   * restart. If the probe still fails the banner stays honestly up.
   */
  const handleRestartSms = async () => {
    setSmsRestarting(true)
    try {
      const ping = await restartSmsGateway()
      setGatewayStatus(getGatewayWatchStatus())
      await db.notificationLog.dismissFailures('sms')
      setNotifyFails(prev => prev.filter(f => f.channel !== 'sms'))
      setSmsOutboxCount(getSmsOutboxCount())
      setSmsSafeModeState(isSmsSafeMode())
      if (ping.up) {
        showToast('success', `SMS service restarted — the gateway is answering. ${ping.detail}`)
      } else {
        showToast('error', `Restart ran, but the gateway still isn't answering: ${ping.detail}`)
      }
    } finally {
      setSmsRestarting(false)
    }
  }

  /** Desperate-times switch: sends skip the broken primary route and go
   *  through the backup sender — the last path that still delivered.
   *  It ends itself when a probe confirms recovery. */
  const handleSafeMode = (on: boolean) => {
    setSmsSafeMode(on)
    setSmsSafeModeState(on)
    showToast(on ? 'warning' : 'info', on
      ? 'SMS Safe Mode ON — texts go via the backup sender now; anything that still fails queues and retries automatically. It switches off when the gateway recovers.'
      : 'SMS Safe Mode off — back to the normal route.')
  }

  /** On-demand proof + diagnosis — the send goes out over the real
   *  pipeline, and a failure is followed by a gateway ping so the answer
   *  names whose problem it is rather than just saying "failed". */
  const handleSmsTest = async () => {
    const to = smsTestNumber.trim()
    if (!to) { setGatewayStatus(g => ({ ...g, detail: 'Enter a number first — e.g. 0771234567.' })); return }
    setSmsTestSending(true)
    try {
      const body = smsTestMessage.trim()
        || `Motions: SMS gateway test — working as of ${new Date().toLocaleTimeString()}. Sent by ${user?.name ?? 'staff'} from the dashboard.`
      const result = await sendSms(to, body)
      if (result.success) {
        showToast('success', `Test SMS delivered to ${to} — Afrosoft confirmed it. Working end-to-end.`)
      } else {
        const ping = await pingSmsGateway()
        if (!ping.up && ping.source === 'afrosoft') {
          showToast('error', `⚠ AFROSOFT IS DOWN — the SMS provider cannot deliver text messages right now. This is NOT our system. (${ping.detail})`)
        } else if (!ping.up) {
          showToast('error', `⚠ The problem is on OUR side, not Afrosoft's — the gateway is reachable but our service failed. (${ping.detail})`)
        } else {
          showToast('error', `Afrosoft is UP and answering, but this send still failed — likely the number or message. (${result.error ?? 'no detail'})`)
        }
      }
    } finally {
      setSmsTestSending(false)
    }
  }

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
  const [clearing, setClearing] = useState(false)
  const [aiChecking, setAiChecking] = useState(false)
  const [aiCheck, setAiCheck] = useState<SystemCheckResult | null>(null)
  interface ReconAlert { kind: string; ref: string; label: string }
  const [reconAlerts, setReconAlerts] = useState<ReconAlert[]>([])
  // Website manual payments (bank transfer / EcoCash merchant pay) waiting
  // for a staff member to sight the money — nothing automated confirms them.
  const [pendingVerifs, setPendingVerifs] = useState(0)
  const canSeeVerifications = ['super_admin', 'admin', 'finance', 'policy_admin'].includes(user?.role ?? '')
  const [reconClearing, setReconClearing] = useState(false)
  // The reconciliation alerts from System Health, on the dashboard so
  // they're impossible to miss — admin/finance only, silently absent
  // for other roles (the endpoint answers 403).
  const loadRecon = async () => {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return
    const res = await fetch('/api/admin-recon', { headers: { Authorization: `Bearer ${session.access_token}` } })
    if (!res.ok) return
    const r = await res.json()
    setReconAlerts([
      ...(r.orphanedClients ?? []).map((c: { id: string; name: string; phone: string | null; createdAt: string }) =>
        ({ kind: 'orphaned_client', ref: c.id, label: `👤 Client ${c.name} (${c.phone ?? 'no phone'}, registered ${new Date(c.createdAt).toLocaleDateString('en-GB')}) has no policy — payment may have been taken with no cover written.` })),
      ...(r.stalePaynow ?? []).map((t: { reference: string; amount: number; currency: string }) =>
        ({ kind: 'stale_paynow', ref: t.reference, label: `💳 Paynow ref ${t.reference} (${t.currency} $${Number(t.amount).toFixed(2)}) never confirmed — check the gateway, reconcile with the payer.` })),
      ...(r.paidButPending ?? []).map((p: { id: string; policyNumber: string; clientName: string }) =>
        ({ kind: 'paid_but_pending', ref: p.id, label: `📄 Policy ${p.policyNumber} (${p.clientName}) has a completed payment but is still pending — activate or refund.` })),
    ])
  }

  // Dismissal is acknowledgement, not deletion — the rows keep their
  // truth; new unmatched items still alert.
  const dismissRecon = async (items: { kind: string; ref: string }[]) => {
    setReconClearing(true)
    const { data: { session } } = await supabase.auth.getSession()
    await fetch('/api/admin-recon', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}) },
      body: JSON.stringify({ items }),
    }).catch(() => { /**/ })
    setReconAlerts(prev => prev.filter(a => !items.some(i => i.kind === a.kind && i.ref === a.ref)))
    setReconClearing(false)
  }

  useEffect(() => {
    if (!canSeeHealth) return
    let cancelled = false
    const load = () => db.notificationLog.recentFailures(24).then(f => { if (!cancelled) setNotifyFails(f) }).catch(() => { /**/ })
    void load()
    void loadRecon()
    const t = setInterval(() => { void load(); void loadRecon() }, 60000)
    return () => { cancelled = true; clearInterval(t) }
  }, [canSeeHealth])

  useEffect(() => {
    if (!canSeeVerifications) return
    let cancelled = false
    const loadVerifs = () => supabase.from('checkout_sessions').select('*', { count: 'exact', head: true })
      .eq('status', 'pending_verification')
      .then(r => { if (!cancelled) setPendingVerifs(r.count ?? 0) })
    void loadVerifs()
    const t = setInterval(loadVerifs, 60000)
    return () => { cancelled = true; clearInterval(t) }
  }, [canSeeVerifications])

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
      {gatewayDown.down && (
        // Big, unmissable, and names whose problem it is — staff answering
        // a "my text never came" call need to know in one glance that it
        // is the SMS provider, not this system.
        <div className="dash-alert" role="alert"
          style={{ background: '#FEE2E2', border: '2px solid #DC2626', borderRadius: 10, padding: '16px 20px', marginBottom: 18 }}>
          <span className="dash-alert-icon" style={{ fontSize: 26 }}>📵</span>
          <div className="dash-alert-body">
            <span className="dash-alert-title" style={{ fontSize: 16, fontWeight: 800, color: '#991B1B' }}>
              {gatewayDown.source === 'us' || gatewayDown.source === 'config'
                ? 'SMS SERVICE PROBLEM — ON OUR SIDE, NOT AFROSOFT'
                : 'AFROSOFT SMS IS DOWN — TEXT MESSAGES CANNOT BE DELIVERED'}
            </span>
            <span className="dash-alert-text" style={{ fontSize: 13, color: '#7F1D1D' }}>
              {gatewayDown.reason ?? 'The SMS gateway is unreachable.'} Signup welcomes, payment confirmations and billing
              reminders will not reach clients by SMS until it recovers. The office has been emailed.
            </span>
          </div>
        </div>
      )}
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
        {/* Every policy row on the system whatever its status — the
            denominator for the whole book. Active Policies sits below
            this precisely because waiting-period, lapsed and expired
            cover aren't "active"; without this card that gap reads as a
            reconciliation error instead of a lifecycle. */}
        <div className="stat-card stat-card-clickable" onClick={() => setActivePanel('policies')}>
          <div className="stat-icon stat-icon-blue">🗂</div>
          <div className="stat-body">
            <div className="stat-value">{stats.totalPolicies}</div>
            <div className="stat-label">Total Policies</div>
            <div className="stat-delta positive">All statuses</div>
          </div>
        </div>
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
        {/* Abandoned signups — clients registered but holding no policy
            at all, almost always a website/agent signup whose checkout
            was never completed (no payment can exist without a policy).
            Clicking opens the abandoned-signups list, not the leads page. */}
        <div className="stat-card stat-card-clickable" onClick={() => setActivePanel('clients_no_policy')}>
          <div className="stat-icon stat-icon-danger">👤</div>
          <div className="stat-body">
            <div className="stat-value">{stats.clientsNoPolicyCount}</div>
            <div className="stat-label">Abandoned Signups</div>
            <div className={stats.clientsNoPolicyCount > 0 ? 'stat-delta negative' : 'stat-delta positive'}>
              {stats.clientsNoPolicyCount > 0 ? 'Payment never completed' : 'All covered'}
            </div>
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
        {/* Money billed but not yet collected — the invoice count and the
            dollar figure both matter, and both want chasing when non-zero. */}
        <div className="stat-card stat-card-clickable" onClick={() => setActivePanel('billing_reminders')}>
          <div className="stat-icon stat-icon-gold">🧾</div>
          <div className="stat-body">
            <div className="stat-value">{stats.unpaidInvoices}</div>
            <div className="stat-label">Unpaid Invoices</div>
            <div className={stats.unpaidInvoices > 0 ? 'stat-delta negative' : 'stat-delta positive'}>
              {stats.unpaidInvoices > 0 ? `$${stats.unpaidInvoiceAmount.toFixed(2)} outstanding` : 'All collected'}
            </div>
          </div>
        </div>
      </div>

      {/* Abandoned-signup notice — names up to 5 of them so the
          discrepancy is impossible to scroll past; View All opens the
          full list of signups that never completed. */}
      {stats.clientsNoPolicyCount > 0 && (
        <div className="info-banner info-banner-warning" style={{ marginBottom: 20, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ flex: 1 }}>
            ⚠ {stats.clientsNoPolicyCount} abandoned signup{stats.clientsNoPolicyCount === 1 ? '' : 's'} —
            {stats.clientsNoPolicyCount === 1 ? ' a client' : ' clients'} registered but never completed payment, so no cover exists under {stats.clientsNoPolicyCount === 1 ? 'their name' : 'their names'}.
            {stats.clientsNoPolicy.length > 0 && (
              <> {stats.clientsNoPolicy.map(c => c.name).join(', ')}
                {stats.clientsNoPolicyCount > stats.clientsNoPolicy.length && ` and ${stats.clientsNoPolicyCount - stats.clientsNoPolicy.length} more`}.
              </>
            )}
            {' '}No money was taken — follow up to convert them, or confirm the registration itself is wrong.
          </span>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setActivePanel('clients_no_policy')}>View All</button>
        </div>
      )}

      {canSeeHealth && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-header">
            <h3 className="card-title">🖥 System Health</h3>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn btn-ghost btn-sm" disabled={aiChecking}
                onClick={async () => {
                  setAiChecking(true)
                  try {
                    setAiCheck(await runSystemCheck({
                      totalOps: healthSnap.totalOps, sbSuccessPct: healthSnap.sbSuccessPct, localMode: healthSnap.localMode,
                    }))
                  } catch (e) {
                    showToast('error', e instanceof Error ? e.message : 'System check failed.')
                  }
                  setAiChecking(false)
                }}>
                {aiChecking ? 'Checking…' : '🤖 AI System Check'}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setActivePanel('system_health')}>Open System Health →</button>
            </div>
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
            <div className="info-banner info-banner-warning" style={{ marginTop: 12, display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <span style={{ flex: 1 }}>
                ⚠ {notifyFails.length} notification{notifyFails.length === 1 ? '' : 's'} failed to send in the last 24h.
                Latest: {notifyFails[0].channel} → {notifyFails[0].recipient}
                {notifyFails[0].ref ? ` (${notifyFails[0].ref})` : ''}
                {notifyFails[0].detail ? ` — ${notifyFails[0].detail.slice(0, 120)}` : ''}.
                Clients may not have received their confirmations — check the delivery log.
              </span>
              {/* Cleared failures keep their 'failed' row in the delivery
                  log — this only stops them re-raising the banner. New
                  failures after the clear still alert. */}
              <button type="button" className="btn btn-ghost btn-sm" disabled={clearing}
                onClick={async () => {
                  setClearing(true)
                  const { error } = await db.notificationLog.dismissFailures()
                  setClearing(false)
                  if (error) { showToast('error', error); return }
                  setNotifyFails([])
                  showToast('info', 'Notification failures cleared — new ones will still alert.')
                }}>
                {clearing ? 'Clearing…' : 'Clear'}
              </button>
            </div>
          )}

          {pendingVerifs > 0 && (
            <div className="info-banner info-banner-warning" style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ flex: 1 }}>
                🧾 {pendingVerifs} website payment{pendingVerifs === 1 ? '' : 's'} (bank transfer / EcoCash merchant pay) await{pendingVerifs === 1 ? 's' : ''} manual verification — review the proof of payment before registering cover.
              </span>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setActivePanel('payment_verifications')}>Review</button>
            </div>
          )}

          {/* Unreconciled records — the same alerts System Health shows,
              front and centre on the dashboard. Dismissal is
              acknowledgement, not deletion; new items still alert. */}
          {reconAlerts.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <div style={{ fontSize: 12, color: 'var(--danger)', fontWeight: 700 }}>
                  ⚖ Unreconciled records — investigate before close of day
                </div>
                <button type="button" className="btn btn-ghost btn-sm" disabled={reconClearing}
                  onClick={() => void dismissRecon(reconAlerts.map(a => ({ kind: a.kind, ref: a.ref })))}>
                  {reconClearing ? 'Clearing…' : 'Clear all'}
                </button>
              </div>
              {reconAlerts.map(a => (
                <div key={`${a.kind}:${a.ref}`} className="info-banner info-banner-danger"
                  style={{ marginBottom: 6, fontSize: 12, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  <span style={{ flex: 1 }}>{a.label}</span>
                  <button type="button" className="btn btn-ghost btn-sm" style={{ padding: '0 6px' }} title="Acknowledge — stop alerting on this"
                    onClick={() => void dismissRecon([{ kind: a.kind, ref: a.ref }])}>✕</button>
                </div>
              ))}
            </div>
          )}

          {/* AI System Check — deterministic probes server-side + Groq
              interpretation. Fixes already applied are listed first. */}
          {aiCheck && (
            <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
              <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 12, marginBottom: 10 }}>
                {aiCheck.checks.map(c => (
                  <span key={c.key} style={{ color: 'var(--muted)' }}>
                    <span className="syshealth-dot" style={{ display: 'inline-block', marginRight: 6, background: c.status === 'ok' ? '#10B981' : c.status === 'warning' ? '#F59E0B' : '#EF4444' }} />
                    {c.label}: <strong style={{ color: c.status === 'ok' ? 'var(--text)' : c.status === 'warning' ? '#92400E' : 'var(--danger)' }}>{c.detail}</strong>
                  </span>
                ))}
              </div>
              {aiCheck.fixed.length > 0 && (
                <div className="info-banner info-banner-info" style={{ fontSize: 12, marginBottom: 8 }}>
                  ✅ <strong>Fixed automatically:</strong> {aiCheck.fixed.join(' ')}
                </div>
              )}
              <div style={{ fontSize: 13, marginBottom: aiCheck.ai.findings?.length ? 8 : 0 }}>
                {aiCheck.ai.simulated && <span className="pill pill-warning pill-xs" style={{ marginRight: 6 }}>AI unavailable — raw results</span>}
                {aiCheck.ai.summary}
              </div>
              {(aiCheck.ai.findings ?? []).map((f, i) => (
                <div key={i} className={`info-banner ${f.severity === 'critical' ? 'info-banner-danger' : 'info-banner-warning'}`} style={{ fontSize: 12, marginBottom: 6 }}>
                  <strong>{f.area}:</strong> {f.problem} <em>→ {f.recommendation}</em>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* SMS gateway instrument panel — the thing that answers "is it us
          or Afrosoft?" in one glance, with a live probe on demand. */}
      {canSeeHealth && (
        <div className="card" style={{
          marginBottom: 20,
          borderLeft: `4px solid ${gatewayStatus.state === 'up' ? '#10B981' : gatewayStatus.state === 'down' ? '#EF4444' : '#94A3B8'}`,
        }}>
          <div className="card-header">
            <h3 className="card-title">📱 SMS Gateway — Afrosoft</h3>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button type="button" className="btn btn-primary btn-sm" disabled={smsRestarting}
                onClick={() => void handleRestartSms()}
                title="Reset the gateway watch, probe Afrosoft now, flush queued texts and clear SMS errors">
                {smsRestarting ? 'Restarting…' : '🔄 Restart SMS Server'}
              </button>
              {smsSafeMode ? (
                <button type="button" className="btn btn-ghost btn-sm" style={{ color: '#92400E', borderColor: '#F59E0B' }}
                  onClick={() => handleSafeMode(false)}
                  title="Leave Safe Mode — sends return to the normal route">
                  🛟 Exit Safe Mode
                </button>
              ) : (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => handleSafeMode(true)}
                  title="Desperate times: send everything through the backup sender and queue failures — the last working behaviour. Ends itself when the gateway recovers.">
                  Safe Mode
                </button>
              )}
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setActivePanel('mass_messaging')}>Mass Messaging →</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setActivePanel('system_health')}>System Health →</button>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
            <span className="syshealth-dot lg" style={{
              background: gatewayStatus.state === 'up' ? '#10B981' : gatewayStatus.state === 'down' ? '#EF4444' : '#94A3B8',
            }} />
            <div>
              <div style={{
                fontSize: 17, fontWeight: 800, letterSpacing: 0.3,
                color: gatewayStatus.state === 'up' ? '#065f46' : gatewayStatus.state === 'down' ? '#991B1B' : 'var(--muted)',
              }}>
                {smsSafeMode ? 'SAFE MODE — SENDING VIA THE BACKUP ROUTE'
                  : gatewayStatus.state === 'up' ? 'OPERATIONAL — TEXT MESSAGES DELIVERING'
                  : gatewayStatus.state === 'down'
                    ? (gatewayStatus.source === 'afrosoft' ? 'DOWN — AFROSOFT CANNOT DELIVER TEXTS' : 'PROBLEM ON OUR SIDE — NOT AFROSOFT')
                    : gatewayStatus.state === 'dev'
                      ? 'DEV SERVER — TEXTS GO OUT FROM THE LIVE PORTAL'
                      : 'CHECKING…'}
              </div>
              {smsSafeMode && (
                <div style={{ fontSize: 11, color: '#92400E', marginTop: 2 }}>
                  The primary route is being skipped — texts go out via the backup sender, failures queue and retry. Ends automatically when the gateway answers again.
                </div>
              )}
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                {gatewayStatus.checkedAt
                  ? `Last probe ${timeAgo(new Date(gatewayStatus.checkedAt).toISOString())} · auto-checks every 5 min, no SMS spent`
                  : 'First automatic check runs shortly after sign-in.'}
              </div>
            </div>
          </div>

          {(gatewayStatus.state === 'down' || gatewayStatus.state === 'dev') && gatewayStatus.detail && (
            <div className={`info-banner ${gatewayStatus.state === 'dev' ? 'info-banner-warning' : 'info-banner-danger'}`} style={{ marginBottom: 14, fontSize: 12, display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <span style={{ flex: 1 }}>{gatewayStatus.detail}</span>
              {gatewayStatus.state === 'down' && !smsSafeMode && (
                <button type="button" className="btn btn-ghost btn-sm" style={{ flexShrink: 0 }}
                  onClick={() => handleSafeMode(true)}
                  title="Send everything through the backup sender until the gateway recovers">
                  Still down? Try Safe Mode
                </button>
              )}
            </div>
          )}

          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 13, marginBottom: 14, color: 'var(--muted)' }}>
            <span>Sends this session: <strong style={{ color: 'var(--text)' }}>{healthSnap.smsOpsCount ?? 0}</strong></span>
            <span>Delivery rate: <strong style={{ color: (healthSnap.smsOpsCount ?? 0) > 0 && healthSnap.smsLastOk === false ? 'var(--danger)' : 'var(--text)' }}>
              {(healthSnap.smsOpsCount ?? 0) > 0 ? `${healthSnap.smsSuccessPct}%` : '—'}
            </strong></span>
            <span>Last send: <strong style={{ color: healthSnap.smsLastOk === false ? 'var(--danger)' : 'var(--text)' }}>
              {healthSnap.smsLastOk === null || healthSnap.smsLastOk === undefined ? 'none yet' : healthSnap.smsLastOk ? 'delivered ✓' : 'failed ✗'}
            </strong></span>
            <span>Queued texts: <strong style={{ color: smsOutboxCount > 0 ? '#92400E' : 'var(--text)' }}>{smsOutboxCount === 0 ? 'none' : `${smsOutboxCount} retrying`}</strong></span>
          </div>
          {healthSnap.smsLastOk === false && healthSnap.smsLastDetail && (
            <div style={{ fontSize: 12, color: 'var(--danger)', marginTop: -8, marginBottom: 14 }}>
              {healthSnap.smsLastDetail}
            </div>
          )}

          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                className="form-control"
                style={{ fontSize: 12, padding: '6px 10px', width: 160 }}
                placeholder="To… 0771234567"
                value={smsTestNumber}
                onChange={e => setSmsTestNumber(e.target.value)}
              />
              <input
                className="form-control"
                style={{ fontSize: 12, padding: '6px 10px', flex: 1, minWidth: 220 }}
                placeholder="Message (optional — leave blank for the standard test text)"
                value={smsTestMessage}
                onChange={e => setSmsTestMessage(e.target.value)}
                maxLength={480}
              />
              <button type="button" className="btn btn-primary btn-sm" onClick={handleSmsTest} disabled={smsTestSending}>
                {smsTestSending ? 'Sending…' : '📱 Send Test SMS'}
              </button>
            </div>
            <span style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginTop: 6 }}>
              A real text through Afrosoft — if it fails we'll tell you whose side the problem is on.
            </span>
          </div>
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
                  <td>{formatPremium(p.premium, p.productCategory ?? '', p.productName, p.paymentMethod)}</td>
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
