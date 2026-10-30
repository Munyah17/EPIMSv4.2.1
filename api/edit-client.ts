/**
 * Edit client endpoint with audit logging.
 * Super admins and authorised staff can edit any client field; every change
 * is logged to audit_log for accountability.
 */

import { VercelRequest, VercelResponse } from '@vercel/node'
import { serviceClient, requireSession } from './_lib/sessionAuth'
import { auditLog } from './_lib/audit'
import { isZwNationalId, isZwPhone, normalizeNationalId } from './_lib/zwFormats.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const admin = serviceClient()
  if (!admin) return res.status(500).json({ error: 'Server is not configured.' })

  const session = await requireSession(req, admin)
  if (!session) return res.status(401).json({ error: 'Sign-in required.' })

  const { clientId, updates } = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {})
  if (!clientId || !updates) {
    return res.status(400).json({ error: 'clientId and updates are required.' })
  }

  // Fetch the current client state for audit diff
  const { data: current, error: fetchError } = await admin
    .from('clients')
    .select('*')
    .eq('id', clientId)
    .single()

  if (fetchError || !current) {
    return res.status(404).json({ error: 'Client not found.' })
  }

  // Build the update row and audit diff
  const row: Record<string, unknown> = {}
  const changes: Record<string, { old: unknown; new: unknown }> = {}

  if (updates.name !== undefined && updates.name !== current.name) {
    row.name = updates.name
    changes.name = { old: current.name, new: updates.name }
  }
  if (updates.email !== undefined && updates.email !== current.email) {
    row.email = updates.email
    changes.email = { old: current.email, new: updates.email }
  }
  if (updates.phone !== undefined && updates.phone !== current.phone) {
    // Same rule the modal enforces — the endpoint must not be a backdoor
    // around the format check.
    const phone = String(updates.phone).trim()
    if (!isZwPhone(phone)) {
      return res.status(400).json({ error: 'phone is not a valid Zimbabwean number — +263 followed by 9 digits, or 10 digits starting with 0.' })
    }
    row.phone = phone
    changes.phone = { old: current.phone, new: phone }
  }
  if (updates.address !== undefined && updates.address !== current.address) {
    row.address = updates.address
    changes.address = { old: current.address, new: updates.address }
  }
  if (updates.occupation !== undefined && updates.occupation !== current.occupation) {
    row.occupation = updates.occupation
    changes.occupation = { old: current.occupation, new: updates.occupation }
  }
  if (updates.gender !== undefined && updates.gender !== current.gender) {
    row.gender = updates.gender
    changes.gender = { old: current.gender, new: updates.gender }
  }
  if (updates.status !== undefined && updates.status !== current.status) {
    row.status = updates.status
    changes.status = { old: current.status, new: updates.status }
  }
  if (updates.dob !== undefined && updates.dob !== current.dob) {
    row.dob = updates.dob
    changes.dob = { old: current.dob, new: updates.dob }
  }
  if (updates.nationalId !== undefined && updates.nationalId !== current.nationalId) {
    // Same rule the modal enforces — the endpoint must not be a backdoor
    // around the format check.
    const nid = normalizeNationalId(String(updates.nationalId))
    if (nid && !isZwNationalId(nid)) {
      return res.status(400).json({ error: 'nationalId is not a valid Zimbabwean ID — 8–9 digits, a letter, then 2 digits (e.g. 632118532K12).' })
    }
    row.national_id = nid
    changes.nationalId = { old: current.nationalId, new: nid }
  }

  if (Object.keys(row).length === 0) {
    return res.status(400).json({ error: 'No changes detected.' })
  }

  // Perform the update
  const { data: updated, error: updateError } = await admin
    .from('clients')
    .update(row)
    .eq('id', clientId)
    .select()
    .single()

  if (updateError || !updated) {
    console.error('Client update error:', updateError)
    console.error('Update row:', row)
    console.error('Client ID:', clientId)
    return res.status(500).json({ error: updateError?.message ?? 'Failed to update client.', details: updateError })
  }

  // Log the audit entry
  const changedFields = Object.keys(changes).join(', ')
  await auditLog({
    operatorId: session.user.id,
    entityType: 'client',
    entityId: clientId,
    action: `Edited client: ${changedFields}`,
    changes,
    source: 'web',
  })

  return res.status(200).json({ data: updated })
}
