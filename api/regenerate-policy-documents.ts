/**
 * Regenerate policy documents endpoint.
 * Super Admin only - re-issues policy documents with updated Terms and Conditions.
 * Can filter by category, status, or date range to control scope.
 */

import { VercelRequest, VercelResponse } from '@vercel/node'
import { serviceClient, requireSession } from './_lib/sessionAuth'
import { auditLog } from './_lib/audit'
import { fetchAllRows } from '../src/lib/paged.js'
import { getPolicyReportPdfBase64 } from '../src/lib/exportUtils'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const admin = serviceClient()
  if (!admin) return res.status(500).json({ error: 'Server is not configured.' })

  // Check for service role key in Authorization header (for script execution)
  const authHeader = req.headers.authorization || ''
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  let session = null
  let isServiceRole = false

  if (authHeader.startsWith('Bearer ') && authHeader.slice(7) === serviceRoleKey) {
    // Service role key provided - skip session check
    isServiceRole = true
  } else {
    // Normal session auth
    session = await requireSession(req, admin)
    if (!session) return res.status(401).json({ error: 'Sign-in required.' })

    // Only Super Admin can regenerate documents
    const { data: profile } = await admin
      .from('profiles')
      .select('role')
      .eq('id', session.user.id)
      .single()

    if (!profile || profile.role !== 'super_admin') {
      return res.status(403).json({ error: 'Super Admin access required.' })
    }
  }

  const { category, status, startDate, endDate, dryRun = false } = typeof req.body === 'string' 
    ? JSON.parse(req.body || '{}') 
    : (req.body ?? {})

  // Build query with filters
  const { data: policies, error: fetchError } = await fetchAllRows(
    () => {
      let query = admin
        .from('policies')
        .select('*, clients(*)')
      if (category) query = query.eq('category', category)
      if (status) query = query.eq('status', status)
      if (startDate) query = query.gte('created_at', startDate)
      if (endDate) query = query.lte('created_at', endDate)
      return query
    },
    { orderBy: 'id' },
  )

  if (fetchError) {
    return res.status(500).json({ error: 'Failed to fetch policies.', details: fetchError.message })
  }

  if (!policies || policies.length === 0) {
    return res.status(404).json({ error: 'No policies found matching criteria.' })
  }

  const results = {
    total: policies.length,
    success: 0,
    failed: 0,
    errors: [] as { policyId: string; policyNumber: string; error: string }[],
  }

  for (const policy of policies) {
    try {
      const client = policy.clients
      if (!client) {
        results.failed++
        results.errors.push({
          policyId: policy.id,
          policyNumber: policy.policy_number,
          error: 'Client not found',
        })
        continue
      }

      // Determine category
      const category = policy.category || 'general'
      
      // Generate new PDF
      const pdfBase64 = await getPolicyReportPdfBase64(policy, client, category)
      
      if (!dryRun) {
        // Convert base64 to buffer and upload directly to Supabase storage
        const pdfBuffer = Buffer.from(pdfBase64, 'base64')
        const filename = `${policy.policy_number}-Policy-Report.pdf`
        const storagePath = `${policy.id}/${filename}`

        const { error: uploadError } = await admin.storage
          .from('policies')
          .upload(storagePath, pdfBuffer, {
            contentType: 'application/pdf',
            upsert: true
          })

        if (uploadError) {
          results.failed++
          results.errors.push({
            policyId: policy.id,
            policyNumber: policy.policy_number,
            error: uploadError.message,
          })
          continue
        }

        // Update policy documents array
        const currentDocs = policy.documents || []
        const updatedDocs = [...currentDocs, `policies/${storagePath}`]

        const { error: updateError } = await admin
          .from('policies')
          .update({ documents: updatedDocs })
          .eq('id', policy.id)

        if (updateError) {
          results.failed++
          results.errors.push({
            policyId: policy.id,
            policyNumber: policy.policy_number,
            error: updateError.message,
          })
          continue
        }
      }

      results.success++
    } catch (err) {
      results.failed++
      results.errors.push({
        policyId: policy.id,
        policyNumber: policy.policy_number,
        error: err instanceof Error ? err.message : 'Unknown error',
      })
    }
  }

  // Log the batch operation
  if (session) {
    await auditLog({
      operatorId: session.user.id,
      entityType: 'policy',
      entityId: 'batch',
      action: `Regenerated policy documents: ${results.success} succeeded, ${results.failed} failed`,
      changes: {
        result: { old: { total: results.total }, new: { success: results.success, failed: results.failed } },
      },
      source: 'web',
    })
  }

  return res.status(200).json({
    message: dryRun 
      ? `Dry run complete. Would regenerate ${results.total} policies.` 
      : `Regenerated ${results.success} policy documents successfully. ${results.failed} failed.`,
    results,
  })
}
