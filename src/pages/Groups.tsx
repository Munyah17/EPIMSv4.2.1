import { useState, useEffect } from 'react'
import type { ToastMessage, Group } from '../types'
import type { ActivePanel } from '../App'
import { db } from '../lib/db'
import { formatDate } from '../lib/dateUtils'
import { useAuth } from '../contexts/AuthContext'
import GroupModal, { groupTypeLabel, type GroupInput } from '../components/modals/GroupModal'
import GroupMembersModal from '../components/modals/GroupMembersModal'
import ActionMenu from '../components/ui/ActionMenu'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
  setActivePanel: (panel: ActivePanel) => void
}

/**
 * Organisations that hold cover on behalf of people who belong to them —
 * a company covering its employees (corporate) or a church/union/club
 * covering its members (group). The people covered live on each group's
 * roster (GroupMembersModal) and are picked from it when a corporate or
 * group policy is written in NewPolicyModal.
 */
export default function Groups({ showToast }: Props) {
  const { user } = useAuth()
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [editGroup, setEditGroup] = useState<Group | null>(null)
  const [rosterGroup, setRosterGroup] = useState<Group | null>(null)

  useEffect(() => {
    db.groups.list().then(({ data, error }) => {
      if (error) showToast('error', 'Failed to load groups.')
      else if (data) setGroups(data)
      setLoading(false)
    }).catch(() => { showToast('error', 'Failed to load groups.'); setLoading(false) })
  }, [showToast])

  const q = search.trim().toLowerCase()
  const filtered = groups.filter(g =>
    g.name.toLowerCase().includes(q) ||
    (g.registrationNumber ?? '').toLowerCase().includes(q) ||
    (g.contactName ?? '').toLowerCase().includes(q) ||
    (g.contactPhone ?? '').includes(search.trim())
  )

  const handleSave = async (input: GroupInput) => {
    if (editGroup) {
      const { data, error } = await db.groups.update(editGroup.id, input)
      if (error || !data) { showToast('error', error ?? 'Failed to update group.'); return }
      setGroups(prev => prev.map(g => g.id === data.id ? data : g))
      showToast('success', `Group ${data.name} updated.`)
    } else {
      const { data, error } = await db.groups.create(input)
      if (error || !data) { showToast('error', error ?? 'Failed to create group.'); return }
      // The list comes back ordered by name — keep that order locally so a
      // freshly added group doesn't jump to the bottom until next load.
      setGroups(prev => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)))
      showToast('success', `Group ${data.name} created.`)
    }
    setShowAdd(false)
    setEditGroup(null)
  }

  const toggleActive = async (group: Group) => {
    const { data, error } = await db.groups.update(group.id, { active: !group.active })
    if (error || !data) { showToast('error', error ?? 'Failed to update group status.'); return }
    setGroups(prev => prev.map(g => g.id === data.id ? data : g))
    showToast('info', `${data.name} ${data.active ? 'enabled' : 'disabled'} — ${data.active ? 'it can' : 'it cannot'} be picked for new policies.`)
  }

  const handleDelete = async (group: Group) => {
    if (!window.confirm(`Permanently delete ${group.name}? Its member roster is removed with it. This cannot be undone.`)) return
    const { error } = await db.groups.remove(group.id)
    if (error) { showToast('error', error); return }
    setGroups(prev => prev.filter(g => g.id !== group.id))
    showToast('success', `${group.name} was deleted.`)
  }

  return (
    <div className="panel">
      <div className="panel-toolbar">
        <input
          className="search-input"
          placeholder="Search name, registration no., contact person, phone…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <button type="button" className="btn btn-primary" onClick={() => { setEditGroup(null); setShowAdd(true) }}>+ Add Group</button>
      </div>

      <div className="card">
        {loading ? (
          <div className="empty-state">Loading groups…</div>
        ) : (
          <div className="tbl-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Contact Person</th>
                <th>Phone</th>
                <th>Members</th>
                <th>Registered</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={8} className="td-empty">
                  {groups.length === 0
                    ? 'No groups yet — register a company, church, union or club to cover its people under one policy.'
                    : 'No groups found.'}
                </td></tr>
              ) : filtered.map(g => (
                <tr key={g.id}>
                  <td>
                    <strong>{g.name}</strong>
                    {g.registrationNumber && (
                      <div style={{ fontSize: 11, color: 'var(--muted)' }} className="mono">Reg. {g.registrationNumber}</div>
                    )}
                  </td>
                  <td><span className={`pill ${g.groupType === 'company' ? 'pill-blue' : 'pill-purple'}`}>{groupTypeLabel(g)}</span></td>
                  <td>{g.contactName ?? '—'}</td>
                  <td>{g.contactPhone ?? '—'}</td>
                  <td>
                    <span className="pill pill-active">{g.memberCount ?? 0}</span>
                    {g.expectedMembers ? <span style={{ fontSize: 11, color: 'var(--muted)' }}> of {g.expectedMembers} expected</span> : null}
                  </td>
                  <td>{formatDate(g.createdAt)}</td>
                  <td><span className={`pill ${g.active ? 'pill-active' : 'pill-inactive'}`}>{g.active ? 'Active' : 'Inactive'}</span></td>
                  <td>
                    <ActionMenu items={[
                      { label: 'Manage Members', onClick: () => setRosterGroup(g) },
                      { label: 'Edit', onClick: () => { setEditGroup(g); setShowAdd(true) } },
                      { label: g.active ? 'Disable' : 'Enable', onClick: () => toggleActive(g) },
                      // Hard-gated to Super Admin like client/staff deletes —
                      // policies reference the group, so removal is destructive.
                      { label: 'Delete', onClick: () => handleDelete(g), danger: true, hidden: user?.role !== 'super_admin' },
                    ]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {(showAdd || editGroup) && (
        <GroupModal
          group={editGroup}
          onClose={() => { setShowAdd(false); setEditGroup(null) }}
          onSave={handleSave}
        />
      )}
      {rosterGroup && (
        <GroupMembersModal
          group={rosterGroup}
          onClose={() => setRosterGroup(null)}
          showToast={showToast}
          // Keep the table's member-count pill in step with roster changes
          // without a full reload — only active members count.
          onMembersChanged={count => setGroups(prev => prev.map(g => g.id === rosterGroup.id ? { ...g, memberCount: count } : g))}
        />
      )}
    </div>
  )
}
