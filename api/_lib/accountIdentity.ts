import type { SupabaseClient } from '@supabase/supabase-js'

/** Role chains represent separate relationships one real person may hold.
 * Only the policyholder ↔ agent pairing is enabled for shared identity
 * today; other cross-role combinations still follow their existing rules. */
const SYSTEM_IDENTITY_ROLES = ['super_admin', 'admin', 'tech_support']
const STAFF_IDENTITY_ROLES = ['claims_officer', 'policy_admin', 'finance', 'client_relations']

export type RoleChain = 'system' | 'staff' | 'agent' | 'policyholder' | 'other'

export function roleChain(role: string | null | undefined): RoleChain {
  if (role === 'agent') return 'agent'
  if (SYSTEM_IDENTITY_ROLES.includes(role ?? '')) return 'system'
  if (STAFF_IDENTITY_ROLES.includes(role ?? '')) return 'staff'
  if (role === 'policyholder') return 'policyholder'
  return 'other'
}

export function rolesInChain(role: string): string[] {
  const chain = roleChain(role)
  if (chain === 'system') return SYSTEM_IDENTITY_ROLES
  if (chain === 'staff') return STAFF_IDENTITY_ROLES
  return [role]
}

export function sameRoleChain(a: string | null | undefined, b: string | null | undefined): boolean {
  return roleChain(a) === roleChain(b)
}

export function signInSuffix(role: string): string {
  const chain = roleChain(role)
  if (chain === 'agent') return 'Agent'
  if (chain === 'policyholder') return 'Client'
  if (chain === 'system') return 'Admin'
  return 'Staff'
}

export function suffixedSignInName(name: string, role: string): string {
  return `${name} ${signInSuffix(role)}`
}

export function internalAuthEmail(name: string, role: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28) || 'account'
  const tail = Math.random().toString(36).slice(2, 8)
  return `${roleChain(role)}-${slug}-${tail}@account.motions.local`
}

export function isInternalAuthEmail(email: string | null | undefined): boolean {
  return /@(account|agent)\.motions\.local$/i.test(email ?? '')
}

interface UsernameHolder {
  id: string
  name: string | null
  role: string | null
  username: string | null
}

/** Choose a globally unique sign-in name without letting a customer row
 * block the same person from becoming staff/agent (or vice versa). The
 * display name stays untouched; only the login alias gets a role suffix. */
export async function chooseSignInName(
  admin: SupabaseClient,
  wanted: string,
  role: string,
  opts: { allowSameChainAlias?: boolean; allowedCrossChains?: RoleChain[]; excludeProfileId?: string } = {},
): Promise<{ username?: string; conflict?: UsernameHolder }> {
  const desired = wanted.trim()
  if (!desired) return {}
  const safePrefix = desired.replace(/[%_]/g, '') || desired
  const { data: rows, error } = await admin
    .from('profiles')
    .select('id, name, role, username')
    .ilike('username', `${safePrefix}%`)
    .limit(50)
  if (error) throw new Error(`Could not check sign-in name: ${error.message}`)

  const holders = ((rows ?? []) as UsernameHolder[]).filter(r => r.id !== opts.excludeProfileId)
  const exact = holders.find(r => (r.username ?? '').toLowerCase() === desired.toLowerCase())
  if (!exact) return { username: desired }
  const sameChain = sameRoleChain(exact.role, role)
  if ((sameChain && !opts.allowSameChainAlias) || (!sameChain && !(opts.allowedCrossChains ?? []).includes(roleChain(exact.role)))) {
    return { conflict: exact }
  }

  const base = suffixedSignInName(desired, role)
  for (let i = 1; i < 100; i++) {
    const candidate = i === 1 ? base : `${base} ${i}`
    if (!holders.some(r => (r.username ?? '').toLowerCase() === candidate.toLowerCase())) {
      return { username: candidate }
    }
  }
  return { conflict: exact }
}

/** profiles.email mirrors auth.users.email. A contact email may legitimately
 * repeat across role chains, so this checks whether the AUTH user behind a
 * matching profile really owns the supplied email. */
export async function authEmailOwner(
  admin: SupabaseClient,
  email: string,
): Promise<{ id: string; name: string | null; role: string | null } | null> {
  const { data: profiles } = await admin
    .from('profiles')
    .select('id, name, role')
    .eq('email', email)
    .limit(10)
  for (const profile of profiles ?? []) {
    const { data: { user } } = await admin.auth.admin.getUserById(profile.id as string)
    if ((user?.email ?? '').toLowerCase() === email.toLowerCase()) {
      return profile as { id: string; name: string | null; role: string | null }
    }
  }
  return null
}
