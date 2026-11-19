import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'
import { isZwPhone } from './_lib/zwFormats.js'
import {
  AGENT_REFERRAL_EMAILS,
  agentReferralLink,
  agentReferralSms,
  ensureAgentReferralCode,
  newAgentReferralEmailText,
} from './_lib/agentReferrals.js'
import { logDelivery, sendEmailDirect, sendSmsAfrosoft } from './_lib/notify.js'
import { auditLog } from './_lib/audit.js'
import {
  authEmailOwner,
  chooseSignInName,
  internalAuthEmail,
  isInternalAuthEmail,
  rolesInChain,
  sameRoleChain,
} from './_lib/accountIdentity.js'

/**
 * Creates a real Supabase Auth user + profiles row — merges what used to be
 * two separate functions (create-staff.ts for work roles, create-system-user.ts
 * for Super Admin/Admin/Tech Support) into one file so the Vercel Hobby
 * plan's 12-serverless-functions-per-deployment cap isn't exceeded. Which
 * path runs is decided by which role list `body.role` falls into — the two
 * lists are disjoint, so there's no ambiguity.
 *
 * Work roles (claims_officer, policy_admin, finance, client_relations,
 * agent): caller must be admin or super_admin, matching the old
 * create-staff.ts bar.
 *
 * System roles (super_admin, admin, tech_support): caller must be
 * super_admin, matching the old create-system-user.ts bar — only a Super
 * Admin may provision another system-tier account. The DB also enforces
 * this independently via trg_block_non_super_admin_system_role_changes.
 */

const STAFF_ROLES = ['claims_officer', 'policy_admin', 'finance', 'client_relations', 'agent'] as const
const SYSTEM_ROLES = ['super_admin', 'admin', 'tech_support'] as const

interface CreateAccountBody {
  /** When present this is an UPDATE, not a create: only the sign-in email
   *  is changed (`{ id, email }`). Everything else is ignored. */
  id?: string
  name: string
  username?: string
  email: string
  password: string
  phone?: string
  role: string
  department: string
  customRoleId?: string
  permissions?: string[]
  agentProfile?: {
    nationalId?: string
  }
}

/** Sign-in identity is the person's unique display name or their email.
 *  Cross-role identities may share the same personal name, so the login
 *  username gains a role suffix instead of treating the account as a
 *  duplicate. */

