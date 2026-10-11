import type { VercelRequest, VercelResponse } from '@vercel/node'
import { serviceClient } from './_lib/sessionAuth.js'

/**
 * GET /api/health-check — the public "is the portal up and reachable?"
 * endpoint. Deliberately unauthenticated: the motions.co.zw website uses
 * it to verify its portal link before and during a registration, and the
 * System Health page displays the same result. It answers whether the
 * webapp + its database are serving — the exact dependency a website
 * signup flow has — without requiring a session or spending anything.
 *
 * Reports only capability booleans and a timestamp. No secrets, no data.
 */
export default async function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Cache-Control', 'no-store')
  if (_req.method === 'OPTIONS') return res.status(204).end()
  if (_req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' })

  const admin = serviceClient()
  if (!admin) {
    return res.status(503).json({ ok: false, db: false, detail: 'Server missing Supabase credentials', ts: new Date().toISOString() })
  }

  try {
    // A real query, not a liveness shim — proves the DB path the website's
    // registrations depend on is actually working.
    const { error } = await admin.from('products').select('id', { count: 'exact', head: true })
    if (error) {
      return res.status(503).json({ ok: false, db: false, detail: `Database unreachable: ${error.message}`, ts: new Date().toISOString() })
    }
    return res.status(200).json({ ok: true, db: true, detail: 'Portal and database reachable', ts: new Date().toISOString() })
  } catch (e) {
    return res.status(503).json({ ok: false, db: false, detail: `Health check failed: ${e instanceof Error ? e.message : e}`, ts: new Date().toISOString() })
  }
}
