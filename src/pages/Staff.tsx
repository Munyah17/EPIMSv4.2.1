import { useState, useEffect, useCallback } from 'react'
import type { ToastMessage, AppUser, CustomRole, AgentProfile } from '../types'
import { SYSTEM_ROLES } from '../types'
import type { ActivePanel } from '../App'
import { db } from '../lib/db'
import { formatDate } from '../lib/dateUtils'
import { useAuth } from '../contexts/AuthContext'
import AddStaffModal from '../components/modals/AddStaffModal'
import PermissionsModal from '../components/modals/PermissionsModal'
import RoleManagerModal from '../components/modals/RoleManagerModal'
import ActionMenu from '../components/ui/ActionMenu'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
  setActivePanel: (panel: ActivePanel) => void
}

const ROLE_CLASS: Record<string, string> = {
  super_admin: 'role-super-admin',
  admin: 'role-admin',
  claims_officer: 'role-claims',
  policy_admin: 'role-policy',
  finance: 'role-finance',
  client_relations: 'role-cr',
}

const AVATAR_CLASS: Record<string, string> = {
  super_admin: 'avatar-danger',
  admin: 'avatar-blue',
  claims_officer: 'avatar-gold',
  policy_admin: 'avatar-teal',
  finance: 'avatar-purple',
  client_relations: 'avatar-teal',
}

