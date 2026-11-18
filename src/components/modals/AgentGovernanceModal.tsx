import { useMemo, useState } from 'react'
import type { AgentGovernanceRequest, AgentProfile, AppUser } from '../../types'
import { formatDate } from '../../lib/dateUtils'

interface Props {
  agents: AppUser[]
  agentProfiles: Map<string, AgentProfile>
  agentStats: Map<string, { clients: number; policies: number; premium: number }>
  requests: AgentGovernanceRequest[]
  canReview: boolean
  onClose: () => void
  onRequestMerge: (sourceId: string, targetId: string, reason: string) => void
  onReview: (request: AgentGovernanceRequest, decision: 'approved' | 'rejected', notes?: string) => void
}

const normName = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const digits = (value?: string) => (value ?? '').replace(/\D/g, '')
const normId = (value?: string) => (value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')

interface DuplicatePair {
  key: string
  first: AppUser
  second: AppUser
  reasons: string[]
}

function requestTitle(request: AgentGovernanceRequest, agentName: (id?: string) => string): string {
  if (request.requestType === 'merge') {
    return `Merge ${agentName(request.mergeSourceId)} into ${agentName(request.mergeTargetId)}`
  }
  if (request.requestType === 'client_agent') {
    const clientName = String(request.payload.client_name ?? request.clientId ?? 'client')
    return `Secondary agent for ${clientName}`
  }
  return `Duplicate account approval — ${String(request.payload.name ?? 'New agent')}`
}

export default function AgentGovernanceModal({
  agents, agentProfiles, agentStats, requests, canReview, onClose, onRequestMerge, onReview,
}: Props) {
  const [targets, setTargets] = useState<Record<string, string>>({})
  const [reasons, setReasons] = useState<Record<string, string>>({})

  const agentById = useMemo(() => new Map(agents.map(a => [a.id, a])), [agents])
  const agentName = (id?: string) => agentById.get(id ?? '')?.name ?? String(id ?? 'Unknown agent')

  const duplicatePairs = useMemo<DuplicatePair[]>(() => {
    const pairs: DuplicatePair[] = []
    for (let i = 0; i < agents.length; i++) {
      for (let j = i + 1; j < agents.length; j++) {
        const first = agents[i]
        const second = agents[j]
        const reasons: string[] = []
        if (normName(first.name) === normName(second.name)) reasons.push('same name')
        if (digits(first.phone) && digits(first.phone) === digits(second.phone)) reasons.push('same phone')
        const firstId = normId(agentProfiles.get(first.id)?.nationalId)
        const secondId = normId(agentProfiles.get(second.id)?.nationalId)
        if (firstId && firstId === secondId) reasons.push('same National ID')
        if (reasons.length > 0) pairs.push({ key: [first.id, second.id].sort().join('|'), first, second, reasons })
      }
    }
    return pairs
  }, [agents, agentProfiles])

  const pendingMergeFor = (a: string, b: string) => requests.some(r =>
    r.requestType === 'merge' && r.status === 'pending'
    && [r.mergeSourceId, r.mergeTargetId].includes(a)
    && [r.mergeSourceId, r.mergeTargetId].includes(b))

  const preferredTarget = (pair: DuplicatePair) => {
    const a = agentStats.get(pair.first.id)
    const b = agentStats.get(pair.second.id)
    const score = (s?: { clients: number; policies: number }) => (s?.clients ?? 0) * 1000 + (s?.policies ?? 0)
    if (score(a) !== score(b)) return score(b) > score(a) ? pair.second.id : pair.first.id
    if (pair.first.active !== pair.second.active) return pair.first.active ? pair.first.id : pair.second.id
    return pair.first.id
  }

  const review = (request: AgentGovernanceRequest, decision: 'approved' | 'rejected') => {
    const notes = window.prompt(`${decision === 'approved' ? 'Approval' : 'Rejection'} note (optional):`)
    if (notes === null) return
    onReview(request, decision, notes || undefined)
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 960 }}>
        <div className="modal-header">
          <h3>Agent Reconciliation & Approvals</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="info-banner info-banner-info">
            Merges keep every client, policy, claim and audit reference. The duplicate login is marked inactive and merged into the surviving agent — it is not deleted.
          </div>

          <div className="card" style={{ marginTop: '1rem' }}>
            <div className="card-header"><h3 className="card-title">Potential duplicate accounts</h3></div>
            {duplicatePairs.length === 0 ? (
              <div className="empty-state">No duplicate name, phone, or National ID matches were found.</div>
            ) : duplicatePairs.map(pair => {
              const targetId = targets[pair.key] ?? preferredTarget(pair)
              const source = targetId === pair.first.id ? pair.second : pair.first
              const pending = pendingMergeFor(pair.first.id, pair.second.id)
              return (
                <div key={pair.key} style={{ borderBottom: '1px solid var(--border)', padding: '0.85rem 1rem' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: '1rem', alignItems: 'center' }}>
                    {[pair.first, pair.second].map(agent => {
                      const book = agentStats.get(agent.id)
                      return (
                        <label key={agent.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', border: `1px solid ${targetId === agent.id ? 'var(--blue)' : 'var(--border)'}`, borderRadius: 8, padding: 10 }}>
                          <input
                            type="radio"
                            name={`keep-${pair.key}`}
                            checked={targetId === agent.id}
                            onChange={() => setTargets(prev => ({ ...prev, [pair.key]: agent.id }))}
                          />
                          <span>
                            <strong>Keep {agent.name}</strong>
                            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                              {agent.phone ?? 'No phone'} · {agent.email || 'No email'} · {agent.active ? 'active' : 'inactive'}
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                              {book ? `${book.clients} clients · ${book.policies} policies · $${book.premium.toFixed(2)}` : 'No book loaded'}
                            </div>
                          </span>
                        </label>
                      )
                    })}
                    <div style={{ alignSelf: 'center', color: 'var(--muted)', fontSize: 12, textAlign: 'center' }}>
                      {pair.reasons.join(' · ')}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <input
                      className="form-control"
                      placeholder="Reason / reconciliation note"
                      value={reasons[pair.key] ?? ''}
                      onChange={e => setReasons(prev => ({ ...prev, [pair.key]: e.target.value }))}
                    />
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={pending}
                      onClick={() => onRequestMerge(source.id, targetId, reasons[pair.key]?.trim() || `Duplicate agent accounts matched by ${pair.reasons.join(', ')}`)}
                    >
                      {pending ? 'Merge Pending' : `Request merge into ${agentName(targetId)}`}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>

          <div className="card" style={{ marginTop: '1rem' }}>
            <div className="card-header"><h3 className="card-title">Approval queue</h3></div>
            {requests.length === 0 ? (
              <div className="empty-state">No agent governance requests.</div>
            ) : (
              <div className="tbl-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Request</th>
                      <th>Reason / Detail</th>
                      <th>Requested</th>
                      <th>Status</th>
                      <th>Review</th>
                    </tr>
                  </thead>
                  <tbody>
                    {requests.map(request => {
                      const conflictNames = Array.isArray(request.payload.conflicts)
                        ? request.payload.conflicts.map(c => String((c as { name?: string }).name ?? '')).filter(Boolean).join(', ')
                        : ''
                      return (
                        <tr key={request.id}>
                          <td>
                            <strong>{requestTitle(request, agentName)}</strong>
                            {request.requestType === 'client_agent' && (
                              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                                Primary: {agentName(request.currentAgentId)} → requested: {agentName(request.requestedAgentId)}
                              </div>
                            )}
                          </td>
                          <td>
                            {request.reason ?? conflictNames ?? '—'}
                            {conflictNames && request.reason !== conflictNames && <div style={{ fontSize: 12, color: 'var(--muted)' }}>Matches: {conflictNames}</div>}
                          </td>
                          <td>
                            {request.requestedByName ?? '—'}<br />
                            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{formatDate(request.createdAt)}</span>
                          </td>
                          <td>
                            <span className={`pill ${request.status === 'pending' ? 'pill-pending' : request.status === 'approved' || request.status === 'used' ? 'pill-active' : 'pill-cancelled'}`}>
                              {request.status.replace('_', ' ')}
                            </span>
                            {request.status === 'approved' && request.requestType === 'duplicate_account' && (
                              <div style={{ fontSize: 12, color: 'var(--muted)' }}>Retry onboarding to use this approval.</div>
                            )}
                            {request.reviewedByName && <div style={{ fontSize: 12, color: 'var(--muted)' }}>{request.reviewedByName} · {formatDate(request.reviewedAt)}</div>}
                          </td>
                          <td>
                            {request.status === 'pending' && canReview ? (
                              <div style={{ display: 'flex', gap: 6 }}>
                                <button type="button" className="btn btn-primary btn-sm" onClick={() => review(request, 'approved')}>Approve</button>
                                <button type="button" className="btn btn-ghost btn-sm" onClick={() => review(request, 'rejected')}>Reject</button>
                              </div>
                            ) : request.status === 'pending' ? (
                              <span style={{ fontSize: 12, color: 'var(--muted)' }}>Awaiting admin review</span>
                            ) : (
                              <span style={{ fontSize: 12, color: 'var(--muted)' }}>{request.reviewNotes ?? 'Reviewed'}</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
