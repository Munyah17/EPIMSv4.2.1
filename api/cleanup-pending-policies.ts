import type { VercelRequest, VercelResponse } from '@vercel/node'
import { serviceClient } from './_lib/sessionAuth.js'

/**
 * POST /api/cleanup-pending-policies
 * 
 * Cleans up stale pending policies (older than 24 hours).
 * Called by Vercel cron job to prevent accumulation of abandoned signups.
 * 
 * Auth: CRON_SECRET (shared secret for cron jobs)
 */

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) return res.status(503).json({ error: 'Server not configured.' })
  if (req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized.' })
  }

  const admin = serviceClient()
  if (!admin) return res.status(503).json({ error: 'Server is not configured.' })

  try {
    const { data, error } = await admin.rpc('cleanup_stale_pending_policies')
    if (error) throw new Error(`Cleanup failed: ${error.message}`)
    
    const deletedCount = typeof data === 'number' ? data : 0
    return res.status(200).json({ ok: true, deleted: deletedCount })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('cleanup-pending-policies failed:', msg)
    return res.status(500).json({ ok: false, error: msg })
  }
}