export default function Staff({ showToast }: Props) {
  const { user } = useAuth()
  const [staff, setStaff] = useState<AppUser[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  // Staff and agents are different relationships: employees are salaried
  // and do internal work; agents are commission intermediaries onboarded
  // on contract for the field — separate tab, separate file.
  const [tab, setTab] = useState<'staff' | 'agents'>('staff')
  const [agentProfiles, setAgentProfiles] = useState<Map<string, AgentProfile>>(new Map())
  const [agentStats, setAgentStats] = useState<Map<string, { clients: number; policies: number; premium: number }>>(new Map())
  const [editAgentProfile, setEditAgentProfile] = useState<AgentProfile | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [addAsAgent, setAddAsAgent] = useState(false)
  const [editStaff, setEditStaff] = useState<AppUser | null>(null)
  const [permStaff, setPermStaff] = useState<AppUser | null>(null)
  const [showRoles, setShowRoles] = useState(false)
  const [editRole, setEditRole] = useState<CustomRole | null>(null)
  const [roles, setRoles] = useState<CustomRole[]>([])

  const loadRoles = useCallback(() => {
    db.customRoles.list().then(({ data }) => setRoles(data))
  }, [])

  useEffect(() => {
    db.staff.list().then(({ data, error }) => {
      if (error) showToast('error', 'Failed to load staff.')
      else if (data) {
        const people = data.filter(s => !(SYSTEM_ROLES as string[]).includes(s.role))
        setStaff(people)
        // Agent files + book stats load alongside — the two read together
        // or not at all, so a stale book never displays next to a fresh name.
        const agentIds = people.filter(s => s.role === 'agent').map(s => s.id)
        void db.agentProfiles.list().then(({ data: aps }) => {
          setAgentProfiles(new Map((aps ?? []).map(a => [a.profileId, a])))
        })
        void db.agentProfiles.bookStats(agentIds).then(({ data: stats }) => setAgentStats(stats))
      }
      setLoading(false)
    }).catch(() => { showToast('error', 'Failed to load staff.'); setLoading(false) })
    if (user?.role === 'super_admin') loadRoles()
  }, [showToast, user?.role, loadRoles])

  const employees = staff.filter(s => s.role !== 'agent')
  const agents = staff.filter(s => s.role === 'agent')
  const match = (s: AppUser) =>
    s.name.toLowerCase().includes(search.toLowerCase()) ||
    s.email.toLowerCase().includes(search.toLowerCase()) ||
    s.department.toLowerCase().includes(search.toLowerCase()) ||
    (agentProfiles.get(s.id)?.territory ?? '').toLowerCase().includes(search.toLowerCase())
  const filtered = (tab === 'staff' ? employees : agents).filter(match)

  const handleSave = async (s: AppUser, password: string, agentInput?: Omit<AgentProfile, 'profileId'>) => {
    let saved: AppUser | null = null
    if (editStaff) {
      const { data, error } = await db.staff.update(s.id, s)
      if (error || !data) { showToast('error', error ?? 'Failed to update staff.'); return }
      setStaff(prev => prev.map(x => x.id === data.id ? data : x))
      saved = data
    } else {
      const { data, error } = await db.staff.create({
        name: s.name, email: s.email, password, phone: s.phone, role: s.role, department: s.department,
        customRoleId: s.customRoleId, permissions: s.permissions,
      })
      if (error || !data) { showToast('error', error ?? 'Failed to add staff member.'); return }
      setStaff(prev => [...prev, data])
      saved = data
    }
    // The agent file follows the role — an agent without one has no
    // contract, no territory, no payout rails on record.
    if (saved.role === 'agent' && agentInput) {
      const { data: ap, error: apError } = await db.agentProfiles.upsert({ ...agentInput, profileId: saved.id })
      if (apError) showToast('error', `Profile saved but the agent file failed: ${apError}`)
      else if (ap) setAgentProfiles(prev => new Map(prev).set(saved!.id, ap))
    }
    showToast('success', editStaff ? `${saved.name} updated.` : saved.role === 'agent' ? `Agent ${saved.name} onboarded.` : `Staff member ${saved.name} added.`)
    setShowAdd(false)
    setEditStaff(null)
    setAddAsAgent(false)
    setEditAgentProfile(null)
  }

  /** Editing an agent loads their agent file too — the modal shows
   *  contract/territory/payout fields, not just the login row. */
  const openEdit = (s: AppUser) => {
    setEditStaff(s)
    setEditAgentProfile(null)
    if (s.role === 'agent') {
      void db.agentProfiles.get(s.id).then(({ data }) => setEditAgentProfile(data))
    }
    setShowAdd(true)
  }

  const handlePermissions = async (updated: AppUser) => {
    const { data, error } = await db.staff.update(updated.id, { permissions: updated.permissions, customRoleId: updated.customRoleId ?? '' })
    if (error || !data) { showToast('error', error ?? 'Failed to update permissions.'); return }
    setStaff(prev => prev.map(s => s.id === data.id ? data : s))
    showToast('success', `Permissions updated for ${data.name}.`)
    setPermStaff(null)
  }

  const toggleActive = async (id: string) => {
    const member = staff.find(s => s.id === id)
    if (!member) return
    const { data, error } = await db.staff.update(id, { active: !member.active })
    if (error || !data) { showToast('error', error ?? 'Failed to update status.'); return }
    setStaff(prev => prev.map(s => s.id === id ? data : s))
    showToast('info', 'Staff status updated.')
  }

  const handleDelete = async (member: AppUser) => {
    if (!window.confirm(`Permanently delete ${member.name}? This removes their account entirely; they will no longer be able to sign in. This cannot be undone.`)) return
    const { error } = await db.staff.remove(member.id)
    if (error) { showToast('error', error); return }
    setStaff(prev => prev.filter(s => s.id !== member.id))
    showToast('success', `${member.name} was deleted.`)
  }

  const handleResetPassword = async (staffId: string, newPassword: string) => {
    const { error } = await db.staff.resetPassword(staffId, newPassword)
    if (error) { showToast('error', error); return }
    showToast('success', 'Password reset successfully.')
  }

  return (
    <div className="panel">
      <div className="panel-toolbar">
        <input
          className="search-input"
          placeholder="Search name, email, department…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        {user?.role === 'super_admin' && (
          <button type="button" className="btn btn-ghost" onClick={() => { setEditRole(null); setShowRoles(true) }}>Manage Roles</button>
        )}
        <button type="button" className="btn btn-primary" onClick={() => { setAddAsAgent(tab === 'agents'); setShowAdd(true) }}>
          {tab === 'agents' ? '+ Onboard Agent' : '+ Add Staff'}
        </button>
      </div>

      {/* Employees and commission agents are different relationships —
          separate tabs so the agent book (territory, contract, commission,
          clients/policies written) doesn't drown in a staff table. */}
      <div className="tab-row">
        {([
          ['staff', 'Staff', employees.length],
          ['agents', 'Agents', agents.length],
        ] as const).map(([key, label, count]) => (
          <button key={key} type="button" className={`tab-item${tab === key ? ' active' : ''}`} onClick={() => setTab(key)}>
            {label} ({count})
          </button>
        ))}
      </div>

      <div className="card">
        {loading ? (
          <div className="empty-state">Loading…</div>
        ) : tab === 'staff' ? (
          <div className="tbl-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Department</th>
                <th>Phone</th>
                <th>Last Login</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={8} className="td-empty">No staff members found.</td></tr>
              ) : filtered.map(s => (
                <tr key={s.id}>
                  <td>
                    <div className="staff-name-cell">
                      <div className={`staff-avatar ${AVATAR_CLASS[s.role] ?? 'avatar-blue'}`}>
                        {s.name.charAt(0)}
                      </div>
                      <strong>{s.name}</strong>
                    </div>
                  </td>
                  <td>{s.email}</td>
                  <td>
                    <div className="status-pills">
                      <span className={`pill ${ROLE_CLASS[s.role] ?? 'role-admin'}`}>{s.role.replace(/_/g, ' ')}</span>
                      {s.customRoleName && <span className="pill pill-active">{s.customRoleName}</span>}
                    </div>
                  </td>
                  <td>{s.department}</td>
                  <td>{s.phone ?? '—'}</td>
                  <td>{formatDate(s.lastLogin)}</td>
                  <td><span className={`pill ${s.active ? 'pill-active' : 'pill-cancelled'}`}>{s.active ? 'Active' : 'Inactive'}</span></td>
                  <td>
                    <ActionMenu items={[
                      { label: 'Edit', onClick: () => openEdit(s) },
                      { label: 'Permissions', onClick: () => setPermStaff(s) },
                      { label: s.active ? 'Disable' : 'Enable', onClick: () => toggleActive(s.id) },
                      { label: 'Delete', onClick: () => handleDelete(s), danger: true, hidden: !(user?.role === 'super_admin' && s.role !== 'super_admin' && s.id !== user.id) },
                    ]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        ) : (
          <div className="tbl-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Contact</th>
                <th>Territory</th>
                <th>Contract Start</th>
                <th>Commission</th>
                <th>Book of Business</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={8} className="td-empty">No agents onboarded yet — use "+ Onboard Agent".</td></tr>
              ) : filtered.map(s => {
                const ap = agentProfiles.get(s.id)
                const book = agentStats.get(s.id)
                return (
                <tr key={s.id}>
                  <td>
                    <div className="staff-name-cell">
                      <div className="staff-avatar avatar-gold">
                        {s.name.charAt(0)}
                      </div>
                      <div>
                        <strong>{s.name}</strong>
                        {ap?.nationalId && <div style={{ fontSize: 11, color: 'var(--muted)' }}>{ap.nationalId}</div>}
                      </div>
                    </div>
                  </td>
                  <td>
                    <div style={{ fontSize: 12 }}>{s.phone ?? '—'}</div>
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>{s.email}</div>
                  </td>
                  <td>{ap?.territory ?? '—'}</td>
                  <td>{ap?.contractStart ? formatDate(ap.contractStart) : '—'}</td>
                  <td>{ap?.commissionPct != null ? `${ap.commissionPct}%` : <span style={{ color: 'var(--muted)' }}>product default</span>}</td>
                  <td>
                    {book ? (
                      <div style={{ fontSize: 12 }}>
                        {book.clients} client{book.clients === 1 ? '' : 's'} · {book.policies} polic{book.policies === 1 ? 'y' : 'ies'} · ${book.premium.toFixed(2)}/mo
                      </div>
                    ) : '—'}
                  </td>
                  <td><span className={`pill ${s.active ? 'pill-active' : 'pill-cancelled'}`}>{s.active ? 'Active' : 'Inactive'}</span></td>
                  <td>
                    <ActionMenu items={[
                      { label: 'Edit', onClick: () => openEdit(s) },
                      { label: s.active ? 'Suspend' : 'Reactivate', onClick: () => toggleActive(s.id) },
                      { label: 'Delete', onClick: () => handleDelete(s), danger: true, hidden: !(user?.role === 'super_admin' && s.id !== user.id) },
                    ]} />
                  </td>
                </tr>
                )
              })}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {/* User Roles — managed inline like Products: the table is the
          overview, the modal is the editor. Super Admin only; the roles
          themselves are reusable permission bundles assigned through each
          staff member's Permissions action above. */}
      {user?.role === 'super_admin' && (
        <div className="card" style={{ marginTop: '1rem' }}>
          <div className="card-header">
            <h3 style={{ fontSize: '0.95rem', fontWeight: 700 }}>User Roles</h3>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => { setEditRole(null); setShowRoles(true) }}>+ Add Role</button>
          </div>
          <div className="tbl-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Description</th>
                  <th>Rights</th>
                  <th>Assigned Staff</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {roles.length === 0 ? (
                  <tr><td colSpan={5} className="td-empty">No custom roles yet — create one to bundle permissions for a team.</td></tr>
                ) : roles.map(r => (
                  <tr key={r.id}>
                    <td><strong>{r.name}</strong></td>
                    <td>{r.description || '—'}</td>
                    <td>{r.permissions.length} right{r.permissions.length === 1 ? '' : 's'}</td>
                    <td>{staff.filter(s => s.customRoleId === r.id).length}</td>
                    <td>
                      <ActionMenu items={[
                        { label: 'Edit', onClick: () => { setEditRole(r); setShowRoles(true) } },
                        { label: 'Delete', danger: true, onClick: async () => {
                          if (!window.confirm(`Delete the "${r.name}" role? Staff assigned to it keep their current permissions but lose the role label.`)) return
                          const { error } = await db.customRoles.remove(r.id)
                          if (error) { showToast('error', error); return }
                          setRoles(prev => prev.filter(x => x.id !== r.id))
                          showToast('success', `Role "${r.name}" deleted.`)
                        } },
                      ]} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {(showAdd || editStaff) && (
        <AddStaffModal
          staff={editStaff}
          agentProfile={editAgentProfile}
          fixedRole={addAsAgent ? 'agent' : undefined}
          onClose={() => { setShowAdd(false); setEditStaff(null); setAddAsAgent(false); setEditAgentProfile(null) }}
          onSave={handleSave}
          onResetPassword={handleResetPassword}
        />
      )}
      {permStaff && (
        <PermissionsModal
          staff={permStaff}
          onClose={() => setPermStaff(null)}
          onSave={handlePermissions}
        />
      )}
      {showRoles && (
        <RoleManagerModal
          onClose={() => { setShowRoles(false); setEditRole(null) }}
          showToast={showToast}
          initialRole={editRole}
          onChanged={loadRoles}
        />
      )}
    </div>
  )
}
