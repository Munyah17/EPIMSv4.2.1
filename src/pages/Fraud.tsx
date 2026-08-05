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
