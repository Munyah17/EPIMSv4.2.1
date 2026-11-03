import { useState } from 'react'
import { supabase } from '../../lib/supabase'

/**
 * The self-service "forgot password" entry — shown in place of the login
 * form on each login screen. Accepts the same identifier the login box does
 * (email or full name — resolved through resolve_login_email, the same RPC
 * login() uses, since there's no session here to read profiles with).
 *
 * The success state is identical whether or not the account exists, so the
 * form never confirms "yes, that email is registered" to a stranger.
 */
export default function ForgotPasswordForm({ onBack }: { onBack: () => void }) {
  const [identifier, setIdentifier] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const id = identifier.trim()
    if (!id) return
    setBusy(true)
    setError('')
    try {
      let email = id
      if (!id.includes('@')) {
        const { data: resolved, error: rpcError } = await supabase.rpc('resolve_login_email', { p_identifier: id })
        if (rpcError) { setError(`Could not look up that name: ${rpcError.message}`); return }
        email = (resolved as string | null) ?? ''
      }
      if (email) {
        const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/`,
        })
        if (resetError) { setError(resetError.message); return }
      }
      setSent(true)
    } finally {
      setBusy(false)
    }
  }

  if (sent) {
    return (
      <div className="login-form">
        <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5, margin: '0 0 1rem' }}>
          If an account exists for that email or name, a password reset link is on its way. Check the inbox — and the spam folder — then follow the link to choose a new password.
        </p>
        <button type="button" className="btn btn-primary btn-full" onClick={onBack}>
          Back to Sign In
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="login-form">
      <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5, margin: '0 0 0.25rem' }}>
        Enter your email or full name and we'll send a reset link to the email on the account.
      </p>
      <div className="form-group">
        <label htmlFor="forgot-id">Email or Full Name</label>
        <input
          id="forgot-id"
          type="text"
          placeholder="Enter your email or full name"
          value={identifier}
          onChange={e => setIdentifier(e.target.value)}
          required
          autoComplete="username"
        />
      </div>

      {error && <div className="login-error">{error}</div>}

      <button type="submit" className="btn btn-primary btn-full" disabled={busy}>
        {busy ? 'Sending…' : 'Send Reset Link'}
      </button>
      <button type="button" className="btn btn-ghost btn-full" onClick={onBack} disabled={busy}>
        Back to Sign In
      </button>
    </form>
  )
}
