import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import type { AppUser, UserRole } from '../types'
import { supabase } from '../lib/supabase'

interface AuthContextValue {
  user: AppUser | null
  loading: boolean
  /** `identifier` may be an email address or a staff member's username —
   *  whichever the single login field was given. */
  login: (identifier: string, password: string) => Promise<boolean>
  logout: () => Promise<void>
  hasPermission: (permission: string) => boolean
  canAccess: (panel: string) => boolean
  /** Merges a patch into the locally-held user (e.g. after Profile.tsx saves name/phone). */
  updateLocalUser: (patch: Partial<AppUser>) => void
  /** Re-verifies the current password by attempting a fresh sign-in. Required before
   *  allowing a password or email change — proves the caller isn't just an open session
   *  on an unlocked device. Returns false without throwing on a wrong password. */
  reauthenticate: (password: string) => Promise<boolean>
}

const AuthContext = createContext<AuthContextValue | null>(null)

const PANEL_ACCESS: Record<string, UserRole[]> = {
  dashboard: ['super_admin', 'admin', 'claims_officer', 'policy_admin', 'finance', 'client_relations'],
  policies: ['super_admin', 'admin', 'policy_admin', 'finance', 'client_relations'],
  claims: ['super_admin', 'admin', 'claims_officer', 'finance'],
  payments: ['super_admin', 'admin', 'finance'],
  products: ['super_admin', 'admin', 'policy_admin'],
  clients: ['super_admin', 'admin', 'policy_admin', 'client_relations'],
  staff: ['super_admin', 'admin'],
  reminders: ['super_admin', 'admin', 'client_relations'],
  reports: ['super_admin', 'admin', 'finance'],
  leads: ['super_admin', 'admin', 'client_relations'],
  email: ['super_admin', 'admin', 'claims_officer', 'policy_admin', 'finance', 'client_relations'],
  tickets: ['super_admin', 'admin', 'client_relations'],
  live_chat: ['super_admin', 'admin', 'client_relations'],
  fraud: ['super_admin', 'admin', 'claims_officer'],
  profile: ['super_admin', 'admin', 'claims_officer', 'policy_admin', 'finance', 'client_relations', 'policyholder'],
  my_policies: ['policyholder'],
  my_claims: ['policyholder'],
  my_payments: ['policyholder'],
}

/** Guarantees a promise settles within `ms`, so a stalled Supabase auth call
 *  (e.g. a stuck client-side lock) can never leave the UI hung on "Authenticating…"
 *  forever — it fails fast and lets the user retry instead. */
function withTimeout<T>(promise: Promise<T>, ms: number, timeoutValue: T): Promise<T> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(timeoutValue), ms)
    promise.then(v => { clearTimeout(timer); resolve(v) }, () => { clearTimeout(timer); resolve(timeoutValue) })
  })
}

async function fetchProfile(userId: string, email: string, metaFallback?: Record<string, unknown>): Promise<AppUser | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single()

  if (!error && data) {
    return {
      id: data.id,
      name: data.name,
      username: data.username ?? undefined,
      email,
      role: data.role as UserRole,
      department: data.department ?? '',
      phone: data.phone ?? undefined,
      active: data.active ?? true,
      permissions: data.permissions ?? [],
      lastLogin: data.last_login ?? undefined,
      password: '',
    }
  }

  // RLS may block the read — fall back to auth metadata
  if (metaFallback) {
    const role = (metaFallback.role as UserRole) ?? 'policyholder'
    return {
      id: userId,
      name: (metaFallback.name as string) ?? email,
      email,
      role,
      department: (metaFallback.department as string) ?? '',
      phone: undefined,
      active: true,
      permissions: role === 'super_admin' ? ['all']
        : role === 'admin' ? ['all_except_super']
        : [],
      lastLogin: undefined,
      password: '',
    }
  }

  return null
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AppUser | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const timeout = setTimeout(() => setLoading(false), 4000)
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      clearTimeout(timeout)
      // Anonymous sessions (the live chat widget) fire the same auth events
      // as a real login — never treat one as an app sign-in.
      if (session?.user && !session.user.is_anonymous) {
        const meta = session.user.user_metadata as Record<string, unknown>
        const profile = await fetchProfile(session.user.id, session.user.email ?? '', meta)
        setUser(profile)
      }
      setLoading(false)
    }).catch(() => {
      clearTimeout(timeout)
      setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN' && session?.user && !session.user.is_anonymous) {
        const meta = session.user.user_metadata as Record<string, unknown>
        const profile = await fetchProfile(session.user.id, session.user.email ?? '', meta)
        setUser(profile)
      } else if (event === 'SIGNED_OUT') {
        setUser(null)
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  const login = useCallback(async (identifier: string, password: string): Promise<boolean> => {
    return withTimeout((async () => {
      let ok = false
      const trimmed = identifier.trim()
      // A bare email is used as-is; anything else (a username) is resolved
      // to its email server-side, since profiles isn't readable pre-auth.
      let email = trimmed
      try {
        if (!trimmed.includes('@')) {
          const { data: resolved } = await supabase.rpc('resolve_login_email', { p_identifier: trimmed })
          if (!resolved) {
            void supabase.from('login_attempts').insert({ email: trimmed.toLowerCase(), success: false }).then(() => {})
            return false
          }
          email = resolved as string
        }
        const { data, error } = await supabase.auth.signInWithPassword({ email, password })
        if (!error && data.user) {
          const meta = data.user.user_metadata as Record<string, unknown>
          const profile = await fetchProfile(data.user.id, data.user.email ?? email, meta)
          if (profile && profile.active) {
            setUser(profile)
            ok = true
          } else {
            await supabase.auth.signOut().catch(() => {})
          }
        }
      } catch {
        // fall through — ok stays false
      }
      // Direct insert (not via db.ts) so this always-loaded auth module
      // doesn't drag the whole data layer + Supabase SDK into the eager
      // bundle — everything else in the app reaches Supabase through
      // lazy-loaded pages, only auth is loaded up front.
      void supabase.from('login_attempts').insert({ email: email.toLowerCase(), success: ok }).then(() => {})
      return ok
    })(), 15000, false)
  }, [])

  const logout = useCallback(async () => {
    await supabase.auth.signOut().catch(() => {})
    setUser(null)
  }, [])

  const hasPermission = useCallback((permission: string): boolean => {
    if (!user) return false
    if (user.permissions.includes('all') || user.permissions.includes('all_except_super')) return true
    return user.permissions.includes(permission)
  }, [user])

  const canAccess = useCallback((panel: string): boolean => {
    if (!user) return false
    const allowed = PANEL_ACCESS[panel]
    if (!allowed) return true
    return allowed.includes(user.role)
  }, [user])

  const updateLocalUser = useCallback((patch: Partial<AppUser>) => {
    setUser(prev => prev ? { ...prev, ...patch } : prev)
  }, [])

  const reauthenticate = useCallback(async (password: string): Promise<boolean> => {
    if (!user?.email) return false
    return withTimeout(
      supabase.auth.signInWithPassword({ email: user.email, password }).then(({ error }) => !error),
      15000, false,
    )
  }, [user])

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, hasPermission, canAccess, updateLocalUser, reauthenticate }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
