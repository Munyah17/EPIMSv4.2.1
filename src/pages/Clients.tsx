import { useState, useEffect } from 'react'
import type { ToastMessage, Client, Policy } from '../types'
import type { ActivePanel } from '../App'
import { db } from '../lib/db'
import { formatDate } from '../lib/dateUtils'
import { useAuth } from '../contexts/AuthContext'
import RegisterClientModal from '../components/modals/RegisterClientModal'
import EditClientModal from '../components/modals/EditClientModal'
import NewPolicyModal from '../components/modals/NewPolicyModal'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
  setActivePanel: (panel: ActivePanel) => void
}

export default function Clients({ showToast }: Props) {
  const { user } = useAuth()
  const [clients, setClients] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [showRegister, setShowRegister] = useState(false)
  const [editClient, setEditClient] = useState<Client | null>(null)
  const [assignPolicyClient, setAssignPolicyClient] = useState<Client | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  useEffect(() => {
    db.clients.list().then(({ data, error }) => {
      if (error) showToast('error', 'Failed to load clients.')
      else if (data) setClients(data)
      setLoading(false)
    })
  }, [showToast])

  const filtered = clients.filter(c =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    c.phone.includes(search) ||
    c.nationalId.includes(search) ||
    c.email.toLowerCase().includes(search.toLowerCase())
  )

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
    const { data, error } = await db.clients.create(client)
    if (error || !data) { showToast('error', 'Failed to register client.'); return }
    setClients(prev => [data, ...prev])
    showToast('success', `Client ${data.name} registered.`)
    setShowRegister(false)
  }

  const handleEdit = async (updated: Client) => {
    const { data, error } = await db.clients.update(updated.id, updated)
    if (error || !data) { showToast('error', 'Failed to update client.'); return }
    setClients(prev => prev.map(c => c.id === data.id ? data : c))
    showToast('success', `Client ${data.name} updated.`)
    setEditClient(null)
  }

  const handleAssignPolicy = async (policy: Policy) => {
    const { data, error } = await db.policies.create(policy)
    if (error || !data) { showToast('error', 'Failed to create policy.'); return }
    setClients(prev => prev.map(c => c.id === data.clientId ? { ...c, policyCount: c.policyCount + 1 } : c))
    showToast('success', `Policy ${data.policyNumber} assigned to ${data.clientName}.`)
    setAssignPolicyClient(null)
  }

  const handleDelete = async (client: Client) => {
    if (!window.confirm(`Permanently delete ${client.name}? This cannot be undone.`)) return
    const { error } = await db.clients.remove(client.id)
    if (error) { showToast('error', error); return }
    setClients(prev => prev.filter(c => c.id !== client.id))
    showToast('success', `${client.name} was deleted.`)
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
            placeholder="Search name, phone, ID, email…"
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

      <div className="card">
        {loading ? (
          <div className="empty-state">Loading clients…</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th aria-label="Select all"><input type="checkbox" title="Select all" checked={selected.size === filtered.length && filtered.length > 0} onChange={toggleAll} /></th>
                <th>Name</th>
                <th>Phone</th>
                <th>National ID</th>
                <th>Email</th>
                <th>Insurer</th>
                <th>Policies</th>
                <th>Joined</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={10} className="td-empty">No clients found.</td></tr>
              ) : filtered.map(c => (
                <tr key={c.id} className={selected.has(c.id) ? 'row-selected' : ''}>
                  <td><input type="checkbox" title={`Select ${c.name}`} checked={selected.has(c.id)} onChange={() => toggleSelect(c.id)} /></td>
                  <td><strong>{c.name}</strong></td>
                  <td>{c.phone}</td>
                  <td><span className="mono">{c.nationalId}</span></td>
                  <td>{c.email}</td>
                  <td>{c.insurer ?? '—'}</td>
                  <td><span className="pill pill-active">{c.policyCount}</span></td>
                  <td>{formatDate(c.createdAt)}</td>
                  <td><span className={`pill ${c.status === 'active' ? 'pill-active' : 'pill-lapsed'}`}>{c.status}</span></td>
                  <td>
                    <div className="action-btns">
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditClient(c)}>Edit</button>
                      {c.policyCount === 0 && (
                        <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--blue)' }} onClick={() => setAssignPolicyClient(c)}>Assign Policy</button>
                      )}
                      {user?.role === 'super_admin' && (
                        <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} onClick={() => handleDelete(c)}>Delete</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showRegister && (
        <RegisterClientModal onClose={() => setShowRegister(false)} onSave={handleRegister} />
      )}
      {editClient && (
        <EditClientModal
          client={editClient}
          onClose={() => setEditClient(null)}
          onSave={handleEdit}
          onAssignPolicy={editClient.policyCount === 0 ? () => { setAssignPolicyClient(editClient); setEditClient(null) } : undefined}
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
    </div>
  )
}
