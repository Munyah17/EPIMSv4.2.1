import { useState } from 'react'
import type { AppUser, UserRole } from '../../types'

interface Props {
  staff: AppUser | null
  onClose: () => void
  onSave: (staff: AppUser) => void
}

const ROLES: UserRole[] = ['admin', 'claims_officer', 'policy_admin', 'finance', 'client_relations']
const DEPARTMENTS = ['Claims', 'Policy Administration', 'Finance', 'Client Relations', 'Administration', 'IT']

export default function AddStaffModal({ staff, onClose, onSave }: Props) {
  const [name, setName] = useState(staff?.name ?? '')
  const [email, setEmail] = useState(staff?.email ?? '')
  const [phone, setPhone] = useState(staff?.phone ?? '')
  const [role, setRole] = useState<UserRole>(staff?.role ?? 'client_relations')
  const [department, setDepartment] = useState(staff?.department ?? 'Client Relations')
  const [password, setPassword] = useState('')

  const handleSave = () => {
    if (!name || !email) return
    const member: AppUser = {
      id: staff?.id ?? `u${Date.now()}`,
      name, email, phone, role, department,
      active: true,
      permissions: [],
      password: password || staff?.password || 'staff1234',
    }
    onSave(member)
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 520 }}>
        <div className="modal-header">
          <h3>{staff ? 'Edit Staff Member' : 'Add Staff Member'}</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="form-row">
            <div className="form-group">
              <label>Full Name *</label>
              <input className="form-control" value={name} onChange={e => setName(e.target.value)} placeholder="Full name" />
            </div>
            <div className="form-group">
              <label>Email Address *</label>
              <input type="email" className="form-control" value={email} onChange={e => setEmail(e.target.value)} placeholder="staff@tariqify.com" />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Phone Number</label>
              <input className="form-control" value={phone} onChange={e => setPhone(e.target.value)} placeholder="+263 7X XXX XXXX" />
            </div>
            <div className="form-group">
              <label>Role *</label>
              <select className="form-control" value={role} onChange={e => setRole(e.target.value as UserRole)}>
                {ROLES.map(r => <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Department</label>
              <select className="form-control" value={department} onChange={e => setDepartment(e.target.value)}>
                {DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>{staff ? 'New Password (leave blank to keep)' : 'Temporary Password'}</label>
              <input type="password" className="form-control" value={password} onChange={e => setPassword(e.target.value)} placeholder={staff ? 'Leave blank to keep' : 'staff1234'} />
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={!name || !email}>
            {staff ? 'Save Changes' : 'Add Staff Member'}
          </button>
        </div>
      </div>
    </div>
  )
}
