import type { VercelRequest, VercelResponse } from '@vercel/node'
import { serviceClient, requireSession } from './_lib/sessionAuth.js'

/**
 * POST /api/client-portal-account { clientId, password }
 *
 * Provisions a client's portal login — or resets its password when one
 * already exists. Nothing else in the system ever created a policyholder
 * auth user (the "created automatically on first purchase" flow was never
 * implemented), which is why clients could see a portal but never sign in.
 *
 * Binding rule this must respect: RLS lets a policyholder read their own
 * rows only when clients.email = auth.users.email. So the auth account's
 * email IS the client record's email — a client with no email on file
 * cannot have a portal login until staff saves one. The client row's
 * email is normalised to lowercase here because that RLS comparison is
 * case-sensitive while auth lowercases every email it stores.
 *
 * Login identifier: the client signs in with that email OR their full
 * name — resolve_login_email maps profile name → email.
 *
 * Safety: if the email already backs a non-policyholder account we
 * refuse — resetting it would hand a client-record edit control of a
 * staff login.
 */

const CLIENT_MANAGER_ROLES = ['super_admin', 'admin', 'policy_admin', 'client_relations', 'agent']

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const admin = serviceClient()
  if (!admin) return res.status(503).json({ error: 'Server is not configured.' })
  if (!(await requireSession(req, admin))) return res.status(401).json({ error: 'Sign-in required.' })

  const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
  const { data: { user } } = await admin.auth.getUser(token)
  const { data: caller } = await admin.from('profiles').select('role, active').eq('id', user!.id).maybeSingle()
  if (!caller?.active || !CLIENT_MANAGER_ROLES.includes(caller.role ?? '')) {
    return res.status(403).json({ error: 'Only staff who manage clients can set portal passwords.' })
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {})
  const clientId = typeof body.clientId === 'string' ? body.clientId : ''
  const password = typeof body.password === 'string' ? body.password : ''
  if (!clientId || !password) return res.status(400).json({ error: 'Pass { clientId, password }.' })
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' })

  const { data: client } = await admin
    .from('clients')
    .select('id, name, email')
    .eq('id', clientId)
    .maybeSingle()
  if (!client) return res.status(404).json({ error: 'Client not found.' })

  const email = String(client.email ?? '').trim().toLowerCase()
  if (!email) {
    return res.status(400).json({
      error: 'This client has no email on file — save one first. The portal signs in with that email or their full name.',
      code: 'NO_EMAIL',
    })
  }

  // auth.users.email is always lowercase; clients.email may not be — the
  // RLS ownership check is a plain text equality, so align the two or the
  // login would open an empty portal.
  if (String(client.email).trim() !== email) {
    await admin.from('clients').update({ email }).eq('id', client.id)
  }

  const { data: existing } = await admin
    .from('profiles')
    .select('id, role')
    .eq('email', email)
    .maybeSingle()

  if (existing && existing.role !== 'policyholder') {
    return res.status(409).json({
      error: 'That email already belongs to a staff account — give the client a different email.',
      code: 'EMAIL_IN_USE',
    })
  }

  if (existing) {
    const { error } = await admin.auth.admin.updateUserById(existing.id, { password })
    if (error) return res.status(400).json({ error: error.message })
    // Keep the sign-in name in step with the client record and make sure a
    // previously deactivated login can't stay off.
    await admin.from('profiles').update({
      name: client.name, username: client.name, active: true, role: 'policyholder',
    }).eq('id', existing.id)
    return res.status(200).json({ ok: true, created: false, email })
  }

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name: client.name, role: 'policyholder', department: 'Client Portal' },
  })
  if (createError || !created.user) {
    return res.status(400).json({ error: createError?.message ?? 'Failed to create the portal account.' })
  }

  // handle_new_user() writes the profile from user_metadata; username and
  // the active flag aren't part of its INSERT, so set them explicitly —
  // same pattern create-account.ts uses for staff.
  const { error: profileError } = await admin.from('profiles').update({
    username: client.name, active: true,
  }).eq('id', created.user.id)
  if (profileError) {
    // The auth user exists now either way — report it so staff retries the
    // password instead of believing nothing happened.
    return res.status(200).json({ ok: true, created: true, email, warning: `Profile touch-up failed: ${profileError.message}` })
  }

  return res.status(200).json({ ok: true, created: true, email })
}
