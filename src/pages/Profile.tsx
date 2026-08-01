import { useState } from 'react'
import type { ToastMessage } from '../types'
import type { ActivePanel } from '../App'
import { useAuth } from '../contexts/AuthContext'
import { db } from '../lib/db'
import { supabase } from '../lib/supabase'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
  setActivePanel: (panel: ActivePanel) => void
}

export default function Profile({ showToast }: Props) {
  const { user, updateLocalUser, reauthenticate } = useAuth()
  const [activeTab, setActiveTab] = useState<'info' | 'password' | 'notifications' | 'audit'>('info')
  const [name, setName] = useState(user?.name ?? '')
  const [phone, setPhone] = useState(user?.phone ?? '')
  const [savingInfo, setSavingInfo] = useState(false)

  const [newEmail, setNewEmail] = useState('')
  const [emailPwd, setEmailPwd] = useState('')
  const [savingEmail, setSavingEmail] = useState(false)

  const [currentPwd, setCurrentPwd] = useState('')
  const [newPwd, setNewPwd] = useState('')
  const [confirmPwd, setConfirmPwd] = useState('')
  const [savingPwd, setSavingPwd] = useState(false)

  const saveInfo = async () => {
    if (!user) return
    if (!name.trim()) { showToast('warning', 'Full name cannot be empty.'); return }
    setSavingInfo(true)
    try {
      // Only ever sends name/phone — role, department, active, and permissions
      // are never part of this payload, and the database itself now rejects
      // any attempt to change them on your own row (see database/
      // fix_profiles_self_update_privilege_escalation.sql).
      const { data, error } = await db.staff.update(user.id, { name: name.trim(), phone: phone.trim() })
      if (error || !data) { showToast('error', 'Failed to update profile.'); return }
      updateLocalUser({ name: data.name, phone: data.phone })
      showToast('success', 'Profile updated successfully.')
    } finally {
      setSavingInfo(false)
    }
  }

  const changeEmail = async () => {
    if (!newEmail.trim() || !newEmail.includes('@')) { showToast('warning', 'Enter a valid email address.'); return }
    if (newEmail.trim().toLowerCase() === user?.email.toLowerCase()) { showToast('warning', 'That is already your current email.'); return }
    if (!emailPwd) { showToast('warning', 'Enter your current password to confirm this change.'); return }
    setSavingEmail(true)
    try {
      const authorized = await reauthenticate(emailPwd)
      if (!authorized) { showToast('error', 'Current password is incorrect.'); return }
      const { error } = await supabase.auth.updateUser({ email: newEmail.trim() })
      if (error) { showToast('error', `Failed to update email: ${error.message}`); return }
      showToast('success', 'Check your inbox to confirm this email change before it takes effect.')
      setNewEmail(''); setEmailPwd('')
    } finally {
      setSavingEmail(false)
    }
  }

  const changePwd = async () => {
    if (!currentPwd) { showToast('warning', 'Enter your current password.'); return }
    if (newPwd !== confirmPwd) { showToast('error', 'New passwords do not match.'); return }
    if (newPwd.length < 8) { showToast('warning', 'Password must be at least 8 characters.'); return }
    setSavingPwd(true)
    try {
      const authorized = await reauthenticate(currentPwd)
      if (!authorized) { showToast('error', 'Current password is incorrect.'); return }
      const { error } = await supabase.auth.updateUser({ password: newPwd })
      if (error) { showToast('error', `Failed to change password: ${error.message}`); return }
      showToast('success', 'Password changed successfully.')
      setCurrentPwd(''); setNewPwd(''); setConfirmPwd('')
    } finally {
      setSavingPwd(false)
    }
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
              <button className="btn btn-primary" onClick={saveInfo} disabled={savingInfo}>
                {savingInfo ? 'Saving…' : 'Save Changes'}
              </button>

              <hr style={{ margin: '1.5rem 0', border: 'none', borderTop: '1px solid var(--border)' }} />

              <h3 style={{ marginBottom: '0.75rem' }}>Change Email Address</h3>
              <div className="form-group">
                <label>Current Email</label>
                <input className="form-control" value={user?.email ?? ''} disabled style={{ opacity: 0.6 }} />
              </div>
              <div className="form-group">
                <label>New Email Address</label>
                <input type="email" className="form-control" value={newEmail} onChange={e => setNewEmail(e.target.value)} placeholder="new@example.com" />
              </div>
              <div className="form-group">
                <label>Confirm Current Password</label>
                <input type="password" className="form-control" value={emailPwd} onChange={e => setEmailPwd(e.target.value)} placeholder="Required to confirm this change" />
              </div>
              <button className="btn btn-primary" onClick={changeEmail} disabled={savingEmail}>
                {savingEmail ? 'Updating…' : 'Update Email'}
              </button>
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
              <button className="btn btn-primary" onClick={changePwd} disabled={savingPwd}>
                {savingPwd ? 'Changing…' : 'Change Password'}
              </button>
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
