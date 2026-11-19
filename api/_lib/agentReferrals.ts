import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Field-agent referral links.
 *
 * The code is a stable public identifier for the agent's recruitment link —
 * not a credential. It lives on agent_profiles so an agent can share it for
 * years, a suspended agent keeps historical attribution without acquiring new
 * signups, and a merge never rewrites the agent's real profile id.
 */
export const AGENT_REFERRAL_EMAILS = [
  'info@motions.co.zw',
  'a.antipas@motions.co.zw',
  'cady@motions.co.zw',
] as const

export const AGENT_REFERRAL_CODE_PATTERN = /^MOT-[2-9A-HJKMNP-Z]{8}$/
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const PUBLIC_SITE_URL = (process.env.PUBLIC_WEBSITE_URL || 'https://motions.co.zw').replace(/\/+$/, '')

export interface AgentReferral {
  profileId: string
  name: string
  email: string | null
  phone: string | null
  active: boolean
  territory: string | null
  referralCode: string
}

/** Accepts the printed code, a raw URL parameter, or a pasted full link. */
export function normalizeAgentReferralCode(raw: string | null | undefined): string | null {
  const input = String(raw ?? '').trim()
  const parameter = input.match(/[?&](?:agent|ref)=([^&#\s]+)/i)?.[1]
    ?? input.match(/^(?:agent|ref)=([^&#\s]+)/i)?.[1]
    ?? input
  let decoded = parameter
  try { decoded = decodeURIComponent(parameter) } catch { /* the raw value is checked below */ }
  const compact = decoded.toUpperCase().replace(/[^A-Z0-9]/g, '')
  const suffix = compact.startsWith('MOT') ? compact.slice(3) : compact
  if (!/^[2-9A-HJKMNP-Z]{8}$/.test(suffix)) return null
  return `MOT-${suffix}`
}

export function agentReferralLink(code: string): string {
  return `${PUBLIC_SITE_URL}/apply?agent=${encodeURIComponent(code)}`
}

/** Random-looking but unambiguous — no I/O, 0/O, 1/L — and not sequential. */
export function newAgentReferralCode(): string {
  const bytes = crypto.randomBytes(8)
  let suffix = ''
  for (const byte of bytes) suffix += CODE_ALPHABET[byte % CODE_ALPHABET.length]
  return `MOT-${suffix}`
}

function isCodeCollision(error: { code?: string; message?: string } | null | undefined): boolean {
  return error?.code === '23505' && /referral_code|agent_profiles_referral/i.test(error.message ?? '')
}

export async function resolveAgentByReferralCode(
  admin: SupabaseClient,
  rawCode: string | null | undefined,
): Promise<{ profileId: string; name: string; referralCode: string } | null> {
  const code = normalizeAgentReferralCode(rawCode)
  if (!code) return null
  const { data: agentFile, error } = await admin
    .from('agent_profiles')
    .select('profile_id, referral_code')
    .eq('referral_code', code)
    .maybeSingle()
  if (error || !agentFile?.profile_id) return null

  const { data: profile } = await admin
    .from('profiles')
    .select('id, name, role, active, merged_into')
    .eq('id', agentFile.profile_id)
    .maybeSingle()
  if (!profile || profile.role !== 'agent' || profile.active !== true || profile.merged_into) return null
  return { profileId: profile.id as string, name: profile.name as string, referralCode: code }
}

/** Creates the agent file/code for one profile without overwriting contract data. */
export async function ensureAgentReferralCode(admin: SupabaseClient, profileId: string): Promise<{ referralCode: string | null; error: string | null }> {
  const { data: existing, error: readError } = await admin
    .from('agent_profiles')
    .select('profile_id, referral_code')
    .eq('profile_id', profileId)
    .maybeSingle()
  if (readError) return { referralCode: null, error: readError.message }
  const current = normalizeAgentReferralCode(existing?.referral_code)
  if (current) return { referralCode: current, error: null }

  for (let attempt = 0; attempt < 8; attempt++) {
    const code = newAgentReferralCode()
    if (!existing) {
      const { error } = await admin.from('agent_profiles').insert({ profile_id: profileId, referral_code: code })
      if (!error) return { referralCode: code, error: null }
      if (isCodeCollision(error)) continue
      return { referralCode: null, error: error.message }
    }
    const { error } = await admin.from('agent_profiles').update({ referral_code: code, updated_at: new Date().toISOString() }).eq('profile_id', profileId)
    if (!error) return { referralCode: code, error: null }
    if (isCodeCollision(error)) continue
    return { referralCode: null, error: error.message }
  }
  return { referralCode: null, error: 'Could not allocate a unique referral code.' }
}

/** Every agent profile, including inactive/merged historical identities. */
export async function listAgentReferrals(admin: SupabaseClient): Promise<{ data: AgentReferral[] | null; error: string | null }> {
  const [{ data: profiles, error: profilesError }, { data: files, error: filesError }] = await Promise.all([
    admin.from('profiles').select('id, name, email, phone, active, merged_into').eq('role', 'agent').order('name'),
    admin.from('agent_profiles').select('profile_id, referral_code, territory'),
  ])
  if (profilesError || filesError) return { data: null, error: profilesError?.message ?? filesError?.message ?? 'Could not load agent referrals.' }

  const fileByProfile = new Map((files ?? []).map(row => [row.profile_id as string, row]))
  const agents = (profiles ?? []).map(profile => {
    const file = fileByProfile.get(profile.id as string)
    const referralCode = normalizeAgentReferralCode(file?.referral_code) ?? ''
    return {
      profileId: profile.id as string,
      name: profile.name as string,
      email: (profile.email as string | null) ?? null,
      phone: (profile.phone as string | null) ?? null,
      active: profile.active === true && !profile.merged_into,
      territory: (file?.territory as string | null) ?? null,
      referralCode,
    } satisfies AgentReferral
  })
  return { data: agents, error: null }
}

/** Idempotent backfill: create missing agent files, then issue missing codes. */
export async function ensureAllAgentReferrals(admin: SupabaseClient): Promise<{ data: AgentReferral[] | null; error: string | null }> {
  const { data: profiles, error } = await admin
    .from('profiles')
    .select('id')
    .eq('role', 'agent')
  if (error) return { data: null, error: error.message }

  const failures: string[] = []
  for (const profile of profiles ?? []) {
    const ensured = await ensureAgentReferralCode(admin, profile.id as string)
    if (ensured.error || !ensured.referralCode) failures.push(`${profile.id}: ${ensured.error ?? 'no code issued'}`)
  }
  if (failures.length) return { data: null, error: `Referral backfill incomplete: ${failures.slice(0, 5).join('; ')}` }
  return listAgentReferrals(admin)
}

export function agentReferralSms(agent: Pick<AgentReferral, 'name' | 'referralCode'>): string {
  return `${agent.name}, your Motions field-agent link is ${agentReferralLink(agent.referralCode)}. Share it when recruiting clients; cover bought through it is credited to you.`
}

export function referralDirectoryEmailText(agents: AgentReferral[]): string {
  return [
    'This is the persistent referral-link register for every field agent in Motions IMS.',
    '',
    ...agents.map(agent => [
      `Name: ${agent.name}`,
      `Status: ${agent.active ? 'Active' : 'Inactive / merged'}`,
      `Phone: ${agent.phone ?? '—'}`,
      `Email: ${agent.email ?? '—'}`,
      `Territory: ${agent.territory ?? '—'}`,
      `Referral code: ${agent.referralCode}`,
      `Referral link: ${agentReferralLink(agent.referralCode)}`,
      '',
    ].join('\n')),
    'A link is permanent. Do not rotate it unless an agent account itself is retired.',
  ].join('\n')
}

export function newAgentReferralEmailText(agent: AgentReferral): string {
  return [
    `A new field agent has been onboarded and assigned a persistent referral link.`,
    '',
    `Name: ${agent.name}`,
    `Phone: ${agent.phone ?? '—'}`,
    `Email: ${agent.email ?? '—'}`,
    `Territory: ${agent.territory ?? '—'}`,
    `Referral code: ${agent.referralCode}`,
    `Referral link: ${agentReferralLink(agent.referralCode)}`,
    '',
    'Policies completed through this link are attributed to the agent automatically.',
  ].join('\n')
}
