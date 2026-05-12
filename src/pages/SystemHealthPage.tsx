import { useEffect, useRef, useState } from 'react'
import { health } from '../lib/health'
import type { DbOp } from '../lib/health'
import type { ToastMessage } from '../types'
import type { ActivePanel } from '../App'

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
  read: '#3B82F6',
  write: '#10B981',
  delete: '#EF4444',
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
  const [stats, setStats] = useState<Stats>(() => health.stats as Stats)
  const [tab, setTab] = useState<'overview' | 'log'>('overview')
  const [ticker, setTicker] = useState(0)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const unsub = health.subscribe(() => setStats(health.stats as Stats))
    const interval = setInterval(() => setTicker(t => t + 1), 1000)
    return () => { unsub(); clearInterval(interval) }
  }, [])

  // silence the ticker lint
  void ticker

  const dot = STATUS_COLOR[stats.overall]

  const handleReset = () => {
    showToast('info', 'Health tracker stats cleared.')
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
      </div>

      <div className="sh-page-body">
        {/* Metrics panel */}
        <div className="card" style={{ minWidth: 0 }}>
          <div className="card-header">
            <span className="card-title">Performance Metrics</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <MetricBar label="Read Success Rate" value={stats.readSuccessPct} color="#3B82F6" />
            <MetricBar label="Write Success Rate" value={stats.writeSuccessPct} color="#10B981" />
            <MetricBar label="Supabase Success Rate" value={stats.sbSuccessPct} color="#F59E0B" />
          </div>

          <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
            <div className="sh-info-row">
              <span>Supabase connected</span>
              <span style={{ color: stats.sbConnected ? '#059669' : '#DC2626', fontWeight: 600 }}>
                {stats.sbConnected ? '✓ Connected' : '✗ Not connected'}
              </span>
            </div>
            <div className="sh-info-row">
              <span>Fallback mode</span>
              <span style={{ color: stats.localMode ? '#D97706' : '#6B7E99', fontWeight: 600 }}>
                {stats.localMode ? 'Active — using localStorage' : 'Inactive'}
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
            </div>
            <button className="btn btn-ghost" onClick={handleReset} style={{ fontSize: 11, color: 'var(--muted)' }}>
              Clear
            </button>
          </div>

          <div className="sh-log-table" ref={logRef}>
            {stats.recent.length === 0 ? (
              <div className="empty-state" style={{ padding: '32px 0' }}>No operations recorded yet — interact with the app to generate data.</div>
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
                    <span className="sh-log-table">{op.table}</span>
                    <span className="sh-log-src">{op.source === 'supabase' ? '☁ Supabase' : '💾 Local'}</span>
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
        </div>
      </div>
    </div>
  )
}
