import { useCallback, useEffect, useState } from 'react'
import { db } from '../../lib/db'
import { useAuth } from '../../contexts/AuthContext'
import type { LockedLogin, ToastMessage, UserRole } from '../../types'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
  refreshInterval?: number
}

function accountType(role: UserRole | undefined): string {
  if (!role) return 'Unknown login'
  return role === 'policyholder' ? 'Client'
    : role === 'super_admin' ? 'Super Admin'
    : 'Staff'
}

function loginPortal(role: UserRole | undefined): string {
  if (!role) return '—'
  return role === 'policyholder' ? '/login'
    : role === 'super_admin' ? '/super-admin'
    : '/admin'
}

/** The five-failed-attempt lock is released only through the
 *  list_locked_logins/unlock_login RPCs — never a broad DELETE permission
 *  on login_attempts. Those functions re-check super_admin at the DB. */
export default function LockedAccountsPanel({ showToast, refreshInterval }: Props) {
  const { user } = useAuth()
  const [lockedLogins, setLockedLogins] = useState<LockedLogin[]>([])
  const [error, setError] = useState<string | null>(null)
  const [unlocking, setUnlocking] = useState<string | null>(null)
  const isSuperAdmin = user?.role === 'super_admin'

  const load = useCallback(() => {
    if (!isSuperAdmin) return
    void db.loginAttempts.locked().then(({ data, error: loadError }) => {
      if (loadError) setError(loadError)
      else {
        setLockedLogins(data)
        setError(null)
      }
    })
  }, [isSuperAdmin])

  useEffect(() => {
    load()
    if (!refreshInterval) return
    const interval = window.setInterval(load, refreshInterval)
    return () => window.clearInterval(interval)
  }, [load, refreshInterval])

  const unlockLogin = async (email: string) => {
    if (!window.confirm(`Unlock ${email}? This clears its failed sign-in attempts so the user can try again.`)) return
    setUnlocking(email)
    const { data: cleared, error: unlockError } = await db.loginAttempts.unlock(email)
    if (unlockError) showToast('error', unlockError)
    else {
      setLockedLogins(prev => prev.filter(l => l.email !== email))
      showToast('success', `${email} unlocked — ${cleared} failed attempt${cleared === 1 ? '' : 's'} cleared.`)
      load()
    }
    setUnlocking(null)
  }

  if (!isSuperAdmin) return null

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="card-header">
        <span className="card-title">🔓 Account Unlock Management</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={load}>Refresh</button>
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
        Staff, Super Admin and client logins that reach five consecutive failed attempts can be re-enabled here.
      </div>
      {error ? (
        <div className="info-banner info-banner-danger" style={{ borderRadius: 8, padding: '10px 13px', fontSize: 12 }}>
          Could not load locked accounts: {error}. Run database/add_login_unlock.sql in Supabase first.
        </div>
      ) : lockedLogins.length === 0 ? (
        <div className="empty-state" style={{ padding: '20px 0' }}>No accounts are currently locked.</div>
      ) : (
        <div className="tbl-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Login Email</th>
                <th>Account</th>
                <th>Account Type</th>
                <th>Login Link</th>
                <th>Failures</th>
                <th>Last Attempt</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {lockedLogins.map(l => (
                <tr key={l.email}>
                  <td>{l.email}</td>
                  <td>
                    {l.name ? (
                      <>
                        <strong>{l.name}</strong>
                        {l.active === false && <div style={{ fontSize: 11, color: 'var(--muted)' }}>Profile inactive</div>}
                      </>
                    ) : 'No matching profile'}
                  </td>
                  <td>{accountType(l.role)}</td>
                  <td><code>{loginPortal(l.role)}</code></td>
                  <td>{l.failedAttempts}</td>
                  <td>{new Date(l.lastAttempt).toLocaleString('en-GB')}</td>
                  <td><span className="pill pill-lapsed">Locked</span></td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={unlocking === l.email}
                      onClick={() => void unlockLogin(l.email)}
                    >
                      {unlocking === l.email ? 'Unlocking…' : 'Unlock'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
