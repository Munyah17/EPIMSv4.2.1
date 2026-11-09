import { useState, useEffect, useCallback } from 'react'
import type { Group, GroupMember, ToastMessage } from '../../types'
import { db } from '../../lib/db'
import { formatDate, toIsoDate } from '../../lib/dateUtils'
import { exportToCsv, exportToExcel, exportReportToPdf } from '../../lib/exportUtils'
import DateInput from '../ui/DateInput'
import PhoneInput from '../ui/PhoneInput'
import { isNationalId, cleanNationalIdInput, isZwPhone } from '../../lib/validation'

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
  // Group insurance is negotiated: every member carries their own agreed
  // premium and sum assured — required on add/edit, never product defaults.
  const [premium, setPremium] = useState('')
  const [coverAmount, setCoverAmount] = useState('')
  const [editing, setEditing] = useState<GroupMember | null>(null)
  const [adding, setAdding] = useState(false)
  const [attempted, setAttempted] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const memberWord = group.groupType === 'company' ? 'Employee' : 'Member'
  const nameMissing = attempted && !fullName.trim()
  // ID and DOB are the member's identity to the insurer — a claim can't
  // be verified against a roster row that has neither.
  const natIdMissing = attempted && (!nationalId.trim() || !isNationalId(nationalId))
  const dobMissing = attempted && !dob
  const premiumMissing = attempted && !(Number(premium) > 0)
  const coverMissing = attempted && !(Number(coverAmount) > 0)
  const phoneInvalid = attempted && !!phone.trim() && !isZwPhone(phone)

  const fill = (m: GroupMember | null) => {
    setEditing(m)
    setFullName(m?.fullName ?? ''); setNationalId(m?.nationalId ?? ''); setDob(m?.dob ?? '')
    setPhone(m?.phone ?? ''); setPosition(m?.position ?? ''); setMemberNo(m?.memberNo ?? '')
    setPremium(m?.premium != null ? String(m.premium) : ''); setCoverAmount(m?.coverAmount != null ? String(m.coverAmount) : '')
    setAttempted(false)
  }

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
    if (!fullName.trim() || !nationalId.trim() || !dob || !(Number(premium) > 0) || !(Number(coverAmount) > 0)) {
      showToast('warning', `A ${memberWord.toLowerCase()} needs a name, National ID, date of birth, a premium and a sum assured — capture all of them to continue.`)
      return
    }
    if (!isNationalId(nationalId) || (phone.trim() && !isZwPhone(phone))) {
      showToast('warning', 'Check the highlighted fields — National ID is 8–9 digits, a letter, then 2 digits (e.g. 632118532K12); phone is +263XXXXXXXXX or 0XXXXXXXXX.')
      return
    }
    setAdding(true)
    const fields = {
      fullName: fullName.trim(),
      nationalId: nationalId.trim() || undefined,
      dob: dob || undefined,
      phone: phone.trim() || undefined,
      position: position.trim() || undefined,
      memberNo: memberNo.trim() || undefined,
      premium: Number(premium),
      coverAmount: Number(coverAmount),
    }
    if (editing) {
      const { data, error } = await db.groupMembers.update(editing.id, fields)
      setAdding(false)
      if (error || !data) { showToast('error', error ?? 'Failed to update member.'); return }
      fill(null)
      await load()
      showToast('success', `${data.fullName} updated.`)
      return
    }
    const { data, error } = await db.groupMembers.add({ groupId: group.id, ...fields })
    setAdding(false)
    if (error || !data) { showToast('error', error ?? 'Failed to add member.'); return }
    fill(null)
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

  // The whole roster — removed members included, marked by status, since
  // the exported file is usually the record of who was ever covered.
  const handleExport = async (format: 'xlsx' | 'csv' | 'pdf') => {
    setExporting(true)
    const safeName = group.name.replace(/[^\w -]/g, '').trim().replace(/\s+/g, '-')
    const base = `${safeName}-roster-${toIsoDate(new Date())}`
    const roleLabel = group.groupType === 'company' ? 'Position' : 'Role'
    // 'Member No.' stays generic — rosters belong to churches, schools,
    // burial societies and carnivals as much as to companies.
    const headers = ['Name', 'Member No.', 'National ID', 'Date of Birth', 'Phone', roleLabel, 'Premium', 'Sum Assured', 'Added', 'Status']
    const rows = members.map(m => [
      m.fullName,
      m.memberNo ?? '',
      m.nationalId ?? '',
      m.dob ? formatDate(m.dob) : '',
      m.phone ?? '',
      m.position ?? '',
      m.premium ?? '',
      m.coverAmount ?? '',
      formatDate(m.createdAt),
      m.status === 'active' ? 'Active' : 'Removed',
    ])
    const subtitle = `${group.name} — ${active.length} active ${memberWord.toLowerCase()}${active.length === 1 ? '' : 's'}${removed.length ? `, ${removed.length} removed` : ''} — generated ${formatDate(new Date())}`
    const stats = [
      { label: `Active ${memberWord.toLowerCase()}s`, value: String(active.length) },
      { label: 'Monthly premium', value: `$${active.reduce((s, m) => s + (m.premium ?? 0), 0).toFixed(2)}` },
      { label: 'Total sum assured', value: `$${active.reduce((s, m) => s + (m.coverAmount ?? 0), 0).toLocaleString()}` },
    ]
    try {
      if (format === 'csv') {
        exportToCsv(`${base}.csv`, headers, rows)
      } else if (format === 'xlsx') {
        await exportToExcel(`${base}.xlsx`, group.name, headers, rows)
      } else {
        await exportReportToPdf(`${base}.pdf`, `${group.name} — ${memberWord} Roster`, subtitle, stats, headers, rows)
      }
      showToast('success', `Roster exported as ${format.toUpperCase()}.`)
    } catch {
      showToast('error', `Failed to export as ${format.toUpperCase()}.`)
    }
    setExporting(false)
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 860 }}>
        <div className="modal-header">
          <h3>{group.name} — {group.groupType === 'company' ? 'Employees' : 'Members'}</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', marginBottom: '1rem' }}>
            <div className="info-banner info-banner-info" style={{ marginBottom: 0, flex: 1 }}>
              {active.length} active {active.length === 1 ? memberWord.toLowerCase() : `${memberWord.toLowerCase()}s`} on the roster.
              Only active {memberWord.toLowerCase()}s can be added to a policy.
            </div>
            <div className="action-menu" style={{ position: 'relative' }}>
              <button type="button" className="btn btn-ghost btn-sm" disabled={exporting || members.length === 0} onClick={() => setExportOpen(o => !o)}>
                {exporting ? 'Exporting…' : 'Export ▾'}
              </button>
              {exportOpen && (
                <>
                  <div className="dropdown-backdrop" onClick={() => setExportOpen(false)} />
                  <div className="profile-dropdown" style={{ minWidth: 170, right: 0, left: 'auto' }}>
                    {([['pdf', 'PDF (.pdf)'], ['xlsx', 'Excel (.xlsx)'], ['csv', 'CSV (.csv)']] as const).map(([f, label]) => (
                      <button key={f} type="button" className="dropdown-item" style={{ width: '100%', border: 'none', background: 'none', cursor: 'pointer' }}
                        onClick={() => { setExportOpen(false); void handleExport(f) }}>
                        {label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="form-row" style={{ alignItems: 'flex-end' }}>
            <div className="form-group">
              <label>Full Name *</label>
              <input className={`form-control${nameMissing ? ' field-invalid' : ''}`} value={fullName} onChange={e => setFullName(e.target.value)} placeholder="Full name" />
            </div>
            <div className="form-group">
              <label>National ID *</label>
              <input className={`form-control${natIdMissing ? ' field-invalid' : ''}`} value={nationalId} onChange={e => setNationalId(cleanNationalIdInput(e.target.value))} placeholder="e.g. 632118532K12" />
            </div>
            <div className="form-group" style={dobMissing ? { outline: '1px solid var(--danger)', borderRadius: 7, outlineOffset: 2 } : undefined}>
              <label>Date of Birth *</label>
              <DateInput value={dob} onChange={setDob} />
            </div>
          </div>
          <div className="form-row" style={{ alignItems: 'flex-end' }}>
            <div className="form-group" style={phoneInvalid ? { outline: '1px solid var(--danger)', borderRadius: 7, outlineOffset: 2 } : undefined}>
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
          </div>
          <div className="form-row" style={{ alignItems: 'flex-end' }}>
            {/* Negotiated per member — the agreed terms for THIS person,
                not the product's defaults. */}
            <div className="form-group">
              <label>Premium *</label>
              <input type="number" min={0} step="0.01" className={`form-control${premiumMissing ? ' field-invalid' : ''}`} value={premium} onChange={e => setPremium(e.target.value)} placeholder="Agreed premium" />
            </div>
            <div className="form-group">
              <label>Sum Assured *</label>
              <input type="number" min={0} step="0.01" className={`form-control${coverMissing ? ' field-invalid' : ''}`} value={coverAmount} onChange={e => setCoverAmount(e.target.value)} placeholder="Agreed cover" />
            </div>
            <div className="form-group">
              <button type="button" className="btn btn-primary btn-sm" onClick={handleAdd} disabled={adding}>
                {adding ? 'Saving…' : editing ? `Save ${memberWord}` : `+ Add ${memberWord}`}
              </button>
              {editing && (
                <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: 6 }} onClick={() => fill(null)}>Cancel</button>
              )}
            </div>
          </div>

          <div className="tbl-scroll" style={{ marginTop: '0.75rem' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th><th>{memberWord} No.</th><th>National ID</th><th>Date of Birth</th><th>Phone</th><th>{group.groupType === 'company' ? 'Position' : 'Role'}</th><th>Premium</th><th>Sum Assured</th><th>Added</th><th></th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={10} className="td-empty">Loading roster…</td></tr>
                ) : active.length === 0 ? (
                  <tr><td colSpan={10} className="td-empty">No active {memberWord.toLowerCase()}s yet — add the first above.</td></tr>
                ) : active.map(m => (
                  <tr key={m.id}>
                    <td><strong>{m.fullName}</strong></td>
                    <td className="mono">{m.memberNo ?? '—'}</td>
                    <td className="mono">{m.nationalId ?? '—'}</td>
                    <td>{m.dob ? formatDate(m.dob) : '—'}</td>
                    <td>{m.phone ?? '—'}</td>
                    <td>{m.position ?? '—'}</td>
                    <td>{m.premium != null ? `$${m.premium.toFixed(2)}` : '—'}</td>
                    <td>{m.coverAmount != null ? `$${m.coverAmount.toLocaleString()}` : '—'}</td>
                    <td>{formatDate(m.createdAt)}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => fill(m)}>Edit</button>
                        <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} onClick={() => handleRemove(m)}>Remove</button>
                      </div>
                    </td>
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
                    <td>{m.premium != null ? `$${m.premium.toFixed(2)}` : '—'}</td>
                    <td>{m.coverAmount != null ? `$${m.coverAmount.toLocaleString()}` : '—'}</td>
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
