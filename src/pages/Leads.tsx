import { useState, useEffect } from 'react'
import type { ToastMessage, Lead, LeadStatus, Client } from '../types'
import type { ActivePanel } from '../App'
import { db } from '../lib/db'
import { formatDate } from '../lib/dateUtils'
import ScoreBar from '../components/ui/ScoreBar'
import ViewLeadModal from '../components/modals/ViewLeadModal'
import NewLeadModal from '../components/modals/NewLeadModal'
import LeadsSearchModal from '../components/modals/LeadsSearchModal'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
  setActivePanel: (panel: ActivePanel) => void
}

const LEAD_STATUS_CLASS: Record<LeadStatus, string> = {
  new: 'lead-status-new',
  contacted: 'lead-status-contacted',
  qualified: 'lead-status-qualified',
  proposal: 'lead-status-proposal',
  converted: 'lead-status-converted',
  lost: 'lead-status-lost',
}

export default function Leads({ showToast, setActivePanel }: Props) {
  const [leads, setLeads] = useState<Lead[]>([])
  // Abandoned signups — self-registered clients (website/bot, so
  // captured_by is NULL; staff-captured clients like farmers are a
  // different problem and stay out of this list) with no policy. They
  // showed real signup intent, so they surface here as warm leads.
  const [abandoned, setAbandoned] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<LeadStatus | 'all'>('all')
  const [viewLead, setViewLead] = useState<Lead | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [showSearch, setShowSearch] = useState(false)

  useEffect(() => {
    db.leads.list().then(({ data, error }) => {
      if (error) showToast('error', 'Failed to load leads.')
      else if (data) setLeads(data)
      setLoading(false)
    }).catch(() => { showToast('error', 'Failed to load leads.'); setLoading(false) })
    db.clients.list().then(({ data }) => {
      if (data) setAbandoned(data.filter(c => (c.policyCount ?? 0) === 0 && !c.capturedById))
    }).catch(() => { /* abandoned-signup strip is advisory — don't block the page */ })
  }, [showToast])

  const filtered = leads.filter(l => {
    const matchSearch = l.name.toLowerCase().includes(search.toLowerCase()) ||
      l.phone.includes(search) || l.productInterest.toLowerCase().includes(search.toLowerCase())
    const matchStatus = statusFilter === 'all' || l.status === statusFilter
    return matchSearch && matchStatus
  })

  const statusCounts = {
    all: leads.length,
    new: leads.filter(l => l.status === 'new').length,
    contacted: leads.filter(l => l.status === 'contacted').length,
    qualified: leads.filter(l => l.status === 'qualified').length,
    proposal: leads.filter(l => l.status === 'proposal').length,
    converted: leads.filter(l => l.status === 'converted').length,
    lost: leads.filter(l => l.status === 'lost').length,
  }

  const handleUpdate = async (updated: Lead) => {
    const { data, error } = await db.leads.update(updated.id, updated)
    if (error || !data) { showToast('error', 'Failed to update lead.'); return }
    setLeads(prev => prev.map(l => l.id === data.id ? data : l))
    showToast('success', `Lead ${data.name} updated.`)
    setViewLead(null)
  }

  const handleAdd = async (lead: Omit<Lead, 'id'>) => {
    const { data, error } = await db.leads.create(lead)
    if (error || !data) { showToast('error', error ?? 'Failed to add lead.'); return }
    setLeads(prev => [data, ...prev])
    setShowAdd(false)
    showToast('success', `Lead "${data.name}" added, AI intent score: ${data.intentScore}.`)
  }

  // Phones already in the pipeline — an abandoned signup that was
  // imported once (or captured another way) can't be duplicated.
  const leadPhones = new Set(leads.map(l => l.phone))

  const handleImportAbandoned = async (c: Client) => {
    // High intent by construction — they filled out a signup form.
    const { data, error } = await db.leads.create({
      name: c.name, email: c.email || undefined, phone: c.phone,
      source: 'Abandoned signup', productInterest: '—',
      status: 'new', intentScore: 80, createdAt: new Date().toISOString(),
    })
    if (error || !data) { showToast('error', error ?? 'Failed to add lead.'); return }
    setLeads(prev => [data, ...prev])
    setAbandoned(prev => prev.filter(x => x.id !== c.id))
    showToast('success', `${data.name} added to leads.`)
  }

  const handleImportSearched = async (found: Omit<Lead, 'id'>[]) => {
    let imported = 0
    for (const lead of found) {
      const { data } = await db.leads.create(lead)
      if (data) { setLeads(prev => [data, ...prev]); imported++ }
    }
    setShowSearch(false)
    showToast(imported > 0 ? 'success' : 'error', imported > 0 ? `Imported ${imported} lead${imported !== 1 ? 's' : ''}.` : 'Failed to import leads.')
  }

  return (
    <div className="panel">
      <div className="panel-toolbar">
        <div className="filter-row">
          <input
            className="search-input"
            placeholder="Search name, phone, product…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <select title="Filter by status" className="filter-select" value={statusFilter} onChange={e => setStatusFilter(e.target.value as LeadStatus | 'all')}>
            <option value="all">All ({statusCounts.all})</option>
            <option value="new">New ({statusCounts.new})</option>
            <option value="contacted">Contacted ({statusCounts.contacted})</option>
            <option value="qualified">Qualified ({statusCounts.qualified})</option>
            <option value="proposal">Proposal ({statusCounts.proposal})</option>
            <option value="converted">Converted ({statusCounts.converted})</option>
            <option value="lost">Lost ({statusCounts.lost})</option>
          </select>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn btn-outline" onClick={() => setShowSearch(true)}>
            🎯 Run Leads Search
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setShowAdd(true)}>
            + Add Lead
          </button>
        </div>
      </div>

      {abandoned.length > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-header">
            <h3 className="card-title">🚪 Abandoned Signups ({abandoned.length})</h3>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setActivePanel('clients_no_policy')}>View all →</button>
          </div>
          <div className="info-banner info-banner-warning" style={{ margin: '0 16px 12px', borderRadius: 8 }}>
            Self-registered signups (website/bot) that never completed — no payment was taken, no policy exists. Warm leads: they already tried to buy.
          </div>
          <div className="tbl-scroll" style={{ maxHeight: 320, overflowY: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Phone</th>
                <th>Email</th>
                <th>Signed Up</th>
                <th>Referred By</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {abandoned.map(c => (
                <tr key={c.id}>
                  <td><strong>{c.name}</strong></td>
                  <td>{c.phone}</td>
                  <td>{c.email || '—'}</td>
                  <td>{formatDate(c.createdAt)}</td>
                  <td>{c.agentName ?? '—'}</td>
                  <td>
                    {leadPhones.has(c.phone) ? (
                      <span className="pill pill-active">In leads</span>
                    ) : (
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => void handleImportAbandoned(c)}>+ Add to Leads</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      <div className="card">
        {loading ? (
          <div className="empty-state">Loading leads…</div>
        ) : (
          <div className="tbl-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Phone</th>
                <th>Source</th>
                <th>Product Interest</th>
                <th>Intent Score</th>
                <th>Status</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={8} className="td-empty">No leads found.</td></tr>
              ) : filtered.map(l => (
                <tr key={l.id}>
                  <td><strong>{l.name}</strong></td>
                  <td>{l.phone}</td>
                  <td>{l.source}</td>
                  <td>{l.productInterest}</td>
                  <td><ScoreBar score={l.intentScore} /></td>
                  <td><span className={`pill ${LEAD_STATUS_CLASS[l.status]}`}>{l.status}</span></td>
                  <td>{formatDate(l.createdAt)}</td>
                  <td>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setViewLead(l)}>View</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {viewLead && (
        <ViewLeadModal lead={viewLead} onClose={() => setViewLead(null)} onSave={handleUpdate} />
      )}
      {showAdd && (
        <NewLeadModal onClose={() => setShowAdd(false)} onSave={handleAdd} />
      )}
      {showSearch && (
        <LeadsSearchModal onClose={() => setShowSearch(false)} onImport={handleImportSearched} />
      )}
    </div>
  )
}
