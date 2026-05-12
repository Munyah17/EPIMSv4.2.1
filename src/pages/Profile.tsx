import { useState } from 'react'
import type { ToastMessage } from '../types'
import type { ActivePanel } from '../App'
import { useAuth } from '../contexts/AuthContext'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
  setActivePanel: (panel: ActivePanel) => void
}

export default function Profile({ showToast }: Props) {
  const { user } = useAuth()
  const [activeTab, setActiveTab] = useState<'info' | 'password' | 'notifications' | 'audit'>('info')
  const [name, setName] = useState(user?.name ?? '')
  const [phone, setPhone] = useState(user?.phone ?? '')
  const [currentPwd, setCurrentPwd] = useState('')
  const [newPwd, setNewPwd] = useState('')
  const [confirmPwd, setConfirmPwd] = useState('')

  const saveInfo = () => {
    showToast('success', 'Profile updated successfully.')
  }

  const changePwd = () => {
    if (!currentPwd) { showToast('warning', 'Enter your current password.'); return }
    if (newPwd !== confirmPwd) { showToast('error', 'New passwords do not match.'); return }
    if (newPwd.length < 8) { showToast('warning', 'Password must be at least 8 characters.'); return }
    showToast('success', 'Password changed successfully.')
    setCurrentPwd(''); setNewPwd(''); setConfirmPwd('')
  }

  const auditLog = [
    { action: 'Login', detail: 'Signed in from 192.168.1.1', time: '2026-05-09 08:00' },
    { action: 'Policy Created', detail: 'Policy EMA-2024-010 for Munyaradzi Gumbo', time: '2026-05-08 14:30' },
    { action: 'Claim Updated', detail: 'Claim CLM-2026-001 status → under_review', time: '2026-05-08 10:15' },
    { action: 'Login', detail: 'Signed in from 192.168.1.1', time: '2026-05-08 08:00' },
    { action: 'Staff Password Reset', detail: 'Reset for Blessing Moyo', time: '2026-05-07 16:45' },
  ]

  return (
    <div className="panel">
      <div className="profile-layout">
        <div className="profile-card">
          <div className="profile-avatar-large">{user?.name.charAt(0)}</div>
          <div className="profile-name">{user?.name}</div>
          <div className="profile-role">{user?.role.replace(/_/g, ' ')}</div>
          <div className="profile-dept">{user?.department}</div>
          <div className="profile-email">{user?.email}</div>
        </div>

        <div className="profile-content">
          <div className="tabs">
            {([['info', 'Profile Info'], ['password', 'Change Password'], ['notifications', 'Notifications'], ...(user?.role !== 'policyholder' ? [['audit', 'Audit Log']] : [])]).map(([t, label]) => (
              <button key={t as string} className={`tab${activeTab === t ? ' active' : ''}`} onClick={() => setActiveTab(t as typeof activeTab)}>
                {label as string}
              </button>
            ))}
          </div>

          {activeTab === 'info' && (
            <div className="card">
              <div className="form-group">
                <label>Full Name</label>
                <input className="form-control" value={name} onChange={e => setName(e.target.value)} />
              </div>
              <div className="form-group">
                <label>Email Address</label>
                <input className="form-control" value={user?.email ?? ''} disabled style={{ opacity: 0.6 }} />
              </div>
              <div className="form-group">
                <label>Phone Number</label>
                <input className="form-control" value={phone} onChange={e => setPhone(e.target.value)} placeholder="+263 7X XXX XXXX" />
              </div>
              <div className="form-group">
                <label>Role</label>
                <input className="form-control" value={user?.role.replace(/_/g, ' ') ?? ''} disabled style={{ opacity: 0.6 }} />
              </div>
              <div className="form-group">
                <label>Department</label>
                <input className="form-control" value={user?.department ?? ''} disabled style={{ opacity: 0.6 }} />
              </div>
              <button className="btn btn-primary" onClick={saveInfo}>Save Changes</button>
            </div>
          )}

          {activeTab === 'password' && (
            <div className="card" style={{ maxWidth: 440 }}>
              <div className="form-group">
                <label>Current Password</label>
                <input type="password" className="form-control" value={currentPwd} onChange={e => setCurrentPwd(e.target.value)} />
              </div>
              <div className="form-group">
                <label>New Password</label>
                <input type="password" className="form-control" value={newPwd} onChange={e => setNewPwd(e.target.value)} />
              </div>
              <div className="form-group">
                <label>Confirm New Password</label>
                <input type="password" className="form-control" value={confirmPwd} onChange={e => setConfirmPwd(e.target.value)} />
              </div>
              <button className="btn btn-primary" onClick={changePwd}>Change Password</button>
            </div>
          )}

          {activeTab === 'notifications' && (
            <div className="card" style={{ maxWidth: 480 }}>
              <h3 style={{ marginBottom: '1.5rem' }}>Notification Preferences</h3>
              {[
                ['Email me on new policy', true],
                ['Email me on claim submission', true],
                ['Email me on payment received', false],
                ['WhatsApp alerts for fraud', true],
                ['SMS on overdue premiums', true],
              ].map(([label, def]) => (
                <div key={label as string} className="form-group" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <input type="checkbox" defaultChecked={def as boolean} id={label as string} />
                  <label htmlFor={label as string} style={{ marginBottom: 0, cursor: 'pointer' }}>{label as string}</label>
                </div>
              ))}
              <button className="btn btn-primary" style={{ marginTop: '1rem' }} onClick={() => showToast('success', 'Notification preferences saved.')}>
                Save Preferences
              </button>
            </div>
          )}

          {activeTab === 'audit' && (
            <div className="card">
              <h3 style={{ marginBottom: '1rem' }}>Audit Log</h3>
              <table className="table">
                <thead>
                  <tr><th>Action</th><th>Detail</th><th>Time</th></tr>
                </thead>
                <tbody>
                  {auditLog.map((entry, i) => (
                    <tr key={i}>
                      <td><span className="pill pill-active" style={{ fontSize: '0.7rem' }}>{entry.action}</span></td>
                      <td>{entry.detail}</td>
                      <td className="mono" style={{ fontSize: '0.8rem' }}>{entry.time}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
