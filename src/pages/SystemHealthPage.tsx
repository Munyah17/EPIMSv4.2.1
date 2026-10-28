import { useEffect, useRef, useState } from 'react'
import { health } from '../lib/health'
import type { DbOp } from '../lib/health'
import { db, type NotificationFailure } from '../lib/db'
import { sendSms, pingSmsGateway } from '../lib/smsService'
import { supabase } from '../lib/supabase'
import { runSystemCheck, type SystemCheckResult, type SystemCheckFix } from '../lib/aiService'
import { useAuth } from '../contexts/AuthContext'

interface ReconData {
  orphanedClients: { id: string; name: string; phone: string | null; createdAt: string }[]
  stalePaynow: { reference: string; amount: number; currency: string; createdAt: string }[]
  paidButPending: { id: string; policyNumber: string; clientName: string }[]
  checkedAt: string
}
import type { ToastMessage } from '../types'
import type { ActivePanel } from '../App'

const QUOTA_ALERT_PATTERN = /rate.?limit|429|quota|expired|401|403|unauthorized|jwt/i

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
  setActivePanel: (panel: ActivePanel) => void
}

interface Stats {
  uptime: number
  totalOps: number
  sbConnected: boolean
  sbSuccessPct: number
  readSuccessPct: number
  writeSuccessPct: number
  avgMs: number
  overall: 'healthy' | 'degraded' | 'offline'
  localMode: boolean
  smsOpsCount: number
  smsSuccessPct: number
  smsLastOk: boolean | null
  smsLastDetail: string | null
  recent: DbOp[]
}

const STATUS_COLOR: Record<string, string> = {
  healthy: '#10B981',
  degraded: '#F59E0B',
  offline: '#EF4444',
}

const STATUS_BG: Record<string, string> = {
  healthy: '#D1FAE5',
  degraded: '#FEF3C7',
  offline: '#FEE2E2',
}

const STATUS_TEXT: Record<string, string> = {
  healthy: '#065f46',
  degraded: '#92400e',
  offline: '#991b1b',
}

const OP_COLOR: Record<string, string> = {
  read: '#5B7FE8',
  write: '#10B981',
  delete: '#EF4444',
  notify: '#A855F7',
}

function fmtUptime(ms: number) {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}

function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function MetricBar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="sh-metric">
      <div className="sh-metric-row">
        <span className="sh-metric-label">{label}</span>
        <span className="sh-metric-pct" style={{ color }}>{value}%</span>
      </div>
      <div className="sh-metric-track">
        <div className="sh-metric-fill" style={{ width: `${value}%`, background: color }} />
      </div>
    </div>
  )
}

