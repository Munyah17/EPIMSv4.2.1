import { useState, useEffect } from 'react'
import type { ToastMessage, Client, Policy } from '../types'
import type { ActivePanel } from '../App'
import { db } from '../lib/db'
import { formatDate } from '../lib/dateUtils'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { notifyClientRegistered, notifyRegistrationFailed, ADMIN_ALERT_NUMBERS } from '../lib/signupNotifications'
import { notifyPhone, serverReachable } from '../lib/notify'
import { recordActivity } from '../lib/activityLog'
import { COMPANY_NAME } from '../lib/company'
import { searchMembers } from '../lib/memberNumbers'
import RegisterClientModal from '../components/modals/RegisterClientModal'
import EditClientModal from '../components/modals/EditClientModal'
import NewPolicyModal from '../components/modals/NewPolicyModal'
import ActionMenu from '../components/ui/ActionMenu'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
  setActivePanel: (panel: ActivePanel) => void
}

export default function Clients({ showToast }: Props) {
  const { user, hasPermission } = useAuth()
  const [clients, setClients] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [showRegister, setShowRegister] = useState(false)
  const [editClient, setEditClient] = useState<Client | null>(null)
  const [assignPolicyClient, setAssignPolicyClient] = useState<Client | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const [policies, setPolicies] = useState<Policy[]>([])

  useEffect(() => {
    db.clients.list().then(({ data, error }) => {
      if (error) showToast('error', 'Failed to load clients.')
      else if (data) setClients(data)
      setLoading(false)
    }).catch(() => { showToast('error', 'Failed to load clients.'); setLoading(false) })
    // Dependants live on their policies, so searching for one means
    // searching policies — see the dependant results below.
    db.policies.list().then(({ data, error }) => {
      if (error) showToast('error', 'Failed to load policies — dependant search may be incomplete.')
      else if (data) setPolicies(data)
    }).catch(() => showToast('error', 'Failed to load policies — dependant search may be incomplete.'))
  }, [showToast])

  const filtered = clients.filter(c =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    c.phone.includes(search) ||
    c.nationalId.includes(search) ||
    c.email.toLowerCase().includes(search.toLowerCase())
  )

  /**
   * Dependants matching the same search, by member number, name or ID.
   *
   * A dependant is not a client and never appears as a row of their own:
   * their cover exists only through the policyholder carrying them, so each
   * result names that person and the policy they are on. Policyholders are
   * dropped from the list because they are already in the table above.
   */
  const dependantMatches = search.trim().length >= 2
    ? searchMembers(policies, search, 12).filter(m => m.role === 'dependant')
    : []

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAll = () => {
    if (selected.size === filtered.length) setSelected(new Set())
    else setSelected(new Set(filtered.map(c => c.id)))
  }

  const handleRegister = async (client: Client) => {
    // Server-side rule: nothing is registered when the server can't be
    // reached — a client on file with no welcome/alert firing is a
    // half-done registration.
    if (!(await serverReachable())) {
      showToast('error', 'The server is unreachable right now — nothing was registered. Try again in a moment.')
      return
    }
    const { data, error } = await db.clients.create(client)
    if (error || !data) {
      showToast('error', error ?? 'Failed to register client.')
      void notifyRegistrationFailed('Client registration', `${client.name} — ${error ?? 'unknown error'}`)
      return
    }
    setClients(prev => [data, ...prev])
    showToast('success', `Client ${data.name} registered.`)
    setShowRegister(false)
    void notifyClientRegistered(data, user?.name)
  }

  const handleEdit = async (updated: Client) => {
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch('/api/edit-client', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}) },
      body: JSON.stringify({ clientId: updated.id, updates: updated }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) { showToast('error', body.error ?? 'Failed to update client.'); return }
    setClients(prev => prev.map(c => c.id === body.data.id ? body.data : c))
    showToast('success', `Client ${body.data.name} updated.`)
    setEditClient(null)
  }

  const handleAssignPolicy = async (policy: Policy) => {
    if (!(await serverReachable())) {
      showToast('error', 'The server is unreachable right now — nothing was registered. Try again in a moment.')
      return
    }
    const { data, error } = await db.policies.create(policy)
    if (error || !data) {
      showToast('error', error ?? 'Failed to create policy.')
      void notifyRegistrationFailed('Policy registration', `${policy.clientName} / ${policy.productName} — ${error ?? 'unknown error'}`)
      return
    }
    setClients(prev => prev.map(c => c.id === data.clientId ? { ...c, policyCount: c.policyCount + 1 } : c))
    showToast('success', `Policy ${data.policyNumber} assigned to ${data.clientName}.`)
    setAssignPolicyClient(null)
  }

  // When a client delete is refused because policies still reference them,
  // open the blocker modal instead of sending the user away to Policies.
  const [blockedClient, setBlockedClient] = useState<Client | null>(null)
  const [blockedPolicies, setBlockedPolicies] = useState<Policy[]>([])
  const [blockedLoading, setBlockedLoading] = useState(false)
  const [deletingPolicyId, setDeletingPolicyId] = useState<string | null>(null)

  const handleDelete = async (client: Client) => {
    if (!window.confirm(`Permanently delete ${client.name}? This cannot be undone.`)) return
    const { error } = await db.clients.remove(client.id)
    if (error) {
      if (error.includes('existing policies')) {
        setBlockedClient(client)
        setBlockedLoading(true)
        const { data } = await db.policies.list()
        setBlockedPolicies((data ?? []).filter(p => p.clientId === client.id))
        setBlockedLoading(false)
        return
      }
      showToast('error', error)
      return
    }
    setClients(prev => prev.filter(c => c.id !== client.id))
    showToast('success', `${client.name} was deleted.`)
  }

  /** Same rules as the Policies page delete — blockers are named, attached
   *  claims/payments need a reason, everything is activity-logged and the
   *  office is SMS'd. Deleting the LAST blocking policy unlocks the client
   *  delete button inside the modal. */
  const quickDeletePolicy = async (policy: Policy) => {
    setDeletingPolicyId(policy.id)
    const { claims, payments, checkouts } = await db.policies.deletionBlockers(policy.id)
    const attached = [
      claims > 0 && `${claims} claim${claims === 1 ? '' : 's'}`,
      payments > 0 && `${payments} payment${payments === 1 ? '' : 's'}`,
      checkouts > 0 && `${checkouts} online checkout record${checkouts === 1 ? '' : 's'}`,
    ].filter(Boolean).join(', ')

    if (!attached) {
      if (!window.confirm(`Permanently delete policy ${policy.policyNumber}? This cannot be undone.`)) { setDeletingPolicyId(null); return }
      const { error } = await db.policies.remove(policy.id)
      setDeletingPolicyId(null)
      if (error) { showToast('error', error); return }
      setBlockedPolicies(prev => prev.filter(p => p.id !== policy.id))
      void recordActivity({
        action: 'policy.deleted', actor: { id: user?.id, name: user?.name ?? 'Unknown', role: user?.role ?? 'unknown' },
        entityType: 'policy', entityId: policy.id, entityLabel: policy.policyNumber,
        detail: `${policy.clientName}, ${policy.productName}`, severity: 'warning',
      })
      showToast('success', `Policy ${policy.policyNumber} deleted.`)
      for (const number of ADMIN_ALERT_NUMBERS) {
        notifyPhone(number, `${COMPANY_NAME}: Policy ${policy.policyNumber} (${policy.clientName}) was DELETED by ${user?.name ?? 'a staff member'}.`, 'system', policy.policyNumber)
      }
      return
    }

    const reason = window.prompt(
      `Policy ${policy.policyNumber} has ${attached} recorded against it.\n\n`
      + `Deleting it will also permanently remove ${attached}. Financial records are not recoverable once removed.\n\n`
      + 'If you are sure, enter a reason for the record:',
    )
    if (reason === null) { setDeletingPolicyId(null); return }
    if (!reason.trim()) { setDeletingPolicyId(null); showToast('warning', 'A reason is required to delete a policy with attached records.'); return }

    await recordActivity({
      action: 'policy.deleted', actor: { id: user?.id, name: user?.name ?? 'Unknown', role: user?.role ?? 'unknown' },
      entityType: 'policy', entityId: policy.id, entityLabel: policy.policyNumber,
      detail: `${policy.clientName}, ${policy.productName}. Also removed ${attached}. Reason: ${reason.trim()}`,
      severity: 'warning',
    })
    const { error } = await db.policies.remove(policy.id, { force: true })
    setDeletingPolicyId(null)
    if (error) { showToast('error', error); return }
    setBlockedPolicies(prev => prev.filter(p => p.id !== policy.id))
    showToast('success', `Policy ${policy.policyNumber} and its ${attached} deleted.`)
    for (const number of ADMIN_ALERT_NUMBERS) {
      notifyPhone(number, `${COMPANY_NAME}: Policy ${policy.policyNumber} (${policy.clientName}) was DELETED by ${user?.name ?? 'a staff member'}, along with ${attached}.`, 'system', policy.policyNumber)
    }
  }

  const retryDeleteClient = async () => {
    if (!blockedClient) return
    const { error } = await db.clients.remove(blockedClient.id)
    if (error) { showToast('error', error); return }
    setClients(prev => prev.filter(c => c.id !== blockedClient.id))
    showToast('success', `${blockedClient.name} was deleted.`)
    setBlockedClient(null)
    setBlockedPolicies([])
  }

  const bulkSMS = () => {
    if (selected.size === 0) { showToast('warning', 'Select clients first.'); return }
    showToast('success', `SMS sent to ${selected.size} client(s).`)
    setSelected(new Set())
  }

  const bulkEmail = () => {
    if (selected.size === 0) { showToast('warning', 'Select clients first.'); return }
    showToast('success', `Email sent to ${selected.size} client(s).`)
    setSelected(new Set())
  }

  return (
    <div className="panel">
      <div className="panel-toolbar">
        <div className="filter-row">
          <input
            className="search-input"
            placeholder="Search name, phone, ID, email, or a dependant's member number…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {selected.size > 0 && (
            <>
              <button type="button" className="btn btn-ghost btn-sm" onClick={bulkSMS}>📱 SMS ({selected.size})</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={bulkEmail}>✉ Email ({selected.size})</button>
            </>
          )}
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setShowRegister(true)}>+ Register Client</button>
      </div>

      {dependantMatches.length > 0 && (
        <div className="dependant-matches">
          <div className="dependant-matches-title">
            {dependantMatches.length} dependant{dependantMatches.length === 1 ? '' : 's'} matched — each one is covered
            through the policyholder named beside them, not as a client of their own.
          </div>
          <div className="tbl-scroll">
          <table className="table">
            <thead>
              <tr><th>Member No.</th><th>Dependant</th><th>Relationship</th><th>Plan</th><th>Carried By (Policyholder)</th><th>Policy</th></tr>
            </thead>
            <tbody>
              {dependantMatches.map(m => (
                <tr key={m.memberNumber}>
                  <td className="mono">{m.memberNumber}</td>
                  <td>{m.name}</td>
                  <td>{m.relationship || '—'}</td>
                  <td>{m.planName}</td>
                  <td><strong>{m.holderName}</strong></td>
                  <td className="mono">{m.policyNumber}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      <div className="card">
        {loading ? (
          <div className="empty-state">Loading clients…</div>
        ) : (
          <div className="tbl-scroll">
          <table className="table">
            <thead>
              <tr>
                <th aria-label="Select all"><input type="checkbox" title="Select all" checked={selected.size === filtered.length && filtered.length > 0} onChange={toggleAll} /></th>
                <th>Name</th>
                <th>Phone</th>
                <th>National ID</th>
                <th>Email</th>
                <th>Policies</th>
                <th>Joined</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={9} className="td-empty">No clients found.</td></tr>
              ) : filtered.map(c => (
                <tr key={c.id} className={selected.has(c.id) ? 'row-selected' : ''}>
                  <td><input type="checkbox" title={`Select ${c.name}`} checked={selected.has(c.id)} onChange={() => toggleSelect(c.id)} /></td>
                  <td><strong>{c.name}</strong></td>
                  <td>{c.phone}</td>
                  <td><span className="mono">{c.nationalId}</span></td>
                  <td>{c.email}</td>
                  <td><span className="pill pill-active">{c.policyCount}</span></td>
                  <td>{formatDate(c.createdAt)}</td>
                  <td><span className={`pill ${c.status === 'active' ? 'pill-active' : 'pill-lapsed'}`}>{c.status}</span></td>
                  <td>
                    <ActionMenu items={[
                      { label: 'Edit', onClick: () => setEditClient(c) },
                      { label: 'Assign Policy', onClick: () => setAssignPolicyClient(c) },
                      { label: 'Delete', onClick: () => handleDelete(c), danger: true, hidden: user?.role !== 'super_admin' },
                    ]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {showRegister && (
        <RegisterClientModal onClose={() => setShowRegister(false)} onSave={handleRegister} existingClients={clients} />
      )}
      {editClient && (
        <EditClientModal
          client={editClient}
          onClose={() => setEditClient(null)}
          onSave={handleEdit}
          onAssignPolicy={() => { setAssignPolicyClient(editClient); setEditClient(null) }}
        />
      )}
      {assignPolicyClient && (
        <NewPolicyModal
          initialClient={assignPolicyClient}
          onClose={() => setAssignPolicyClient(null)}
          onSave={handleAssignPolicy}
          showToast={showToast}
        />
      )}
      {blockedClient && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 560 }}>
            <div className="modal-header">
              <h3>Cannot Delete {blockedClient.name}</h3>
              <button className="modal-close" onClick={() => { setBlockedClient(null); setBlockedPolicies([]) }}>✕</button>
            </div>
            <div className="modal-body">
              <div className="info-banner info-banner-warning" style={{ marginBottom: 14 }}>
                A client cannot be deleted while policies exist against them — an
                active policy is a live contract. Remove the policies below, or
                close this window to leave {blockedClient.name} in place.
              </div>
              {blockedLoading ? (
                <div className="empty-state">Loading this client's policies…</div>
              ) : blockedPolicies.length > 0 ? (
                <table className="table">
                  <thead><tr><th>Policy No.</th><th>Product</th><th>Status</th><th></th></tr></thead>
                  <tbody>
                    {blockedPolicies.map(p => (
                      <tr key={p.id}>
                        <td><span className="mono">{p.policyNumber}</span></td>
                        <td>{p.productName}</td>
                        <td><span className={`pill pill-${p.status}`}>{p.status}</span></td>
                        <td>
                          {hasPermission('policies.delete') && (
                            <button
                              type="button"
                              className="btn btn-danger btn-sm"
                              disabled={deletingPolicyId === p.id}
                              onClick={() => quickDeletePolicy(p)}
                            >
                              {deletingPolicyId === p.id ? 'Deleting…' : 'Delete Policy'}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="empty-state">All policies removed — the client can now be deleted.</div>
              )}
              {!hasPermission('policies.delete') && blockedPolicies.length > 0 && (
                <div className="info-banner" style={{ marginTop: 10 }}>
                  You do not have the policies.delete permission — ask an Admin or Super Admin to remove these policies.
                </div>
              )}
            </div>
            <div className="modal-footer" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-ghost" onClick={() => { setBlockedClient(null); setBlockedPolicies([]) }}>Close</button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={blockedPolicies.length > 0 || blockedLoading}
                onClick={retryDeleteClient}
              >
                Delete Client
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
