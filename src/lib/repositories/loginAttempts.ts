import { supabase } from '../supabase'
import { fetchAllRows } from '../paged'
import type { LockedLogin } from '../../types'

// ── LOGIN ATTEMPTS ────────────────────────────────────────────────
// Real brute-force signal for System Health — previously that page had
// no security data at all, only DB latency stats.

/** Server-side Super Admin lock management. The endpoint is the primary
 *  path because it works whether or not database/add_login_unlock.sql has
 *  been applied; the RPCs remain as compatibility fallbacks. */
async function callLoginLockAdmin<T>(action: string, payload: Record<string, unknown> = {}): Promise<{ data: T | null; error: string | null }> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return { data: null, error: 'Not signed in.' }
  try {
    const res = await fetch('/api/login-lock-admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ action, ...payload }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) return { data: null, error: body?.error ?? `Login lock service returned HTTP ${res.status}.` }
    return { data: body as T, error: null }
  } catch (e) {
    return { data: null, error: `Could not reach the login lock service: ${e}` }
  }
}

async function lockedFromAttempts(): Promise<{ data: LockedLogin[]; error: string | null }> {
  const { data: attempts, error } = await supabase
    .from('login_attempts')
    .select('email, success, ts')
    .order('ts', { ascending: false })
    .limit(20000)
  if (error) return { data: [], error: error.message }

  const latest = new Map<string, { success: boolean; ts: string }[]>()
  for (const row of (attempts ?? []) as { email: string; success: boolean; ts: string }[]) {
    const email = row.email.toLowerCase()
    const rows = latest.get(email) ?? []
    if (rows.length < 5) {
      rows.push(row)
      latest.set(email, rows)
    }
  }
  const locked = [...latest.entries()]
    .filter(([, rows]) => rows.length === 5 && rows.every(r => !r.success))
    .map(([email, rows]) => ({ email, failedAttempts: 5, lastAttempt: rows[0].ts }))
    .sort((a, b) => b.lastAttempt.localeCompare(a.lastAttempt))
  if (!locked.length) return { data: [], error: null }

  const { data: profiles } = await supabase
    .from('profiles')
    .select('id,email,name,role,active,created_at')
    .in('email', locked.map(l => l.email))
    .order('created_at', { ascending: false })
  const profileByEmail = new Map(
    ((profiles ?? []) as { id: string; email?: string; name?: string; role?: LockedLogin['role']; active?: boolean }[])
      .filter(p => p.email)
      .map(p => [p.email!.toLowerCase(), p] as const),
  )
  return {
    data: locked.map(l => {
      const p = profileByEmail.get(l.email)
      return { ...l, profileId: p?.id, name: p?.name, role: p?.role, active: p?.active }
    }),
    error: null,
  }
}

export const loginAttempts = {
  /** Failed attempts in the last N minutes, grouped by email, for staff-only viewing. */
  async recentFailures(minutes = 15) {
    const since = new Date(Date.now() - minutes * 60000).toISOString()
    const { data, error } = await fetchAllRows(
      () => supabase.from('login_attempts').select('email, ts').eq('success', false).gte('ts', since).order('ts', { ascending: false }),
      { orderBy: 'id' },
    )
    if (error || !data) return { data: [] as { email: string; count: number; lastAttempt: string }[], error: error?.message ?? null }
    const byEmail = new Map<string, { email: string; count: number; lastAttempt: string }>()
    for (const row of data as { email: string; ts: string }[]) {
      const existing = byEmail.get(row.email)
      if (existing) existing.count += 1
      else byEmail.set(row.email, { email: row.email, count: 1, lastAttempt: row.ts })
    }
    return { data: [...byEmail.values()].sort((a, b) => b.count - a.count), error: null }
  },

  /** Emails whose newest five attempts all failed — Super Admin only. */
  async locked(): Promise<{ data: LockedLogin[]; error: string | null }> {
    const api = await callLoginLockAdmin<{ locked: LockedLogin[] }>('list')
    if (!api.error && Array.isArray(api.data?.locked)) return { data: api.data.locked, error: null }

    const { data, error } = await supabase.rpc('list_locked_logins')
    if (!error) {
      return {
        data: ((data ?? []) as {
          email: string
          profile_id?: string
          name?: string
          role?: LockedLogin['role']
          active?: boolean
          failed_attempts: number
          last_attempt: string
        }[]).map(r => ({
          email: r.email,
          profileId: r.profile_id ?? undefined,
          name: r.name ?? undefined,
          role: r.role ?? undefined,
          active: r.active ?? undefined,
          failedAttempts: r.failed_attempts,
          lastAttempt: r.last_attempt,
        })),
        error: null,
      }
    }

    // The optional unlock SQL may not be installed. A Super Admin can still
    // read login_attempts directly, so derive the same newest-five rule
    // instead of turning an empty lock list into a blocking error.
    return lockedFromAttempts()
  },

  /** Clears the failed-attempt rows that hold an email under the 5-fail lock. */
  async unlock(email: string): Promise<{ data: number; error: string | null }> {
    const api = await callLoginLockAdmin<{ cleared: number }>('unlock', { email })
    if (!api.error && typeof api.data?.cleared === 'number') return { data: api.data.cleared, error: null }
    const apiError = api.error ?? 'The login lock service returned an unexpected response.'

    const { data, error } = await supabase.rpc('unlock_login', { p_email: email })
    if (error) return { data: 0, error: apiError ?? error.message }
    return { data: typeof data === 'number' ? data : 0, error: null }
  },

  /** Real sign-in history for one account — powers Profile > Audit Log,
   *  which used to show hardcoded sample rows regardless of who was
   *  actually logged in or what they'd actually done. */
  async historyFor(email: string, limit = 50): Promise<{ data: { success: boolean; ts: string }[]; error: string | null }> {
    const { data, error } = await supabase
      .from('login_attempts')
      .select('success, ts')
      .eq('email', email.toLowerCase())
      .order('ts', { ascending: false })
      .limit(limit)
    if (error) return { data: [], error: error.message }
    return { data: (data ?? []) as { success: boolean; ts: string }[], error: null }
  },
}
