import { useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import Copyright from '../Layout/Copyright'
import ChatWidget from '../chat/ChatWidget'

export default function LoginScreen() {
  const { login } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    const ok = await login(email, password)
    setLoading(false)
    if (!ok) setError('Invalid credentials. Please try again.')
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-logo">
          <div className="logo-mark">T</div>
          <div>
            <div className="logo-name">TARIQIFY IMS</div>
            <div className="logo-sub">Enpassent Multiple Agents · IPEC Licensed</div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="login-form">
          <div className="form-group">
            <label htmlFor="email">Email Address</label>
            <input
              id="email"
              type="email"
              placeholder="Enter your email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>
          <div className="form-group">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              placeholder="Enter your password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </div>

          {error && <div className="login-error">{error}</div>}

          <button type="submit" className="btn btn-primary btn-full" disabled={loading}>
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>

        <div className="login-footer">
          <span>Secured by Supabase ·</span>
          <span> IPEC Reg. No. IPEC/IB/2020/001</span>
          <Copyright />
        </div>
      </div>
      <ChatWidget />
    </div>
  )
}
