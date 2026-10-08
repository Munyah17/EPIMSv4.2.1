import { useState, useEffect, useCallback } from 'react'
import type { Group, GroupMember, ToastMessage } from '../../types'
import { db } from '../../lib/db'
import { formatDate } from '../../lib/dateUtils'
import DateInput from '../ui/DateInput'
import PhoneInput from '../ui/PhoneInput'

interface Props {
  group: Group
  onClose: () => void
  showToast: (type: ToastMessage['type'], message: string) => void
  /** Called with the active-member count whenever the roster changes, so
   *  the Groups table pill stays in step without a full reload. */
  onMembersChanged?: (activeCount: number) => void
}

/** The organisation's covered roster — employees (corporate) or members
 *  (group schemes). Removed members are soft-deleted (status 'removed'),
 *  not erased, because historical claims may still reference them. */
export default function GroupMembersModal({ group, onClose, showToast, onMembersChanged }: Props) {
  const [members, setMembers] = useState<GroupMember[]>([])
  const [loading, setLoading] = useState(true)
  const [fullName, setFullName] = useState('')
  const [nationalId, setNationalId] = useState('')
  const [dob, setDob] = useState('')
  const [phone, setPhone] = useState('')
  const [position, setPosition] = useState('')
  const [memberNo, setMemberNo] = useState('')
  const [adding, setAdding] = useState(false)
  const [attempted, setAttempted] = useState(false)
  const memberWord = group.groupType === 'company' ? 'Employee' : 'Member'
  const nameMissing = attempted && !fullName.trim()

  const load = useCallback(async () => {
    const { data, error } = await db.groupMembers.list(group.id)
    if (error) showToast('error', error)
    setMembers(data ?? [])
    setLoading(false)
    onMembersChanged?.((data ?? []).filter(m => m.status === 'active').length)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group.id])

  useEffect(() => { void load() }, [load])

  const active = members.filter(m => m.status === 'active')
  const removed = members.filter(m => m.status === 'removed')

  const handleAdd = async () => {
    setAttempted(true)
    if (!fullName.trim()) { showToast('warning', `Enter the ${memberWord.toLowerCase()}'s full name.`); return }
    setAdding(true)
    const { data, error } = await db.groupMembers.add({
      groupId: group.id,
      fullName: fullName.trim(),
      nationalId: nationalId.trim() || undefined,
      dob: dob || undefined,
      phone: phone.trim() || undefined,
      position: position.trim() || undefined,
      memberNo: memberNo.trim() || undefined,
    })
    setAdding(false)
    if (error || !data) { showToast('error', error ?? 'Failed to add member.'); return }
    setFullName(''); setNationalId(''); setDob(''); setPhone(''); setPosition(''); setMemberNo('')
    await load()
    showToast('success', `${data.fullName} added to the roster.`)
  }

  const handleRemove = async (m: GroupMember) => {
    if (!window.confirm(`Remove ${m.fullName} from ${group.name}'s roster? They stop being covered from the next billing run.`)) return
    const { error } = await db.groupMembers.remove(m.id)
    if (error) { showToast('error', error); return }
    await load()
    showToast('info', `${m.fullName} removed from the roster.`)
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 860 }}>
        <div className="modal-header">
          <h3>{group.name} — {group.groupType === 'company' ? 'Employees' : 'Members'}</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="info-banner info-banner-info" style={{ marginBottom: '1rem' }}>
            {active.length} active {active.length === 1 ? memberWord.toLowerCase() : `${memberWord.toLowerCase()}s`} on the roster.
            Only active {memberWord.toLowerCase()}s can be added to a policy.
          </div>

          <div className="form-row" style={{ alignItems: 'flex-end' }}>
            <div className="form-group">
              <label>Full Name *</label>
              <input className={`form-control${nameMissing ? ' field-invalid' : ''}`} value={fullName} onChange={e => setFullName(e.target.value)} placeholder="Full name" />
            </div>
            <div className="form-group">
              <label>National ID</label>
              <input className="form-control" value={nationalId} onChange={e => setNationalId(e.target.value.replace(/-/g, ''))} placeholder="e.g. 632118532K12" />
            </div>
            <div className="form-group">
              <label>Date of Birth</label>
              <DateInput value={dob} onChange={setDob} />
            </div>
          </div>
          <div className="form-row" style={{ alignItems: 'flex-end' }}>
            <div className="form-group">
              <label>Phone</label>
              <PhoneInput value={phone} onChange={setPhone} />
            </div>
            <div className="form-group">
              <label>{group.groupType === 'company' ? 'Position / Job Title' : 'Role in Group'}</label>
              <input className="form-control" value={position} onChange={e => setPosition(e.target.value)} placeholder={group.groupType === 'company' ? 'e.g. Accountant' : 'e.g. Choir member'} />
            </div>
            <div className="form-group">
              <label>{memberWord} No.</label>
              <input className="form-control" value={memberNo} onChange={e => setMemberNo(e.target.value)} placeholder="Optional staff/member no." />
            </div>
            <div className="form-group">
              <button type="button" className="btn btn-primary btn-sm" onClick={handleAdd} disabled={adding}>
                {adding ? 'Adding…' : `+ Add ${memberWord}`}
              </button>
            </div>
          </div>

          <div className="tbl-scroll" style={{ marginTop: '0.75rem' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th><th>{memberWord} No.</th><th>National ID</th><th>Date of Birth</th><th>Phone</th><th>{group.groupType === 'company' ? 'Position' : 'Role'}</th><th>Added</th><th></th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={8} className="td-empty">Loading roster…</td></tr>
                ) : active.length === 0 ? (
                  <tr><td colSpan={8} className="td-empty">No active {memberWord.toLowerCase()}s yet — add the first above.</td></tr>
                ) : active.map(m => (
                  <tr key={m.id}>
                    <td><strong>{m.fullName}</strong></td>
                    <td className="mono">{m.memberNo ?? '—'}</td>
                    <td className="mono">{m.nationalId ?? '—'}</td>
                    <td>{m.dob ? formatDate(m.dob) : '—'}</td>
                    <td>{m.phone ?? '—'}</td>
                    <td>{m.position ?? '—'}</td>
                    <td>{formatDate(m.createdAt)}</td>
                    <td><button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} onClick={() => handleRemove(m)}>Remove</button></td>
                  </tr>
                ))}
                {removed.map(m => (
                  <tr key={m.id} style={{ opacity: 0.45 }}>
                    <td>{m.fullName}</td>
                    <td className="mono">{m.memberNo ?? '—'}</td>
                    <td className="mono">{m.nationalId ?? '—'}</td>
                    <td>{m.dob ? formatDate(m.dob) : '—'}</td>
                    <td>{m.phone ?? '—'}</td>
                    <td>{m.position ?? '—'}</td>
                    <td colSpan={2}><span className="pill pill-inactive">Removed</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
