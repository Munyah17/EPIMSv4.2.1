import type { VercelRequest, VercelResponse } from '@vercel/node'
import { serviceClient, requireSession } from './_lib/sessionAuth'

/**
 * POST /api/member-photo
 * Body: { memberNumber: "FCP0001-00", image: "data:image/png;base64,…", updatedBy?: string }
 *
 * One write path for member portraits, because two kinds of user save them:
 * staff editing a card in the office, and a policyholder on the portal
 * updating their own family's photos. Both come through here so the
 * ownership check lives in exactly one place:
 *
 *   - staff (profiles.role != 'client') can set any member's photo
 *   - a policyholder can only set a member number whose policy belongs to
 *     a client record carrying their own login email
 *
 * member_photos stays staff-writable in RLS; the write itself uses the
 * service role after the check above has decided.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const admin = serviceClient()
  if (!admin) return res.status(503).json({ error: 'Server not configured for photo uploads.' })
  if (!(await requireSession(req, admin))) return res.status(401).json({ error: 'Sign-in required.' })

  const { memberNumber, image, updatedBy } = req.body ?? {}
  if (typeof memberNumber !== 'string' || typeof image !== 'string') {
    return res.status(400).json({ error: 'memberNumber and image are required.' })
  }
  const match = image.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/)
  if (!match) return res.status(400).json({ error: 'image must be a PNG/JPEG/WebP data URL.' })
  const bytes = Buffer.from(match[2], 'base64')
  if (bytes.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'Photo is larger than 5MB.' })

  // Who is asking? Their email decides the ownership check for non-staff.
  const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
  const { data: { user } } = await admin.auth.getUser(token)
  if (!user?.email) return res.status(401).json({ error: 'Sign-in required.' })

  const { data: profile } = await admin.from('profiles').select('role').eq('id', user.id).maybeSingle()
  const isStaff = !!profile && profile.role !== 'client'

  if (!isStaff) {
    // Member number POL-NN -> the policy it belongs to -> that policy's
    // client -> whether this login's email is on that client record.
    const policyNumber = memberNumber.replace(/-\d{2}$/, '')
    const { data: policy } = await admin
      .from('policies')
      .select('client_id, clients!client_id(email)')
      .eq('policy_number', policyNumber)
      .maybeSingle()
    const clientEmail = (policy as { clients?: { email?: string } | null } | null)?.clients?.email
    if (!policy || !clientEmail || clientEmail.toLowerCase() !== user.email.toLowerCase()) {
      return res.status(403).json({ error: 'That member does not belong to your account.' })
    }
  }

  const path = `${memberNumber}.png`
  const { error: upErr } = await admin.storage.from('member-photos').upload(path, bytes, { upsert: true, contentType: 'image/png' })
  if (upErr) return res.status(502).json({ error: `Storage upload failed: ${upErr.message}` })

  const { data } = admin.storage.from('member-photos').getPublicUrl(path)
  const url = `${data.publicUrl}?v=${Date.now()}`
  await admin.from('member_photos').upsert(
    { member_number: memberNumber, photo_url: url, updated_by: updatedBy ?? user.email },
    { onConflict: 'member_number' },
  )
  return res.status(200).json({ url })
}