export default function SystemHealthPage({ showToast }: Props) {
  const { user } = useAuth()
  const [stats, setStats] = useState<Stats>(() => health.stats as Stats)
  const [tab, setTab] = useState<'overview' | 'log' | 'delivery'>('overview')
  const [dlRows, setDlRows] = useState<NotificationFailure[]>([])
  const [dlLoading, setDlLoading] = useState(false)
  const [dlLoadedOnce, setDlLoadedOnce] = useState(false)
  const [dlChannel, setDlChannel] = useState('')
  const [dlStatus, setDlStatus] = useState('')
  const [dlText, setDlText] = useState('')
  const [dlFrom, setDlFrom] = useState('')
  const [dlTo, setDlTo] = useState('')
  const [ticker, setTicker] = useState(0)
  const [failedLogins, setFailedLogins] = useState<{ email: string; count: number; lastAttempt: string }[]>([])
  const [testNumber, setTestNumber] = useState('')
  const [testMessage, setTestMessage] = useState('')
  const [testSending, setTestSending] = useState(false)
  const [websiteLink, setWebsiteLink] = useState<{ ok: boolean | null; detail: string }>({ ok: null, detail: 'Checking…' })
  const [recon, setRecon] = useState<ReconData | null>(null)
  const [dismissing, setDismissing] = useState(false)
  const [aiChecking, setAiChecking] = useState(false)
  const [aiCheck, setAiCheck] = useState<SystemCheckResult | null>(null)
  const [fixLog, setFixLog] = useState<SystemCheckFix[]>([])
  const logRef = useRef<HTMLDivElement>(null)

  // The same three checks the daily cron emails about — live, so a
  // paid-but-unregistered signup shows within a minute, not overnight.
  const loadRecon = async () => {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return
    fetch('/api/admin-recon', { headers: { Authorization: `Bearer ${session.access_token}` } })
      .then(async res => setRecon(res.ok ? await res.json() : null))
      .catch(() => { /* card just stays at its last value */ })
  }

  // Acknowledge recon items — server-stamped, shared, truth-preserving.
  // The underlying rows keep their status; only new unmatched items alert.
  const dismissRecon = async (items: { kind: string; ref: string }[]) => {
    setDismissing(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/api/admin-recon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}) },
        body: JSON.stringify({ items }),
      })
      if (!res.ok) { const b = await res.json().catch(() => null); showToast('error', b?.error ?? 'Could not clear the items.') }
      else { showToast('success', `${items.length} item${items.length === 1 ? '' : 's'} acknowledged — new issues still alert.`); void loadRecon() }
    } catch (e) {
      showToast('error', `Could not clear the items: ${e}`)
    }
    setDismissing(false)
  }

  // Run Check probes; Apply Fixes repairs the whitelisted items and
  // logs each repair in system_fixes (the log renders below the card).
  const runCheck = async (apply: boolean) => {
    setAiChecking(true)
    try {
      const result = await runSystemCheck({
        totalOps: stats.totalOps, sbSuccessPct: stats.sbSuccessPct, localMode: stats.localMode,
      }, apply)
      setAiCheck(result)
      if (result.fixLog) setFixLog(result.fixLog)
      if (apply && result.fixed.length) showToast('success', `${result.fixed.length} fix${result.fixed.length === 1 ? '' : 'es'} applied — see the log below.`)
    } catch (e) {
      showToast('error', e instanceof Error ? e.message : 'System check failed.')
    }
    setAiChecking(false)
  }

  useEffect(() => {
    const unsub = health.subscribe(() => setStats(health.stats as Stats))
    const interval = setInterval(() => setTicker(t => t + 1), 1000)
    const loadSecurity = () => { db.loginAttempts.recentFailures(15).then(({ data }) => setFailedLogins(data)) }
    loadSecurity()
    const secInterval = setInterval(loadSecurity, 30000)
    // The link motions.co.zw depends on: the same endpoint the website
    // itself pings before a registration, so this row shows exactly the
    // connectivity their signup flow sees — not a lookalike check.
    const checkWebsiteLink = () => {
      fetch('/api/health-check').then(async res => {
        const body = await res.json().catch(() => null) as { ok?: boolean; db?: boolean; detail?: string } | null
        if (body === null) return setWebsiteLink({ ok: false, detail: 'Health endpoint returned a page, not a response.' })
        setWebsiteLink({ ok: !!body.ok, detail: body.detail ?? (body.ok ? 'Portal and database reachable' : 'Unreachable') })
      }).catch(e => setWebsiteLink({ ok: false, detail: `Could not reach the portal: ${e}` }))
    }
    checkWebsiteLink()
    const linkInterval = setInterval(checkWebsiteLink, 60000)
    void loadRecon()
    const reconInterval = setInterval(() => void loadRecon(), 60000)
    // What the checker has repaired lately — the log a senior person
    // reviews after a support call ran the auto-fixer.
    supabase.from('system_fixes').select('kind, detail, records, applied_at')
      .order('applied_at', { ascending: false }).limit(10)
      .then(({ data }) => setFixLog((data ?? []) as SystemCheckFix[]))
    return () => { unsub(); clearInterval(interval); clearInterval(secInterval); clearInterval(linkInterval); clearInterval(reconInterval) }
  }, [])

  // silence the ticker lint
  void ticker

  const dot = STATUS_COLOR[stats.overall]

  const quotaAlerts = stats.recent.filter(op => !op.success && op.detail && QUOTA_ALERT_PATTERN.test(op.detail))
  const BRUTE_FORCE_THRESHOLD = 5
  const suspiciousLogins = failedLogins.filter(f => f.count >= BRUTE_FORCE_THRESHOLD)

  const handleReset = () => {
    health.reset()
    showToast('info', 'Health tracker stats cleared.')
  }

  /** Server-side delivery log — every notification attempt recorded in
   *  notification_log, filterable by recipient/detail/date. This is the
   *  log support uses to answer "the client never got the text" — it
   *  keeps rows for every channel and status, not just this browser's
   *  session ops. */
  const loadDeliveryLog = async () => {
    setDlLoading(true)
    const rows = await db.notificationLog.search({
      channel: dlChannel || undefined,
      status: dlStatus || undefined,
      text: dlText || undefined,
      from: dlFrom ? new Date(`${dlFrom}T00:00:00`).toISOString() : undefined,
      to: dlTo ? new Date(`${dlTo}T23:59:59.999`).toISOString() : undefined,
      limit: 300,
    })
    setDlRows(rows)
    setDlLoadedOnce(true)
    setDlLoading(false)
  }

  /** Proof, not hope: a real Afrosoft round-trip on demand — and a
   *  diagnosis. A failed send alone doesn't say WHO is broken, so the
   *  button follows up with a gateway ping and names the culprit in
   *  plain terms: Afrosoft's system vs ours. */
  const handleTestSms = async () => {
    const to = testNumber.trim()
    if (!to) { showToast('warning', 'Enter the number to send the test to (e.g. 0771234567).'); return }
    setTestSending(true)
    try {
      const body = testMessage.trim()
        || `Motions: SMS gateway test — working as of ${new Date().toLocaleTimeString()}. Sent by ${user?.name ?? 'staff'} from System Health.`
      const result = await sendSms(to, body)
      if (result.success) {
        showToast('success', `Test SMS delivered to ${to} — SMS system is working correctly.`)
        return
      }
      // The send failed — ask the gateway directly whether it's even alive
      // before blaming anything, so the answer names the source.
      const ping = await pingSmsGateway()
      if (!ping.up && ping.source === 'afrosoft') {
        showToast('error', `⚠ SMS provider (Afrosoft) is currently down. Text messages cannot be sent right now. Please try again later or contact support if this continues.`)
      } else if (!ping.up) {
        showToast('error', `⚠ Your login session may have expired. Please refresh the page and try again. If the problem persists, contact support.`)
      } else {
        showToast('error', `SMS provider is working, but the message failed to send. Please check the phone number format and try again.`)
      }
    } finally {
      setTestSending(false)
    }
  }

  return (
    <div className="panel">
      {/* Header */}
      <div className="sh-page-header">
        <div className="sh-page-status">
          <div className="syshealth-dot lg" style={{ background: dot }} />
          <div>
            <h2 className="sh-page-title">System Health</h2>
            <p className="sh-page-sub">Live database and connectivity monitoring</p>
          </div>
        </div>
        <span
          className="sh-page-badge"
          style={{ background: STATUS_BG[stats.overall], color: STATUS_TEXT[stats.overall] }}
        >
          {stats.overall.toUpperCase()}
        </span>
      </div>

      {/* Stat cards */}
      <div className="stats-grid" style={{ marginBottom: 20 }}>
        <div className="stat-card">
          <div className="stat-icon" style={{ background: '#EFF6FF', color: '#2563EB' }}>⏱</div>
          <div className="stat-body">
            <div className="stat-value">{fmtUptime(stats.uptime)}</div>
            <div className="stat-label">Session Uptime</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon" style={{ background: '#D1FAE5', color: '#059669' }}>⚙</div>
          <div className="stat-body">
            <div className="stat-value">{stats.totalOps}</div>
            <div className="stat-label">Total Operations</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon" style={{ background: '#FEF3C7', color: '#D97706' }}>⚡</div>
          <div className="stat-body">
            <div className="stat-value">{stats.avgMs}ms</div>
            <div className="stat-label">Avg Latency</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon" style={{ background: stats.localMode ? '#FEF3C7' : '#D1FAE5', color: stats.localMode ? '#D97706' : '#059669' }}>
            {stats.localMode ? '💾' : '☁'}
          </div>
          <div className="stat-body">
            <div className="stat-value" style={{ fontSize: 15, marginTop: 4 }}>{stats.localMode ? 'Local (Offline)' : 'Supabase'}</div>
            <div className="stat-label">Data Source</div>
          </div>
        </div>
        {/* Afrosoft is tracked on real send attempts — green only when a
            message has actually been confirmed by the gateway this session;
            red with the gateway's own words when it failed; neutral until
            the first send so nobody reads "healthy" off a gateway nobody
            has touched. */}
        <div className="stat-card">
          <div className="stat-icon" style={{
            background: stats.smsOpsCount === 0 ? '#F1F5F9' : stats.smsLastOk ? '#D1FAE5' : '#FEE2E2',
            color: stats.smsOpsCount === 0 ? '#64748B' : stats.smsLastOk ? '#059669' : '#DC2626',
          }}>📱</div>
          <div className="stat-body">
            <div className="stat-value" style={{ fontSize: 15, marginTop: 4 }}>
              {stats.smsOpsCount === 0 ? 'No sends yet' : stats.smsLastOk ? 'Operational' : 'FAILING'}
            </div>
            <div className="stat-label">Afrosoft SMS Gateway</div>
          </div>
        </div>
        {/* The motions.co.zw -> portal link: pings the same
            /api/health-check the website calls, so green means website
            registrations can reach us right now. */}
        <div className="stat-card">
          <div className="stat-icon" style={{
            background: websiteLink.ok === null ? '#F1F5F9' : websiteLink.ok ? '#D1FAE5' : '#FEE2E2',
            color: websiteLink.ok === null ? '#64748B' : websiteLink.ok ? '#059669' : '#DC2626',
          }}>🔗</div>
          <div className="stat-body">
            <div className="stat-value" style={{ fontSize: 15, marginTop: 4 }}>
              {websiteLink.ok === null ? 'Checking…' : websiteLink.ok ? 'Connected' : 'UNREACHABLE'}
            </div>
            <div className="stat-label" title={websiteLink.detail}>Website ↔ Portal</div>
          </div>
        </div>
        {/* Reconciliation: registration/payment happened, counterpart
            didn't — the daily cron also emails new findings. */}
        <div className="stat-card" title={recon ? `Checked ${new Date(recon.checkedAt).toLocaleTimeString()}` : ''}>
          <div className="stat-icon" style={{
            background: !recon ? '#F1F5F9' : (recon.orphanedClients.length + recon.stalePaynow.length + recon.paidButPending.length) === 0 ? '#D1FAE5' : '#FEE2E2',
            color: !recon ? '#64748B' : (recon.orphanedClients.length + recon.stalePaynow.length + recon.paidButPending.length) === 0 ? '#059669' : '#DC2626',
          }}>⚖</div>
          <div className="stat-body">
            <div className="stat-value" style={{ fontSize: 15, marginTop: 4 }}>
              {!recon ? 'Checking…' : (recon.orphanedClients.length + recon.stalePaynow.length + recon.paidButPending.length) === 0 ? 'Clean' : `${recon.orphanedClients.length + recon.stalePaynow.length + recon.paidButPending.length} unmatched`}
            </div>
            <div className="stat-label">Reconciliation</div>
          </div>
        </div>
      </div>

      {/* Reconciliation detail — only rendered while there is something
          unmatched, with the exact reference a human needs to fix it. */}
      {recon && (recon.orphanedClients.length + recon.stalePaynow.length + recon.paidButPending.length) > 0 && (
        <div className="card" style={{ marginBottom: 20, borderLeft: '3px solid var(--danger)' }}>
          <div className="card-header">
            <span className="card-title">⚖ Unreconciled records — investigate before close of day</span>
            {/* Dismissal is acknowledgement, not deletion — the client,
                the transaction and the policy all keep their truth.
                New unmatched items still alert. */}
            <button type="button" className="btn btn-ghost btn-sm" disabled={dismissing}
              onClick={() => void dismissRecon([
                ...recon.orphanedClients.map(c => ({ kind: 'orphaned_client', ref: c.id })),
                ...recon.stalePaynow.map(t => ({ kind: 'stale_paynow', ref: t.reference })),
                ...recon.paidButPending.map(p => ({ kind: 'paid_but_pending', ref: p.id })),
              ])}>
              {dismissing ? 'Clearing…' : 'Clear all'}
            </button>
          </div>
          {recon.orphanedClients.map(c => (
            <div key={c.id} className="info-banner info-banner-danger" style={{ marginBottom: 8, borderRadius: 8, padding: '10px 13px', fontSize: 12, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <span style={{ flex: 1 }}>👤 Client <strong>{c.name}</strong> ({c.phone ?? 'no phone'}, registered {new Date(c.createdAt).toLocaleDateString('en-GB')}) has <strong>no policy</strong> — an abandoned signup; no payment can exist without a policy.</span>
              <button type="button" className="btn btn-ghost btn-sm" style={{ padding: '0 6px' }} title="Acknowledge — stop alerting on this"
                onClick={() => void dismissRecon([{ kind: 'orphaned_client', ref: c.id }])}>✕</button>
            </div>
          ))}
          {recon.stalePaynow.map(t => (
            <div key={t.reference} className="info-banner info-banner-warning" style={{ marginBottom: 8, borderRadius: 8, padding: '10px 13px', fontSize: 12, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <span style={{ flex: 1 }}>💳 Paynow ref <strong>{t.reference}</strong> ({t.currency} ${Number(t.amount).toFixed(2)}) never confirmed — check the gateway, reconcile with the payer.</span>
              <button type="button" className="btn btn-ghost btn-sm" style={{ padding: '0 6px' }} title="Acknowledge — stop alerting on this"
                onClick={() => void dismissRecon([{ kind: 'stale_paynow', ref: t.reference }])}>✕</button>
            </div>
          ))}
          {recon.paidButPending.map(p => (
            <div key={p.policyNumber} className="info-banner info-banner-danger" style={{ marginBottom: 8, borderRadius: 8, padding: '10px 13px', fontSize: 12, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <span style={{ flex: 1 }}>📄 Policy <strong>{p.policyNumber}</strong> ({p.clientName}) has a completed payment but is still <strong>pending</strong> — activate or refund.</span>
              <button type="button" className="btn btn-ghost btn-sm" style={{ padding: '0 6px' }} title="Acknowledge — stop alerting on this"
                onClick={() => void dismissRecon([{ kind: 'paid_but_pending', ref: p.id }])}>✕</button>
            </div>
          ))}
        </div>
      )}

      {/* AI System Check — deterministic probes (configuration, the
          portal↔database link, schema, notifications, phones, pricing,
          premiums), the whitelisted repairs applied automatically and
          logged, then Groq's plain-English diagnosis. Built for support
          duty: anyone on the phone can run it and read the verdict. */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-header">
          <span className="card-title">🤖 AI System Check &amp; Fix</span>
          <div style={{ display: 'flex', gap: 8 }}>
            {(aiCheck?.fixable ?? 0) > 0 && (
              <button type="button" className="btn btn-primary btn-sm" disabled={aiChecking}
                onClick={() => void runCheck(true)}>
                {aiChecking ? 'Fixing…' : `🔧 Apply Fixes (${aiCheck!.fixable})`}
              </button>
            )}
            <button type="button" className="btn btn-ghost btn-sm" disabled={aiChecking}
              onClick={() => void runCheck(false)}>
              {aiChecking ? 'Checking…' : 'Run Check'}
            </button>
          </div>
        </div>

        {aiCheck && (
          <>
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: 12, marginBottom: 10 }}>
              {aiCheck.checks.map(c => (
                <span key={c.key} style={{ color: 'var(--muted)', maxWidth: 340 }}>
                  <span className="syshealth-dot" style={{ display: 'inline-block', marginRight: 6, background: c.status === 'ok' ? '#10B981' : c.status === 'warning' ? '#F59E0B' : '#EF4444' }} />
                  {c.label}: <strong style={{ color: c.status === 'ok' ? 'var(--text)' : c.status === 'warning' ? '#92400E' : 'var(--danger)' }}>{c.detail}</strong>
                </span>
              ))}
            </div>
            {aiCheck.fixed.length > 0 && (
              <div className="info-banner info-banner-info" style={{ fontSize: 12, marginBottom: 8 }}>
                ✅ <strong>Fixed automatically (logged):</strong> {aiCheck.fixed.join(' ')}
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
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
              Checked {new Date(aiCheck.checkedAt).toLocaleTimeString('en-GB')} · checks run on the server against live data
            </div>
          </>
        )}

        {!aiCheck && (
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            Probes every integration, the portal↔database link, the schema and the data — repairs what it can safely repair and logs it below, then the AI explains what still needs a person.
          </div>
        )}

        {fixLog.length > 0 && (
          <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>Fix log — what the checker repaired</div>
            {fixLog.map(f => (
              <div key={`${f.kind}-${f.applied_at}`} style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>
                <strong style={{ color: 'var(--text)' }}>{f.detail}</strong>
                {` — ${new Date(f.applied_at).toLocaleString('en-GB')}`}
              </div>
            ))}
          </div>
        )}
      </div>

      {(suspiciousLogins.length > 0 || quotaAlerts.length > 0) && (
        <div className="card" style={{ marginBottom: 20, borderLeft: '3px solid var(--danger)' }}>
          <div className="card-header"><span className="card-title">⚠ Security & Quota Alerts</span></div>
          {suspiciousLogins.map(f => (
            <div key={f.email} className="info-banner info-banner-danger" style={{ marginBottom: 8, borderRadius: 8, padding: '10px 13px', fontSize: 12 }}>
              🔒 Possible brute-force: {f.count} failed login attempts for <strong>{f.email}</strong> in the last 15 minutes (last at {fmtTime(new Date(f.lastAttempt).getTime())}).
            </div>
          ))}
          {quotaAlerts.map(op => (
            <div key={op.id} className="info-banner info-banner-warning" style={{ marginBottom: 8, borderRadius: 8, padding: '10px 13px', fontSize: 12 }}>
              ⚡ {op.table}: {op.detail} ({fmtTime(op.ts)})
            </div>
          ))}
        </div>
      )}

      {/* Security */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-header"><span className="card-title">🔐 Login Attempts (last 15 min)</span></div>
        {failedLogins.length === 0 ? (
          <div className="empty-state" style={{ padding: '20px 0' }}>No failed login attempts recorded in the last 15 minutes.</div>
        ) : (
          <div className="tbl-scroll">
          <table className="table">
            <thead><tr><th>Email</th><th>Failed Attempts</th><th>Last Attempt</th><th>Status</th></tr></thead>
            <tbody>
              {failedLogins.map(f => (
                <tr key={f.email}>
                  <td>{f.email}</td>
                  <td>{f.count}</td>
                  <td>{fmtTime(new Date(f.lastAttempt).getTime())}</td>
                  <td>
                    {f.count >= BRUTE_FORCE_THRESHOLD
                      ? <span className="pill pill-lapsed">⚠ Suspicious</span>
                      : <span className="pill pill-pending">Watching</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      <div className="sh-page-body">
        {/* Metrics panel */}
        <div className="card" style={{ minWidth: 0 }}>
          <div className="card-header">
            <span className="card-title">Performance Metrics</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <MetricBar label="Read Success Rate" value={stats.readSuccessPct} color="#5B7FE8" />
            <MetricBar label="Write Success Rate" value={stats.writeSuccessPct} color="#10B981" />
            <MetricBar label="Supabase Success Rate" value={stats.sbSuccessPct} color="#F59E0B" />
            {stats.smsOpsCount > 0 && (
              <MetricBar label="SMS Delivery Rate (Afrosoft)" value={stats.smsSuccessPct} color={stats.smsLastOk ? '#A855F7' : '#DC2626'} />
            )}
          </div>

          <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
            <div className="sh-info-row">
              <span>Supabase connected</span>
              <span style={{ color: stats.sbConnected ? '#059669' : '#DC2626', fontWeight: 600 }}>
                {stats.sbConnected ? '✓ Connected' : '✗ Not connected'}
              </span>
            </div>
            <div className="sh-info-row">
              <span>Afrosoft SMS</span>
              <span style={{ color: stats.smsOpsCount === 0 ? '#6B7E99' : stats.smsLastOk ? '#059669' : '#DC2626', fontWeight: 600 }}>
                {stats.smsOpsCount === 0 ? 'No sends this session' : stats.smsLastOk ? `✓ Delivering — ${stats.smsSuccessPct}% of ${stats.smsOpsCount} send(s)` : '✗ Last send failed'}
              </span>
            </div>
            {/* On-demand proof: a real Afrosoft round-trip to a number of
                your choosing. A green result here means the gateway works
                RIGHT NOW, not that it worked the last time anyone sent. */}
            <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                className="form-control"
                style={{ fontSize: 12, padding: '6px 10px', width: 150 }}
                placeholder="0771234567"
                value={testNumber}
                onChange={e => setTestNumber(e.target.value)}
              />
              <input
                className="form-control"
                style={{ fontSize: 12, padding: '6px 10px', flex: 1, minWidth: 200 }}
                placeholder="Message (optional — blank sends the standard test text)"
                value={testMessage}
                onChange={e => setTestMessage(e.target.value)}
                maxLength={480}
              />
              <button className="btn btn-ghost btn-sm" style={{ whiteSpace: 'nowrap' }} onClick={handleTestSms} disabled={testSending}>
                {testSending ? 'Sending…' : '📱 Send Test SMS'}
              </button>
            </div>
            {stats.smsLastOk === false && stats.smsLastDetail && (
              <div className="info-banner info-banner-danger" style={{ marginTop: 8, borderRadius: 8, padding: '8px 11px', fontSize: 12 }}>
                📱 Afrosoft: {stats.smsLastDetail}
              </div>
            )}
            <div className="sh-info-row">
              <span>Fallback mode</span>
              <span style={{ color: stats.localMode ? '#D97706' : '#6B7E99', fontWeight: 600 }}>
                {stats.localMode ? 'Active (using localStorage)' : 'Inactive'}
              </span>
            </div>
          </div>
        </div>

        {/* Operation log */}
        <div className="card" style={{ minWidth: 0 }}>
          <div className="card-header">
            <div className="tabs" style={{ margin: 0, borderBottom: 'none' }}>
              <button className={`tab${tab === 'overview' ? ' active' : ''}`} onClick={() => setTab('overview')}>
                Recent Ops
              </button>
              <button className={`tab${tab === 'log' ? ' active' : ''}`} onClick={() => setTab('log')}>
                Full Log ({stats.totalOps})
              </button>
              <button className={`tab${tab === 'delivery' ? ' active' : ''}`} onClick={() => { setTab('delivery'); if (!dlLoadedOnce) void loadDeliveryLog() }}>
                Delivery Log
              </button>
            </div>
            <button className="btn btn-ghost" onClick={handleReset} style={{ fontSize: 11, color: 'var(--muted)' }}>
              Clear
            </button>
          </div>

          {tab === 'delivery' ? (
            <>
              {/* Filters: find a delivery by recipient/ref/detail text,
                  channel, status, or a date window — then just scroll. */}
              <div className="dl-filters">
                <select className="form-control" style={{ width: 110 }} value={dlChannel} onChange={e => setDlChannel(e.target.value)}>
                  <option value="">All channels</option>
                  <option value="sms">SMS</option>
                  <option value="email">Email</option>
                  <option value="whatsapp">WhatsApp</option>
                </select>
                <select className="form-control" style={{ width: 110 }} value={dlStatus} onChange={e => setDlStatus(e.target.value)}>
                  <option value="">All statuses</option>
                  <option value="failed">Failed</option>
                  <option value="sent">Sent</option>
                  <option value="queued">Queued</option>
                  <option value="skipped">Skipped</option>
                </select>
                <input className="form-control" style={{ flex: 1, minWidth: 180 }}
                  placeholder="Search number, name, ref or error text…"
                  value={dlText}
                  onChange={e => setDlText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') void loadDeliveryLog() }}
                />
                <input className="form-control" type="date" style={{ width: 140 }} value={dlFrom} onChange={e => setDlFrom(e.target.value)} title="From date" />
                <input className="form-control" type="date" style={{ width: 140 }} value={dlTo} onChange={e => setDlTo(e.target.value)} title="To date" />
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void loadDeliveryLog()} disabled={dlLoading}>
                  {dlLoading ? 'Loading…' : 'Search'}
                </button>
              </div>
              <div className="sh-log-table">
                {dlRows.length === 0 ? (
                  <div className="empty-state" style={{ padding: '32px 0' }}>
                    {dlLoading ? 'Loading deliveries…' : dlLoadedOnce ? 'No deliveries match those filters.' : 'Press Search to load the delivery log.'}
                  </div>
                ) : (
                  <>
                    <div className="dl-head">
                      <span>Date &amp; time</span>
                      <span>Channel</span>
                      <span>Status</span>
                      <span>Recipient</span>
                      <span>Ref</span>
                    </div>
                    {dlRows.map((r, i) => (
                      <div key={`${r.at}-${r.recipient}-${i}`} className={`dl-row${r.status === 'failed' ? ' dl-fail' : ''}`}>
                        <span className="sh-log-time">{new Date(r.at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                        <span className="dl-cell">{r.channel}</span>
                        <span className={`dl-status-${r.status ?? 'sent'}`}>{r.status ?? '—'}</span>
                        <span className="dl-cell" title={r.recipient}>{r.recipient}</span>
                        <span className="dl-cell" title={r.ref ?? ''}>{r.ref ?? '—'}</span>
                        {(r.event || r.detail) && (
                          <span className="dl-detail"><strong>{r.event}</strong>{r.detail ? ` — ${r.detail}` : ''}</span>
                        )}
                      </div>
                    ))}
                    <div style={{ fontSize: 11, color: 'var(--muted)', padding: '8px 0' }}>
                      Showing {dlRows.length} entr{dlRows.length === 1 ? 'y' : 'ies'} (newest first{dlRows.length >= 300 ? ', capped at 300 — narrow the filters' : ''}).
                    </div>
                  </>
                )}
              </div>
            </>
          ) : (
          <div className="sh-log-table" ref={logRef}>
            {stats.recent.length === 0 ? (
              <div className="empty-state" style={{ padding: '32px 0' }}>No operations recorded yet; interact with the app to generate data.</div>
            ) : (
              <>
                <div className="sh-log-header">
                  <span>Time</span>
                  <span>Op</span>
                  <span>Table</span>
                  <span>Source</span>
                  <span>Duration</span>
                  <span>Result</span>
                </div>
                {(tab === 'overview' ? stats.recent.slice(0, 15) : stats.recent).map(op => (
                  <div key={op.id} className={`sh-log-row${op.success ? '' : ' sh-log-fail'}`}>
                    <span className="sh-log-time">{fmtTime(op.ts)}</span>
                    <span className="sh-log-op" style={{ color: OP_COLOR[op.type] }}>{op.type.toUpperCase()}</span>
                    <span className="sh-log-cell-table">{op.table}</span>
                    <span className="sh-log-src">{op.source === 'supabase' ? '☁ Supabase' : op.source === 'api' ? '⇄ API' : '💾 Local'}</span>
                    <span className="sh-log-ms">{op.duration}ms</span>
                    <span className={op.success ? 'sh-log-ok' : 'sh-log-fail-icon'}>
                      {op.success ? '✓' : '✗'}
                    </span>
                    {op.detail && <span className="sh-log-detail">{op.detail}</span>}
                  </div>
                ))}
              </>
            )}
          </div>
          )}
        </div>
      </div>
    </div>
  )
}
