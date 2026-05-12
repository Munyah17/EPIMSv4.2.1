import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import type { AppUser, UserRole } from '../types'
import { supabase } from '../lib/supabase'

interface AuthContextValue {
  user: AppUser | null
  loading: boolean
  login: (email: string, password: string) => Promise<boolean>
  logout: () => Promise<void>
  hasPermission: (permission: string) => boolean
  canAccess: (panel: string) => boolean
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
  fraud: ['super_admin', 'admin', 'claims_officer'],
  profile: ['super_admin', 'admin', 'claims_officer', 'policy_admin', 'finance', 'client_relations', 'policyholder'],
  my_policies: ['policyholder'],
  my_claims: ['policyholder'],
  my_payments: ['policyholder'],
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
      if (session?.user) {
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
      if (event === 'SIGNED_IN' && session?.user) {
        const meta = session.user.user_metadata as Record<string, unknown>
        const profile = await fetchProfile(session.user.id, session.user.email ?? '', meta)
        setUser(profile)
      } else if (event === 'SIGNED_OUT') {
        setUser(null)
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  const login = useCallback(async (email: string, password: string): Promise<boolean> => {
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password })
      console.log('[login] error:', error, 'user:', data?.user?.id, 'meta:', data?.user?.user_metadata)
      if (!error && data.user) {
        const meta = data.user.user_metadata as Record<string, unknown>
        const profile = await fetchProfile(data.user.id, data.user.email ?? email, meta)
        console.log('[login] profile:', profile)
        if (profile && profile.active) {
          setUser(profile)
          return true
        }
        await supabase.auth.signOut().catch(() => {})
      }
    } catch (e) {
      console.log('[login] exception:', e)
    }
    return false
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

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, hasPermission, canAccess }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
