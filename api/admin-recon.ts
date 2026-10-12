import type { VercelRequest, VercelResponse } from '@vercel/node'
import { serviceClient, requireSession } from './_lib/sessionAuth.js'

/**
 * GET /api/admin-recon — the live version of the cron's daily
 * reconciliation. Returns the three "money/record happened, counterpart
 * didn't" counts with item lists so System Health (and the Recon card)
 * shows unresolved issues right now, not only in tomorrow's email.
 * Staff-only — the lists carry client names and contact details.
 */
const KINDS = new Set(['orphaned_client', 'stale_paynow', 'paid_but_pending'])

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const admin = serviceClient()
  if (!admin) return res.status(503).json({ error: 'Server is not configured.' })
  if (!(await requireSession(req, admin))) return res.status(401).json({ error: 'Sign-in required.' })

  const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
  const { data: { user } } = await admin.auth.getUser(token)
  const { data: profile } = await admin.from('profiles').select('role').eq('id', user!.id).maybeSingle()
  if (!['super_admin', 'admin', 'finance'].includes(profile?.role ?? '')) {
    return res.status(403).json({ error: 'Admins and finance only.' })
  }

  // POST — acknowledge items so they stop re-raising the card. The
  // underlying rows keep their truth; new unmatched items still alert.
  if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {})
    const items: { kind: string; ref: string }[] = Array.isArray(body.items) ? body.items : []
    const rows = items
      .filter(i => i && KINDS.has(i.kind) && typeof i.ref === 'string' && i.ref)
      .map(i => ({ kind: i.kind, ref: i.ref, dismissed_by: user!.id }))
    if (!rows.length) return res.status(400).json({ error: 'Nothing to dismiss — pass { items: [{ kind, ref }] }.' })
    const { error } = await admin.from('recon_dismissals').upsert(rows, { onConflict: 'kind,ref' })
    if (error) return res.status(500).json({ error: 'Could not dismiss the items.' })
    return res.status(200).json({ ok: true, dismissed: rows.length })
  }

  const cutoff = new Date(Date.now() - 24 * 3600e3).toISOString()

  const [{ data: clients }, { data: policyClientIds }, { data: stale }, { data: pending }, { data: dismissed }] = await Promise.all([
    admin.from('clients').select('id, name, phone, created_at').lt('created_at', cutoff).order('created_at', { ascending: false }),
    admin.from('policies').select('client_id'),
    admin.from('paynow_transactions').select('reference, expected_amount, currency, created_at').eq('status', 'pending').lt('created_at', cutoff),
    admin.from('policies').select('id, policy_number, clients!client_id(name, phone)').eq('status', 'pending'),
    admin.from('recon_dismissals').select('kind, ref'),
  ])

  const dismissedSet = new Set((dismissed ?? []).map(d => `${d.kind}:${d.ref}`))
  const notDismissed = (kind: string, ref: string) => !dismissedSet.has(`${kind}:${ref}`)

  const covered = new Set((policyClientIds ?? []).map(p => p.client_id))
  const orphanedClients = (clients ?? []).filter(c => !covered.has(c.id) && notDismissed('orphaned_client', c.id))
    .map(c => ({ id: c.id, name: c.name, phone: c.phone, createdAt: c.created_at }))

  const paidButPending: { id: string; policyNumber: string; clientName: string }[] = []
  for (const p of (pending ?? []) as unknown as { id: string; policy_number: string; clients: { name: string } | null }[]) {
    if (!notDismissed('paid_but_pending', p.id)) continue
    const { data: pays } = await admin.from('payments').select('reference').eq('policy_id', p.id).eq('status', 'completed').limit(1)
    if (pays?.length) paidButPending.push({ id: p.id, policyNumber: p.policy_number, clientName: p.clients?.name ?? '' })
  }

  return res.status(200).json({
    orphanedClients,
    stalePaynow: (stale ?? []).filter(t => notDismissed('stale_paynow', t.reference))
      .map(t => ({ reference: t.reference, amount: t.expected_amount, currency: t.currency, createdAt: t.created_at })),
    paidButPending,
    checkedAt: new Date().toISOString(),
  })
}
