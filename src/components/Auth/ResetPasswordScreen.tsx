import { useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { supabase } from '../../lib/supabase'
import Copyright from '../Layout/Copyright'

/**
 * Landing screen for the emailed recovery link. AuthGate shows this whenever
 * the auth context reports recoveryMode (valid link, session established)
 * or recoveryError (expired/used link). A successful update signs the user
 * straight in via completeRecovery(); if the profile can't be loaded they
 * still get a clear confirmation and a path back to sign-in.
 */
export default function ResetPasswordScreen() {
  const { recoveryError, completeRecovery, exitRecovery } = useAuth()
  const [pwd, setPwd] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (pwd.length < 8) { setError('Password must be at least 8 characters.'); return }
    if (pwd !== confirm) { setError('Passwords do not match.'); return }
    setBusy(true)
    setError('')
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password: pwd })
      if (updateError) { setError(`Could not update the password: ${updateError.message}`); return }
      const profile = await completeRecovery()
      // completeRecovery signs the user in when a profile loads — done=true
      // is only the fallback when it couldn't (the password is still set).
      if (!profile) setDone(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-logo">
          <div className="logo-mark">T</div>
          <div>
            <div className="logo-name">TARIQIFYIMS</div>
            <div className="logo-sub">Motions Microinsurance</div>
          </div>
        </div>

        {recoveryError ? (
          <div className="login-form">
            <div className="login-error">{recoveryError}</div>
            <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5, margin: '0 0 1rem' }}>
              Reset links can only be used once and expire after a short while. Request a fresh one from the sign-in screen.
            </p>
            <button type="button" className="btn btn-primary btn-full" onClick={exitRecovery}>
              Back to Sign In
            </button>
          </div>
        ) : done ? (
          <div className="login-form">
            <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5, margin: '0 0 1rem' }}>
              Your password has been updated. Sign in with your new password.
            </p>
            <button type="button" className="btn btn-primary btn-full" onClick={exitRecovery}>
              Back to Sign In
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="login-form">
            <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5, margin: '0 0 0.25rem' }}>
              Choose a new password for your account.
            </p>
            <div className="form-group">
              <label htmlFor="new-pwd">New Password</label>
              <input
                id="new-pwd"
                type="password"
                placeholder="Min. 8 characters"
                value={pwd}
                onChange={e => setPwd(e.target.value)}
                required
                autoComplete="new-password"
              />
            </div>
            <div className="form-group">
              <label htmlFor="confirm-pwd">Confirm New Password</label>
              <input
                id="confirm-pwd"
                type="password"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                required
                autoComplete="new-password"
              />
            </div>

            {error && <div className="login-error">{error}</div>}

            <button type="submit" className="btn btn-primary btn-full" disabled={busy}>
              {busy ? 'Updating…' : 'Set New Password'}
            </button>
            <button type="button" className="btn btn-ghost btn-full" onClick={exitRecovery} disabled={busy}>
              Cancel
            </button>
          </form>
        )}

        <div className="login-footer">
          <Copyright />
        </div>
      </div>
    </div>
  )
}
