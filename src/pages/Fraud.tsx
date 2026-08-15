import { useState, useEffect } from 'react'
import type { ToastMessage, FraudCase, FraudCaseStatus, AppUser } from '../types'
import type { ActivePanel } from '../App'
import { db } from '../lib/db'
import { formatDate } from '../lib/dateUtils'
import FraudGauge from '../components/ui/FraudGauge'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
  setActivePanel: (panel: ActivePanel) => void
}

export default function Fraud({ showToast }: Props) {
  const [cases, setCases] = useState<FraudCase[]>([])
  const [staff, setStaff] = useState<AppUser[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<FraudCaseStatus | 'all'>('all')

  useEffect(() => {
    Promise.all([db.fraudCases.list(), db.staff.list()]).then(([casesRes, staffRes]) => {
      if (casesRes.error) showToast('error', 'Failed to load fraud cases.')
      else if (casesRes.data) setCases(casesRes.data)
      if (staffRes.data) setStaff(staffRes.data.filter(s => ['claims_officer', 'admin', 'super_admin'].includes(s.role)))
      setLoading(false)
    })
  }, [showToast])

  const filtered = cases.filter(c => filter === 'all' || c.status === filter)

  const counts = {
    all: cases.length,
    open: cases.filter(c => c.status === 'open').length,
    investigating: cases.filter(c => c.status === 'investigating').length,
    confirmed: cases.filter(c => c.status === 'confirmed').length,
    cleared: cases.filter(c => c.status === 'cleared').length,
  }

  const resolved = cases.filter(c => c.status === 'confirmed' || c.status === 'cleared')
  const confirmedRate = resolved.length > 0 ? Math.round((counts.confirmed / resolved.length) * 100) : 0
  const activeCases = cases.filter(c => c.status === 'open' || c.status === 'investigating')
  const valueAtRisk = activeCases.reduce((s, c) => s + (c.amount ?? 0), 0)
  const avgFraudScore = cases.length > 0 ? Math.round(cases.reduce((s, c) => s + c.fraudScore, 0) / cases.length) : 0
  const agricultureCases = cases.filter(c => c.category === 'agriculture').length

  const signalCounts = new Map<string, number>()
  for (const c of cases) {
    for (const s of c.signals) signalCounts.set(s, (signalCounts.get(s) ?? 0) + 1)
  }
  const topSignals = [...signalCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)

  const assign = async (id: string, staffId: string) => {
    const { data, error } = await db.fraudCases.update(id, { assignedTo: staffId, status: 'investigating' })
    if (error || !data) { showToast('error', 'Failed to assign case.'); return }
    setCases(prev => prev.map(c => c.id === id ? data : c))
    const member = staff.find(s => s.id === staffId)
    showToast('success', `Case assigned to ${member?.name}.`)
  }

  const updateStatus = async (id: string, status: FraudCaseStatus) => {
    const updates: Partial<FraudCase> = { status }
    if (status === 'confirmed' || status === 'cleared') updates.resolvedAt = new Date().toISOString()
    const { data, error } = await db.fraudCases.update(id, updates)
    if (error || !data) { showToast('error', 'Failed to update case.'); return }
    setCases(prev => prev.map(c => c.id === id ? data : c))
    showToast('info', `Case status updated to ${status}.`)
  }

  return (
    <div className="panel">
      <div className="info-banner info-banner-danger">
        ⚠ AI Fraud Detection analyses claims for anomalies. High-score cases require manual investigation before approval.
      </div>

      {!loading && (
        <>
          <div className="stats-grid" style={{ marginBottom: 18 }}>
            <div className="stat-card">
              <div className="stat-icon" style={{ background: 'rgba(239,68,68,0.15)', color: 'var(--danger)' }}>⚠</div>
              <div className="stat-body">
                <div className="stat-value">{counts.open + counts.investigating}</div>
                <div className="stat-label">Active Cases</div>
                <div className="stat-delta">{counts.open} open · {counts.investigating} investigating</div>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-icon" style={{ background: 'rgba(245,158,11,0.15)', color: 'var(--gold)' }}>$</div>
              <div className="stat-body">
                <div className="stat-value">${valueAtRisk.toLocaleString()}</div>
                <div className="stat-label">Value at Risk</div>
                <div className="stat-delta">Open + investigating claims</div>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-icon" style={{ background: 'rgba(91,127,232,0.15)', color: 'var(--blue)' }}>📊</div>
              <div className="stat-body">
                <div className="stat-value">{avgFraudScore}%</div>
                <div className="stat-label">Avg. Fraud Score</div>
                <div className="stat-delta">Across all cases</div>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-icon" style={{ background: 'rgba(16,185,129,0.15)', color: 'var(--teal)' }}>✓</div>
              <div className="stat-body">
                <div className="stat-value">{confirmedRate}%</div>
                <div className="stat-label">Confirmed Fraud Rate</div>
                <div className="stat-delta">Of {resolved.length} resolved case{resolved.length !== 1 ? 's' : ''}</div>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-icon" style={{ background: 'rgba(139,92,246,0.15)', color: 'var(--purple)' }}>🌾</div>
              <div className="stat-body">
                <div className="stat-value">{agricultureCases}</div>
                <div className="stat-label">Agriculture Cases</div>
                <div className="stat-delta">{cases.length > 0 ? Math.round((agricultureCases / cases.length) * 100) : 0}% of total</div>
              </div>
            </div>
          </div>

          {topSignals.length > 0 && (
            <div className="card" style={{ marginBottom: 18 }}>
              <div className="card-header"><h3 className="card-title">Most Common Fraud Signals</h3></div>
              <table className="table">
                <thead><tr><th>Signal</th><th>Cases</th></tr></thead>
                <tbody>
                  {topSignals.map(([signal, count]) => (
                    <tr key={signal}>
                      <td>{signal}</td>
                      <td>{count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <div className="panel-toolbar">
        <div className="filter-row">
          <select title="Filter by status" className="filter-select" value={filter} onChange={e => setFilter(e.target.value as FraudCaseStatus | 'all')}>
            <option value="all">All ({counts.all})</option>
            <option value="open">Open ({counts.open})</option>
            <option value="investigating">Investigating ({counts.investigating})</option>
            <option value="confirmed">Confirmed ({counts.confirmed})</option>
            <option value="cleared">Cleared ({counts.cleared})</option>
          </select>
        </div>
      </div>

      {loading ? (
        <div className="empty-state">Loading fraud cases…</div>
      ) : (
        <div className="fraud-cases-list">
          {filtered.length === 0 ? (
            <div className="empty-state">No fraud cases matching filter.</div>
          ) : filtered.map(fc => (
            <div key={fc.id} className="fraud-case-card">
              <div className="fraud-case-header">
                <div className="fraud-case-title">
                  <span className="mono">{fc.claimNumber}</span>
                  <span className="fraud-case-sep">·</span>
                  <strong>{fc.clientName}</strong>
                  <span className="fraud-case-sep">·</span>
                  <span className="mono">{fc.policyNumber}</span>
                  {fc.amount !== undefined && (
                    <>
                      <span className="fraud-case-sep">·</span>
                      <span>${fc.amount.toLocaleString()}</span>
                    </>
                  )}
                  {fc.category === 'agriculture' && <span className="pill pill-active" style={{ marginLeft: 6, fontSize: 10 }}>🌾 Agriculture</span>}
                </div>
                <FraudGauge score={fc.fraudScore} />
              </div>

              <div className="fraud-signals">
                <div className="fraud-signals-label">Detected Signals:</div>
                <ul className="fraud-signals-list">
                  {fc.signals.map((s, i) => (
                    <li key={i} className="fraud-signal-item">
                      <span className="fraud-signal-arrow">▶</span> {s}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="fraud-case-footer">
                <div className="fraud-case-meta">
                  <span className={`pill pill-${fc.status.replace('_', '-')}`}>{fc.status}</span>
                  {fc.assignedTo && (
                    <span className="text-muted fraud-meta-text">
                      Assigned: {staff.find(s => s.id === fc.assignedTo)?.name ?? fc.assignedTo}
                    </span>
                  )}
                  {fc.resolvedAt && (
                    <span className="text-muted fraud-meta-text">
                      Resolved: {formatDate(fc.resolvedAt)}
                    </span>
                  )}
                </div>
                <div className="fraud-case-actions">
                  {fc.status === 'open' && (
                    <select
                      title="Assign to staff member"
                      className="filter-select filter-select-sm"
                      defaultValue=""
                      onChange={e => { if (e.target.value) assign(fc.id, e.target.value) }}
                    >
                      <option value="" disabled>Assign to…</option>
                      {staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  )}
                  {fc.status === 'investigating' && (
                    <>
                      <button type="button" className="btn btn-danger btn-sm" onClick={() => updateStatus(fc.id, 'confirmed')}>
                        Confirm Fraud
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => updateStatus(fc.id, 'cleared')}>
                        Clear Case
                      </button>
                    </>
                  )}
                  {(fc.status === 'confirmed' || fc.status === 'cleared') && (
                    <span className="text-muted fraud-meta-text">Case closed</span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
