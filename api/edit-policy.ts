/**
 * Edit policy endpoint with audit logging.
 * Super admins and authorised staff can edit any policy field including
 * dependants; every change is logged to audit_log for accountability.
 */

import { VercelRequest, VercelResponse } from '@vercel/node'
import { serviceClient } from './_lib/supabase'
import { requireSession } from './_lib/sessionAuth'
import { auditLog } from './_lib/audit'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const admin = serviceClient()
  if (!admin) return res.status(500).json({ error: 'Server is not configured.' })

  const session = await requireSession(req, admin)
  if (!session) return res.status(401).json({ error: 'Sign-in required.' })

  const { policyId, updates } = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {})
  if (!policyId || !updates) {
    return res.status(400).json({ error: 'policyId and updates are required.' })
  }

  // Fetch the current policy state for audit diff
  const { data: current, error: fetchError } = await admin
    .from('policies')
    .select('*')
    .eq('id', policyId)
    .single()

  if (fetchError || !current) {
    return res.status(404).json({ error: 'Policy not found.' })
  }

  // Build the update row and audit diff
  const row: Record<string, unknown> = {}
  const changes: Record<string, { old: unknown; new: unknown }> = {}

  if (updates.status !== undefined && updates.status !== current.status) {
    row.status = updates.status
    changes.status = { old: current.status, new: updates.status }
  }
  if (updates.paymentMethod !== undefined && updates.paymentMethod !== current.payment_method) {
    row.payment_method = updates.paymentMethod
    changes.paymentMethod = { old: current.payment_method, new: updates.paymentMethod }
  }
  if (updates.nextPaymentDate !== undefined && updates.nextPaymentDate !== current.next_payment_date) {
    row.next_payment_date = updates.nextPaymentDate
    changes.nextPaymentDate = { old: current.next_payment_date, new: updates.nextPaymentDate }
  }
  if (updates.agentId !== undefined && updates.agentId !== current.agent_id) {
    row.agent_id = updates.agentId
    changes.agentId = { old: current.agent_id, new: updates.agentId }
  }
  if (updates.agentName !== undefined && updates.agentName !== current.agent_name) {
    row.agent_name = updates.agentName
    changes.agentName = { old: current.agent_name, new: updates.agentName }
  }
  if (updates.growerNumber !== undefined && updates.growerNumber !== current.grower_number) {
    row.grower_number = updates.growerNumber
    changes.growerNumber = { old: current.grower_number, new: updates.growerNumber }
  }
  if (updates.contractor !== undefined && updates.contractor !== current.contractor) {
    row.contractor = updates.contractor
    changes.contractor = { old: current.contractor, new: updates.contractor }
  }
  if (updates.hectarage !== undefined && updates.hectarage !== current.hectarage) {
    row.hectarage = updates.hectarage
    changes.hectarage = { old: current.hectarage, new: updates.hectarage }
  }
  if (updates.premium !== undefined && updates.premium !== current.premium) {
    row.premium = updates.premium
    changes.premium = { old: current.premium, new: updates.premium }
  }
  if (updates.coverAmount !== undefined && updates.coverAmount !== current.cover_amount) {
    row.cover_amount = updates.coverAmount
    changes.coverAmount = { old: current.cover_amount, new: updates.coverAmount }
  }
  if (updates.endDate !== undefined && updates.endDate !== current.end_date) {
    row.end_date = updates.endDate
    changes.endDate = { old: current.end_date, new: updates.endDate }
  }
  if (updates.dependants !== undefined) {
    // Ensure dependants is always a valid array
    const dependantsArray = Array.isArray(updates.dependants) ? updates.dependants : []
    row.dependants = dependantsArray
    changes.dependants = { old: current.dependants, new: dependantsArray }
  }

  if (Object.keys(row).length === 0) {
    return res.status(400).json({ error: 'No changes detected.' })
  }

  // Perform the update
  const { data: updated, error: updateError } = await admin
    .from('policies')
    .update(row)
    .eq('id', policyId)
    .select()
    .single()

  if (updateError || !updated) {
    console.error('Policy update error:', JSON.stringify({ policyId, row, updateError }, null, 2))
    return res.status(500).json({ error: updateError?.message ?? 'Failed to update policy.', details: updateError })
  }

  // Log the audit entry
  const changedFields = Object.keys(changes).join(', ')
  await auditLog({
    operatorId: session.user.id,
    entityType: 'policy',
    entityId: policyId,
    action: `Edited policy: ${changedFields}`,
    changes,
    source: 'web',
  })

  return res.status(200).json({ data: updated })
}
