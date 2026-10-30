import type { VercelRequest, VercelResponse } from '@vercel/node'
import { serviceClient, requireSession } from './_lib/sessionAuth.js'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * POST /api/member-photo — two-phase signed upload.
 *
 *   Phase 1  { memberNumber }                    -> { path, token }
 *   Phase 2  { memberNumber, confirm, updatedBy }-> { url }
 *
 * The image itself never crosses this function: phase 1 verifies the
 * caller and mints a short-lived signed upload URL; the browser PUTs the
 * file straight to Supabase Storage (no Vercel body-size ceiling — that
 * 4.5MB cap was the earlier 500 on a large photo); phase 2 registers the
 * finished photo on member_photos.
 *
 * Who may upload is decided here once: staff (any STAFF_ROLES profile)
 * for any member; a policyholder only for a member number whose policy
 * belongs to the client record carrying their login email.
 */

const STAFF_ROLES = ['super_admin', 'admin', 'tech_support', 'claims_officer', 'policy_admin', 'finance', 'client_relations', 'agent']

/** Staff = free rein. Policyholder = the member's policy must belong to
 *  a client record carrying their login email (the same rule the portal's
 *  own-data reads use). */
async function canUpload(admin: SupabaseClient, memberNumber: string, email: string, role: string | undefined): Promise<boolean> {
  if (role && STAFF_ROLES.includes(role)) return true
  const policyNumber = memberNumber.replace(/-\d{2}$/, '')
  const { data: policy } = await admin.from('policies').select('client_id').eq('policy_number', policyNumber).maybeSingle()
  if (!policy) return false
  const { data: client } = await admin.from('clients').select('email').eq('id', policy.client_id).maybeSingle()
  return !!client?.email && client.email.toLowerCase() === email.toLowerCase()
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

    const admin = serviceClient()
    if (!admin) return res.status(503).json({ error: 'Server not configured for photo uploads.' })

    const session = await requireSession(req, admin)
    if (!session) return res.status(401).json({ error: 'Sign-in required.' })

    const { memberNumber, confirm, updatedBy } = req.body ?? {}
    if (typeof memberNumber !== 'string' || !/^[A-Z0-9]+-\d{2}$/.test(memberNumber)) {
      return res.status(400).json({ error: 'A valid memberNumber (e.g. FCP0001-00) is required.' })
    }

    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
    const { data: { user } } = await admin.auth.getUser(token)
    if (!user?.email) return res.status(401).json({ error: 'Sign-in required.' })
    const { data: profile } = await admin.from('profiles').select('role').eq('id', user.id).maybeSingle()

    if (!(await canUpload(admin, memberNumber, user.email, profile?.role))) {
      return res.status(403).json({ error: 'That member does not belong to your account.' })
    }

    const path = `${memberNumber}.png`

    if (!confirm) {
      const { data, error } = await admin.storage.from('member-photos').createSignedUploadUrl(path, { upsert: true })
      if (error || !data) return res.status(502).json({ error: `Could not create the upload URL: ${error?.message ?? 'no URL returned'}` })
      return res.status(200).json({ path, token: data.token })
    }

    // confirm — the file landed; register the (cache-busted) URL.
    const { data } = admin.storage.from('member-photos').getPublicUrl(path)
    const url = `${data.publicUrl}?v=${Date.now()}`
    const { error: rowErr } = await admin.from('member_photos').upsert(
      { member_number: memberNumber, photo_url: url, updated_by: updatedBy ?? user.email },
      { onConflict: 'member_number' },
    )
    if (rowErr) return res.status(502).json({ error: `Could not save the photo record: ${rowErr.message}` })
    return res.status(200).json({ url })
  } catch (e) {
    // Surface the real message instead of Vercel's bare 500 — the caller's
    // toast shows it and the log keeps the stack.
    console.error('[member-photo] Error:', e)
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
}