const normalizeName = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const normalizePhone = (value?: string) => (value ?? '').replace(/\D/g, '')
const normalizeNationalId = (value?: string) => (value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'Server is not configured (missing Supabase service credentials).' })
  }

  const authHeader = req.headers.authorization
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined
  if (!token) {
    return res.status(401).json({ error: 'Missing Authorization header.' })
  }

  const body: CreateAccountBody = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {})
  const updateId = typeof body.id === 'string' && body.id.length > 0 ? body.id : null
  const isUpdate = updateId !== null

  if (!isUpdate && (!body.name || !body.password || !body.role || !body.department)) {
    return res.status(400).json({ error: 'name, password, role, and department are required.' })
  }
  // Agents are field intermediaries — most never touch this portal.
  // Email is optional for them; the auth account needs SOME email, so a
  // placeholder backs it and the profile shows none. Sign-in resolves
  // by full name regardless.
  if (!isUpdate && !body.email?.trim() && body.role !== 'agent') {
    return res.status(400).json({ error: 'Email is required for staff accounts.' })
  }
  if (!isUpdate && body.password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' })
  }
  // Optional, but once given it must be a usable Zimbabwean number —
  // same format rule the modals enforce.
  if (!isUpdate && body.phone?.trim() && !isZwPhone(body.phone)) {
    return res.status(400).json({ error: 'phone is not a valid Zimbabwean number — +263 followed by 9 digits, or 10 digits starting with 0.' })
  }

  const isSystemRole = (SYSTEM_ROLES as readonly string[]).includes(body.role)
  const isStaffRole = (STAFF_ROLES as readonly string[]).includes(body.role)
  if (!isUpdate && !isSystemRole && !isStaffRole) {
    return res.status(400).json({ error: 'Invalid role.' })
  }

  const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

  const { data: { user: caller }, error: callerError } = await admin.auth.getUser(token)
  if (callerError || !caller) {
    return res.status(401).json({ error: 'Invalid or expired session.' })
  }

  const { data: callerProfile, error: profileError } = await admin
    .from('profiles')
    .select('role, name, active')
    .eq('id', caller.id)
    .single()
  if (profileError || !callerProfile || !callerProfile.active) {
    return res.status(403).json({ error: 'You do not have permission to manage accounts.' })
  }

  // ── Update path: change an existing account's sign-in email ──
  // Email edits in the staff modals used to write only the profiles row
  // (or nothing) while auth.users kept the old address — the account then
  // authenticated under a different email than the one shown, which read
  // exactly like "password resets don't work". The auth email is the
  // identity, so it moves here; profiles.email follows via the
  // sync_profile_email trigger (and an explicit write below in case the
  // trigger migration never ran).
  if (isUpdate) {
    const newEmail = (body.email ?? '').trim().toLowerCase()
    if (!newEmail || !/^\S+@\S+\.\S+$/.test(newEmail)) {
      return res.status(400).json({ error: 'A valid email address is required.' })
    }
    const { data: target } = await admin
      .from('profiles')
      .select('role, email')
      .eq('id', updateId)
      .maybeSingle()
    if (!target) return res.status(404).json({ error: 'Account not found.' })
    // Same tier bar as reset-staff-password/delete-staff: super_admins are
    // managed out of band, system roles only by a super_admin, and a
    // policyholder's sign-in email is owned by the client record — change
    // it through the client-portal-account flow so the RLS binding moves
    // with it.
    if (target.role === 'super_admin') {
      return res.status(403).json({ error: 'Super Admin accounts cannot be edited here.' })
    }
    if (target.role === 'policyholder') {
      return res.status(400).json({ error: "Client portal logins are managed from the client's record, not here." })
    }
    if ((SYSTEM_ROLES as readonly string[]).includes(target.role) && callerProfile.role !== 'super_admin') {
      return res.status(403).json({ error: 'Only a Super Admin can edit system access accounts.' })
    }
    if ((STAFF_ROLES as readonly string[]).includes(target.role) && !['admin', 'super_admin'].includes(callerProfile.role)) {
      return res.status(403).json({ error: 'You do not have permission to edit staff accounts.' })
    }

    // Alias-auth accounts sign in through an internal address and a
    // role-suffixed name. Their visible email is contact data only, so an
    // edit must not move auth.users.email or the sign-in stops resolving.
    if (isInternalAuthEmail(target.email)) {
      const { error: contactError } = await admin
        .from('profiles')
        .update({ contact_email: newEmail })
        .eq('id', updateId)
      if (contactError) return res.status(503).json({ error: `Could not update the contact email — run migration 20261119_003_cross_role_account_identities.sql first. ${contactError.message}` })
      return res.status(200).json({ success: true, email: newEmail, contactOnly: true })
    }

    const { error: emailError } = await admin.auth.admin.updateUserById(updateId, {
      email: newEmail,
      email_confirm: true,
    })
    if (emailError) {
      return res.status(400).json({ error: emailError.message })
    }
    await admin.from('profiles').update({ email: newEmail }).eq('id', updateId)
    return res.status(200).json({ success: true, email: newEmail })
  }

  if (isSystemRole && callerProfile.role !== 'super_admin') {
    return res.status(403).json({ error: 'Only a Super Admin can create system access accounts.' })
  }
  if (isStaffRole && !['admin', 'super_admin'].includes(callerProfile.role)) {
    return res.status(403).json({ error: 'You do not have permission to create staff accounts.' })
  }

  // contact_email is introduced by migration 003. Ordinary onboarding keeps
  // working before it runs; only an account that needs a contact/auth split
  // is delayed with an explicit migration error.
  const { error: contactColumnError } = await admin.from('profiles').select('contact_email').limit(0)
  const contactEmailSupported = !contactColumnError

  let approvedDuplicateRequestId: string | null = null
  if (body.role === 'agent') {
    const wantedName = normalizeName(body.name)
    const wantedPhone = normalizePhone(body.phone)
    const wantedEmail = body.email?.trim().toLowerCase() ?? ''
    const wantedNationalId = normalizeNationalId(body.agentProfile?.nationalId)
    const dedupeKey = [wantedName, wantedPhone, wantedNationalId].join('|')

    const [{ data: agentRows, error: agentsError }, { data: agentFiles, error: filesError }] = await Promise.all([
      admin.from('profiles').select('*').eq('role', 'agent'),
      admin.from('agent_profiles').select('profile_id, national_id'),
    ])
    if (agentsError || filesError) {
      return res.status(500).json({ error: 'Could not check for an existing agent with the same identity.' })
    }

    const nationalIdByProfile = new Map(
      (agentFiles ?? [])
        .filter(row => normalizeNationalId(row.national_id as string | undefined))
        .map(row => [row.profile_id as string, normalizeNationalId(row.national_id as string | undefined)]),
    )
    const conflicts = (agentRows ?? []).filter(row => {
      const sameName = normalizeName(row.name ?? '') === wantedName
      const sameEmail = !!wantedEmail && (((row.contact_email as string | null) ?? row.email) as string | null)?.toLowerCase() === wantedEmail
      const samePhone = !!wantedPhone && normalizePhone(row.phone as string | undefined) === wantedPhone
      const sameNationalId = !!wantedNationalId && nationalIdByProfile.get(row.id as string) === wantedNationalId
      return sameName || samePhone || sameNationalId || sameEmail
    })

    if (conflicts.length > 0) {
      const { data: existingRequests, error: requestError } = await admin
        .from('agent_governance_requests')
        .select('id, status')
        .eq('request_type', 'duplicate_account')
        .eq('payload->>dedupe_key', dedupeKey)
        .in('status', ['pending', 'approved'])
        .order('created_at', { ascending: false })
        .limit(1)

      if (requestError) {
        return res.status(500).json({ error: 'A possible duplicate agent was found, but the approval queue is unavailable — run database/add_agent_governance.sql first.' })
      }

      const existing = existingRequests?.[0]
      if (existing?.status === 'approved') {
        approvedDuplicateRequestId = existing.id as string
      } else {
        if (!existing) {
          const { data: requested, error: createRequestError } = await admin
            .from('agent_governance_requests')
            .insert({
              request_type: 'duplicate_account',
              status: 'pending',
              reason: `Possible duplicate agent account: ${body.name}`,
              requested_by: caller.id,
              requested_by_name: (callerProfile as { name?: string }).name ?? null,
              payload: {
                dedupe_key: dedupeKey,
                name: body.name.trim(),
                email: body.email?.trim() || null,
                phone: body.phone?.trim() || null,
                national_id: body.agentProfile?.nationalId?.trim() || null,
                conflicts: conflicts.map(c => ({
                  id: c.id,
                  name: c.name,
                  email: (c as { contact_email?: string | null }).contact_email ?? c.email,
                  phone: c.phone,
                  active: c.active,
                })),
              },
            })
            .select('id')
            .single()
          if (createRequestError) {
            const { data: raced } = await admin.from('agent_governance_requests')
              .select('id')
              .eq('request_type', 'duplicate_account')
              .eq('payload->>dedupe_key', dedupeKey)
              .eq('status', 'pending')
              .limit(1)
            if (raced?.[0]) {
              return res.status(409).json({ error: `Possible duplicate agent account found. Approval request ${raced[0].id} is still pending.`, approvalRequestId: raced[0].id })
            }
            return res.status(500).json({ error: 'A possible duplicate agent was found, but the approval request could not be created.' })
          }
          return res.status(409).json({
            error: `Possible duplicate agent account found (${conflicts.map(c => c.name).join(', ')}). Approval request ${requested.id} is pending.`,
            approvalRequestId: requested.id,
          })
        }
        return res.status(409).json({
          error: `Possible duplicate agent account found (${conflicts.map(c => c.name).join(', ')}). Approval request ${existing.id} is still pending.`,
          approvalRequestId: existing.id,
        })
      }
    }
  }

  // Cross-role identity is legitimate: a customer can also be an agent or
  // staff member. Only duplicates inside the same chain are suspicious.
  if (body.role !== 'agent') {
    const wantedName = normalizeName(body.name)
    const wantedPhone = normalizePhone(body.phone)
    const wantedEmail = body.email?.trim().toLowerCase() ?? ''
    const { data: chainRows, error: chainError } = await admin
      .from('profiles')
      .select('*')
      .in('role', rolesInChain(body.role))
    if (chainError) {
      return res.status(500).json({ error: 'Could not check for an existing account with the same identity.' })
    }
    const conflicts = (chainRows ?? []).filter(row => {
      const sameEmail = !!wantedEmail && (((row.contact_email as string | null) ?? row.email) as string | null)?.toLowerCase() === wantedEmail
      return normalizeName(row.name ?? '') === wantedName || sameEmail || (!!wantedPhone && normalizePhone(row.phone as string | undefined) === wantedPhone)
    })
    if (conflicts.length) {
      return res.status(409).json({
        error: `Possible duplicate ${body.role.replace(/_/g, ' ')} account found (${conflicts.map(c => c.name).join(', ')}). A customer account is allowed alongside this role, but not a second account in the same role chain.`,
      })
    }
  }

  // Supabase Auth requires globally unique emails. If this person's email
  // already authenticates a customer account, the new staff/agent account
  // receives an internal auth address while their real address is kept in
  // profiles.contact_email. Sign-in is then by the unique role-suffixed name.
  const requestedEmail = body.email?.trim().toLowerCase() ?? ''
  let authEmail = requestedEmail || internalAuthEmail(body.name, body.role)
  if (requestedEmail) {
    const owner = await authEmailOwner(admin, requestedEmail)
    if (owner && sameRoleChain(owner.role, body.role)) {
      return res.status(409).json({ error: `That email already belongs to ${owner.name} in the same role chain.` })
    }
    // A matching client record must keep the email free for the eventual
    // policyholder login — its RLS ownership check requires auth email ==
    // clients.email. Staff/agent contact email goes in contact_email instead.
    const { data: linkedClient } = await admin
      .from('clients')
      .select('id')
      .eq('email', requestedEmail)
      .limit(1)
    if (owner || (linkedClient ?? []).length > 0) authEmail = internalAuthEmail(body.name, body.role)
  }
  if (requestedEmail && authEmail !== requestedEmail && !contactEmailSupported) {
    return res.status(503).json({ error: 'Cross-role email sharing needs migration 20261119_003_cross_role_account_identities.sql first.' })
  }

  // An approved same-chain agent duplicate still needs a distinct sign-in
  // name; an unapproved duplicate never reaches this point. Different chains
  // may share a display name, so the alias carries the role.
  const wantedUsername = body.username?.trim() || body.name.trim()
  let signIn: { username?: string; conflict?: { name?: string | null; role?: string | null } }
  try {
    signIn = await chooseSignInName(admin, wantedUsername, body.role, {
      allowSameChainAlias: body.role === 'agent' && !!approvedDuplicateRequestId,
    })
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : 'Could not choose a unique sign-in name.' })
  }
  if (signIn.conflict) {
    return res.status(409).json({
      error: `A ${String(signIn.conflict.role ?? '').replace(/_/g, ' ')} account already uses the sign-in name "${wantedUsername}". Duplicate accounts are only allowed across different role chains.`,
    })
  }
  const username = signIn.username ?? wantedUsername

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: authEmail,
    password: body.password,
    email_confirm: true,
    user_metadata: { name: body.name, role: body.role, department: body.department },
  })
  if (createError || !created.user) {
    // "Already registered" answers nothing on its own — auth users include
    // policyholder portal accounts, so the holder may be a client, not a
    // colleague. Name whoever owns the email when we can.
    const { data: holder } = await admin.from('profiles')
      .select('name, role').eq('email', authEmail).limit(1).maybeSingle()
    const who = holder ? ` It belongs to ${holder.name} (${String(holder.role ?? '').replace(/_/g, ' ')}).` : ''
    return res.status(400).json({ error: `${createError?.message ?? 'Failed to create user.'}${who}` })
  }

  if (body.phone) {
    await admin.from('profiles').update({ phone: body.phone }).eq('id', created.user.id)
  }

  const extra: Record<string, unknown> = { username }
  // profiles.email stays equal to auth.users.email so resolve_login_email
  // still returns the address Auth can authenticate. The person's reusable
  // contact email lives beside it when it already belongs to another role.
  if (requestedEmail && authEmail !== requestedEmail) extra.contact_email = requestedEmail
  if (isSystemRole) {
    // super_admin/admin get blanket-access sentinels (matching every other
    // system-tier account); tech_support starts with none, granted explicitly.
    extra.permissions = body.role === 'super_admin' ? ['all'] : body.role === 'admin' ? ['all_except_super'] : []
  } else {
    if (body.customRoleId) extra.custom_role_id = body.customRoleId
    if (body.permissions) extra.permissions = body.permissions
  }
  const { error: usernameError } = await admin.from('profiles').update(extra).eq('id', created.user.id)
  if (usernameError) {
    // Roll the account back: the auth user (and its cascade-deleting
    // profile row) must not outlive a failed create. It used to stay
    // behind — so every retry failed EARLIER, on the email, with a
    // different "already exists", and the half-made account was never
    // visible as the culprit. Deleting the auth user cascades to profiles.
    await admin.auth.admin.deleteUser(created.user.id).catch(() => { /**/ })
    if (usernameError.code === '23505') {
      // The unique index spans EVERY profile's username — staff AND
      // policyholder portal logins (client-portal-account.ts sets
      // username = the client's name), so the holder may be a client
      // who shares this person's name, not a captured colleague.
      const pattern = username.replace(/[%_*]/g, '') || username
      const { data: holder } = await admin.from('profiles')
        .select('name, role').neq('id', created.user.id)
        .ilike('username', pattern).limit(1).maybeSingle()
      const who = holder ? ` It belongs to ${holder.name} (${String(holder.role ?? '').replace(/_/g, ' ')}).` : ''
      return res.status(409).json({ error: `The sign-in name "${username}" is already taken.${who} Give this account a different sign-in name — e.g. add an initial.` })
    }
    return res.status(400).json({ error: usernameError.message })
  }

  const { data: profile } = await admin.from('profiles').select('*, custom_roles!profiles_custom_role_id_fkey(name)').eq('id', created.user.id).single()

  if (approvedDuplicateRequestId) {
    await admin.from('agent_governance_requests')
      .update({ status: 'used', used_at: new Date().toISOString() })
      .eq('id', approvedDuplicateRequestId)
  }

  let referralCode: string | undefined
  let referralLink: string | undefined
  const notificationWarnings: string[] = []
  if (body.role === 'agent') {
    const ensured = await ensureAgentReferralCode(admin, created.user.id)
    if (ensured.error || !ensured.referralCode) {
      notificationWarnings.push(`Referral link was not issued: ${ensured.error ?? 'unknown error'}`)
    } else {
      referralCode = ensured.referralCode
      referralLink = agentReferralLink(referralCode)
      const referralAgent = {
        profileId: created.user.id,
        name: body.name.trim(),
        email: body.email?.trim() || null,
        phone: body.phone?.trim() || null,
        active: true,
        territory: null,
        referralCode,
      }
      const directoryEmail = await sendEmailDirect(
        AGENT_REFERRAL_EMAILS.join(', '),
        `New field-agent referral link — ${body.name.trim()}`,
        newAgentReferralEmailText(referralAgent),
      )
      await logDelivery(admin, 'system', referralCode, directoryEmail)
      if (directoryEmail.status === 'failed') notificationWarnings.push(`Company email failed: ${directoryEmail.detail ?? 'failed'}`)

      if (body.phone?.trim()) {
        const sms = await sendSmsAfrosoft(body.phone, agentReferralSms(referralAgent))
        await logDelivery(admin, 'system', referralCode, sms)
        if (sms.status === 'failed') notificationWarnings.push(`Agent SMS failed: ${sms.detail ?? 'failed'}`)
      }

      await auditLog({
        operatorId: caller.id,
        entityType: 'agent',
        entityId: created.user.id,
        action: 'agent_referral_link_issued',
        changes: { referralCode: { old: null, new: referralCode } },
        source: 'web',
      })
    }
  }

  return res.status(200).json({
    success: true,
    profile: {
      ...profile,
      email: requestedEmail || (isInternalAuthEmail(profile?.email as string | undefined) ? null : profile?.email),
    },
    signInName: username,
    internalSignInEmail: authEmail !== requestedEmail,
    referralCode,
    referralLink,
    warnings: notificationWarnings,
  })
}
