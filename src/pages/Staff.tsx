import { useState, useEffect } from 'react'
import type { ToastMessage, AppUser } from '../types'
import type { ActivePanel } from '../App'
import { db } from '../lib/db'
import AddStaffModal from '../components/modals/AddStaffModal'
import PermissionsModal from '../components/modals/PermissionsModal'

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
  const [staff, setStaff] = useState<AppUser[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [editStaff, setEditStaff] = useState<AppUser | null>(null)
  const [permStaff, setPermStaff] = useState<AppUser | null>(null)

  useEffect(() => {
    db.staff.list().then(({ data, error }) => {
      if (error) showToast('error', 'Failed to load staff.')
      else if (data) setStaff(data)
      setLoading(false)
    })
  }, [showToast])

  const filtered = staff.filter(s =>
    s.name.toLowerCase().includes(search.toLowerCase()) ||
    s.email.toLowerCase().includes(search.toLowerCase()) ||
    s.department.toLowerCase().includes(search.toLowerCase())
  )

  const handleSave = async (s: AppUser, password: string) => {
    if (editStaff) {
      const { data, error } = await db.staff.update(s.id, s)
      if (error || !data) { showToast('error', 'Failed to update staff.'); return }
      setStaff(prev => prev.map(x => x.id === data.id ? data : x))
      showToast('success', `Staff member ${data.name} updated.`)
    } else {
      const { data, error } = await db.staff.create({
        name: s.name, email: s.email, password, phone: s.phone, role: s.role, department: s.department,
      })
      if (error || !data) { showToast('error', error ?? 'Failed to add staff member.'); return }
      setStaff(prev => [...prev, data])
      showToast('success', `Staff member ${data.name} added.`)
    }
    setShowAdd(false)
    setEditStaff(null)
  }

  const handlePermissions = async (updated: AppUser) => {
    const { data, error } = await db.staff.update(updated.id, { permissions: updated.permissions })
    if (error || !data) { showToast('error', 'Failed to update permissions.'); return }
    setStaff(prev => prev.map(s => s.id === data.id ? data : s))
    showToast('success', `Permissions updated for ${data.name}.`)
    setPermStaff(null)
  }

  const toggleActive = async (id: string) => {
    const member = staff.find(s => s.id === id)
    if (!member) return
    const { data, error } = await db.staff.update(id, { active: !member.active })
    if (error || !data) { showToast('error', 'Failed to update status.'); return }
    setStaff(prev => prev.map(s => s.id === id ? data : s))
    showToast('info', 'Staff status updated.')
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
        <button type="button" className="btn btn-primary" onClick={() => setShowAdd(true)}>+ Add Staff</button>
      </div>

      <div className="card">
        {loading ? (
          <div className="empty-state">Loading staff…</div>
        ) : (
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
              {filtered.map(s => (
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
                  <td><span className={`pill ${ROLE_CLASS[s.role] ?? 'role-admin'}`}>{s.role.replace(/_/g, ' ')}</span></td>
                  <td>{s.department}</td>
                  <td>{s.phone ?? '—'}</td>
                  <td>{s.lastLogin ? new Date(s.lastLogin).toLocaleDateString() : '—'}</td>
                  <td><span className={`pill ${s.active ? 'pill-active' : 'pill-cancelled'}`}>{s.active ? 'Active' : 'Inactive'}</span></td>
                  <td>
                    <div className="action-btns">
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setEditStaff(s); setShowAdd(true) }}>Edit</button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPermStaff(s)}>Perms</button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => toggleActive(s.id)}>
                        {s.active ? 'Disable' : 'Enable'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {(showAdd || editStaff) && (
        <AddStaffModal
          staff={editStaff}
          onClose={() => { setShowAdd(false); setEditStaff(null) }}
          onSave={handleSave}
        />
      )}
      {permStaff && (
        <PermissionsModal
          staff={permStaff}
          onClose={() => setPermStaff(null)}
          onSave={handlePermissions}
        />
      )}
    </div>
  )
}
