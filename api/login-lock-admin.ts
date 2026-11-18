import type { VercelRequest, VercelResponse } from '@vercel/node'
import type { SupabaseClient } from '@supabase/supabase-js'
import { serviceClient, requireSession } from './_lib/sessionAuth.js'

/**
 * Super Admin login-lock management.
 *
 * The database RPCs in database/add_login_unlock.sql are the preferred path,
 * but a deployed portal should not lose unlock functionality while that
 * migration is pending. This endpoint performs the same checked operation
 * with the service role:
 *
 *   POST { action: 'list' }
 *   POST { action: 'unlock', email }
 *
 * Locking itself still happens pre-auth through is_login_locked(); this is
 * only the administrative list/release side.
 */

const LOCK_ATTEMPTS = 5
const MAX_ATTEMPT_ROWS = 20_000

interface AttemptRow { email: string; success: boolean; ts: string }
interface ProfileRow {
  id: string; email?: string | null; name?: string | null
  role?: string | null; active?: boolean | null; created_at?: string | null
}

const missingTable = (message: string | undefined) =>
  !!message && (/does not exist|Could not find the table/i.test(message))

async function callerProfile(admin: SupabaseClient, userId: string) {
  const { data, error } = await admin.from('profiles')
    .select('id,name,role,active').eq('id', userId).maybeSingle()
  if (error || !data || data.active !== true || data.role !== 'super_admin') return null
  return data
}

async function lockedLogins(admin: SupabaseClient) {
  const { data: attempts, error } = await admin
    .from('login_attempts')
    .select('email, success, ts')
    .order('ts', { ascending: false })
    .limit(MAX_ATTEMPT_ROWS)
  if (error) {
    if (missingTable(error.message)) return []
    throw new Error(error.message)
  }

  const latestByEmail = new Map<string, AttemptRow[]>()
  for (const row of (attempts ?? []) as AttemptRow[]) {
    const email = row.email.toLowerCase()
    const latest = latestByEmail.get(email) ?? []
    if (latest.length < LOCK_ATTEMPTS) {
      latest.push({ ...row, email })
      latestByEmail.set(email, latest)
    }
  }

  const locked = [...latestByEmail.values()]
    .filter(rows => rows.length === LOCK_ATTEMPTS && rows.every(r => r.success === false))
    .map(rows => ({ email: rows[0].email, failedAttempts: LOCK_ATTEMPTS, lastAttempt: rows[0].ts }))
    .sort((a, b) => b.lastAttempt.localeCompare(a.lastAttempt))

  if (!locked.length) return []
  const { data: profiles } = await admin
    .from('profiles')
    .select('id,email,name,role,active,created_at')
    .in('email', locked.map(l => l.email))
    .order('created_at', { ascending: false })

  const profileByEmail = new Map<string, ProfileRow>()
  for (const p of (profiles ?? []) as ProfileRow[]) {
    const email = p.email?.toLowerCase()
    if (email && !profileByEmail.has(email)) profileByEmail.set(email, p)
  }

  return locked.map(l => {
    const p = profileByEmail.get(l.email)
    return {
      email: l.email,
      profileId: p?.id,
      name: p?.name ?? undefined,
      role: p?.role ?? undefined,
      active: p?.active ?? undefined,
      failedAttempts: l.failedAttempts,
      lastAttempt: l.lastAttempt,
    }
  })
}

async function unlockLogin(admin: SupabaseClient, email: string) {
  const { data: latest, error } = await admin
    .from('login_attempts')
    .select('success, ts')
    .eq('email', email)
    .order('ts', { ascending: false })
    .limit(LOCK_ATTEMPTS)
  if (error) throw new Error(error.message)
  const rows = (latest ?? []) as { success: boolean }[]
  if (rows.length < LOCK_ATTEMPTS || rows.some(r => r.success)) {
    return { locked: false as const }
  }

  const { count, error: deleteError } = await admin
    .from('login_attempts')
    .delete({ count: 'exact' })
    .eq('email', email)
    .eq('success', false)
  if (deleteError) throw new Error(deleteError.message)
  return { locked: true as const, cleared: count ?? 0 }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const admin = serviceClient()
  if (!admin) return res.status(500).json({ error: 'Server is not configured.' })
  const session = await requireSession(req, admin)
  if (!session) return res.status(401).json({ error: 'A valid sign-in is required.' })
  const caller = await callerProfile(admin, session.user.id)
  if (!caller) return res.status(403).json({ error: 'Only an active Super Admin can manage locked logins.' })

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {})

  try {
    if (body.action === 'list') {
      return res.status(200).json({ locked: await lockedLogins(admin) })
    }

    if (body.action === 'unlock') {
      const email = String(body.email ?? '').trim().toLowerCase()
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'A valid account email is required.' })
      }
      const result = await unlockLogin(admin, email)
      if (!result.locked) return res.status(400).json({ error: 'This account is not currently locked.' })

      const { error: auditError } = await admin.from('activity_log').insert({
        actor_id: session.user.id,
        actor_name: caller.name,
        actor_role: 'super_admin',
        action: 'login_unlock',
        entity_type: 'account',
        entity_id: email,
        entity_label: email,
        detail: `Cleared ${result.cleared} failed sign-in attempt${result.cleared === 1 ? '' : 's'} and released the login lock.`,
        severity: 'notice',
      })
      return res.status(200).json({ cleared: result.cleared, auditWarning: auditError?.message })
    }

    return res.status(400).json({ error: 'Unknown action.' })
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
}
