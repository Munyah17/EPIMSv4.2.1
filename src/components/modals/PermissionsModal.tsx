import { useState } from 'react'
import type { AppUser } from '../../types'

interface Props {
  staff: AppUser
  onClose: () => void
  onSave: (staff: AppUser) => void
}

const ALL_PERMISSIONS = [
  { key: 'policies.view', label: 'View Policies' },
  { key: 'policies.create', label: 'Create Policies' },
  { key: 'policies.update', label: 'Update Policies' },
  { key: 'claims.view', label: 'View Claims' },
  { key: 'claims.update', label: 'Update Claims' },
  { key: 'payments.view', label: 'View Payments' },
  { key: 'payments.create', label: 'Record Payments' },
  { key: 'clients.view', label: 'View Clients' },
  { key: 'clients.create', label: 'Register Clients' },
  { key: 'clients.update', label: 'Edit Clients' },
  { key: 'reports.view', label: 'View Reports' },
  { key: 'leads.view', label: 'View Leads' },
  { key: 'leads.update', label: 'Update Leads' },
  { key: 'tickets.view', label: 'View Tickets' },
  { key: 'tickets.update', label: 'Manage Tickets' },
  { key: 'staff.view', label: 'View Staff' },
  { key: 'staff.manage', label: 'Manage Staff' },
]

export default function PermissionsModal({ staff, onClose, onSave }: Props) {
  const [perms, setPerms] = useState<Set<string>>(new Set(staff.permissions))

  const toggle = (key: string) => {
    setPerms(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const handleSave = () => {
    onSave({ ...staff, permissions: Array.from(perms) })
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 480 }}>
        <div className="modal-header">
          <h3>Permissions — {staff.name}</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <p style={{ color: 'var(--muted)', marginBottom: '1rem', fontSize: '0.85rem' }}>
            Role: <strong>{staff.role.replace(/_/g, ' ')}</strong>. Grant specific permissions below.
          </p>
          <div className="permissions-grid">
            {ALL_PERMISSIONS.map(p => (
              <label key={p.key} className="permission-item">
                <input
                  type="checkbox"
                  checked={perms.has(p.key) || staff.permissions.includes('all') || staff.permissions.includes('all_except_super')}
                  onChange={() => toggle(p.key)}
                  disabled={staff.permissions.includes('all') || staff.permissions.includes('all_except_super')}
                />
                <span>{p.label}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave}>Save Permissions</button>
        </div>
      </div>
    </div>
  )
}
