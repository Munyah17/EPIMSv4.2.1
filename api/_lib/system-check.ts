import type { VercelRequest, VercelResponse } from '@vercel/node'
import { callGroq, extractJson, GROQ_TEXT_MODEL } from './groq.js'
import { serviceClient } from './sessionAuth.js'

/**
 * AI-powered system problem checker.
 *
 * The model does NOT roam the database: deterministic probes run first
 * (a fixed checklist — proven engineering, not invention), a whitelisted
 * auto-fix repairs the one class of problem that's safe to repair blind
 * (malformed client phone numbers that can be re-normalised to a valid
 * Zimbabwe MSISDN), and Groq then interprets the probe results into a
 * plain-English diagnosis. If the AI is unreachable, the probes still
 * return their raw results — the checker's value doesn't depend on the
 * model.
 */

interface CheckResult {
  key: string
  label: string
  status: 'ok' | 'warning' | 'problem'
  count: number
  detail: string
}

// The same rules the SMS channel validates against — the fix has to
// produce numbers the sender itself accepts.
function normalizeMsisdn(raw: string): string {
  let digits = raw.replace(/\D/g, '')
  if (digits.startsWith('0')) digits = `263${digits.slice(1)}`
  else if (digits.startsWith('2630')) digits = `263${digits.slice(4)}`
  else if (!digits.startsWith('263')) digits = `263${digits}`
  return digits
}
const isValidMsisdn = (raw: string) => /^263[17]\d{8}$/.test(normalizeMsisdn(raw))

const dayAgo = () => new Date(Date.now() - 24 * 3600e3).toISOString()

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const admin = serviceClient()
  if (!admin) return res.status(500).json({ error: 'Server is not configured.' })

  const checks: CheckResult[] = []
  const fixed: string[] = []
  const check = (key: string, label: string, count: number, detail: string, warnAt = 1) =>
    checks.push({ key, label, count, detail, status: count === 0 ? 'ok' : count >= warnAt ? 'problem' : 'warning' })

  try {
    // ── 1. Notification delivery failures (24h, undismissed) ──
    const { data: fails } = await admin.from('notification_log')
      .select('channel, recipient, detail, created_at')
      .eq('status', 'failed').is('dismissed_at', null)
      .gte('created_at', dayAgo())
      .order('created_at', { ascending: false }).limit(50)
    const failList = fails ?? []
    const byChannel: Record<string, number> = {}
    for (const f of failList) byChannel[f.channel] = (byChannel[f.channel] ?? 0) + 1
    check('notifications', 'Notification delivery (24h)', failList.length,
      failList.length === 0 ? 'All notifications delivered.'
        : `${Object.entries(byChannel).map(([c, n]) => `${n} ${c}`).join(', ')} failed. Latest: ${failList[0].channel} → ${failList[0].recipient}${failList[0].detail ? ` (${String(failList[0].detail).slice(0, 100)})` : ''}`)

    // ── 2. Client phone validity — the one safe auto-fix ──
    const { data: clients } = await admin.from('clients')
      .select('id, name, phone').not('phone', 'is', null).limit(2000)
    const badPhones: string[] = []
    let phonesFixed = 0
    for (const c of clients ?? []) {
      const phone = String(c.phone ?? '')
      if (!phone.trim() || isValidMsisdn(phone)) continue
      const norm = normalizeMsisdn(phone)
      if (isValidMsisdn(norm)) {
        const { error } = await admin.from('clients').update({ phone: `+${norm}` }).eq('id', c.id)
        if (!error) { phonesFixed++; continue }
      }
      badPhones.push(`${c.name} (${phone})`)
    }
    if (phonesFixed) fixed.push(`Normalised ${phonesFixed} invalid client phone number${phonesFixed === 1 ? '' : 's'} to +263 format — SMS deliveries to them now work.`)
    check('phones', 'Client phone numbers', badPhones.length,
      badPhones.length === 0
        ? `Every client phone validates${phonesFixed ? ` (${phonesFixed} just repaired)` : ''}.`
        : `Unfixable numbers: ${badPhones.slice(0, 5).join('; ')}${badPhones.length > 5 ? ` and ${badPhones.length - 5} more` : ''} — correct these by hand.`)

    // ── 3. Group members without negotiated terms ──
    const { count: unpriced } = await admin.from('group_members')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'active').or('premium.is.null,cover_amount.is.null')
    check('group-pricing', 'Group member pricing', unpriced ?? 0,
      (unpriced ?? 0) === 0 ? 'Every active group member has negotiated terms.'
        : `${unpriced} active roster member${unpriced === 1 ? ' has' : 's have'} no premium or sum assured — they bill at product defaults until edited.`)

    // ── 4. Agriculture policies missing hectarage ──
    const { data: agriPolicies } = await admin.from('policies')
      .select('id, policy_number, products!product_id(category)')
      .is('hectarage', null).in('status', ['active', 'waiting_period']).limit(500)
    const missingHa = (agriPolicies ?? []).filter(p => (p.products as { category?: string } | null)?.category === 'agriculture')
    check('hectarage', 'Agriculture hectarage', missingHa.length,
      missingHa.length === 0 ? 'Every live agriculture policy records the planted area.'
        : `${missingHa.length} live agriculture polic${missingHa.length === 1 ? 'y has' : 'ies have'} no hectarage — edit them to record the planted area.`)

    // ── 5. Live policies with no premium ──
    const { data: zeroPrem } = await admin.from('policies')
      .select('policy_number', { count: 'exact', head: false })
      .in('status', ['active', 'waiting_period']).lte('premium', 0).limit(50)
    check('premiums', 'Policy premiums', (zeroPrem ?? []).length,
      (zeroPrem ?? []).length === 0 ? 'Every live policy carries a positive premium.'
        : `Live policies billing $0: ${(zeroPrem ?? []).slice(0, 5).map(p => p.policy_number).join(', ')} — a policy without a price collects nothing.`)

    // ── 6. Client-posted health snapshot (optional) ──
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {})
    const snap = body.health as { totalOps?: number; sbSuccessPct?: number; localMode?: boolean } | undefined
    if (snap && typeof snap.totalOps === 'number') {
      check('db-health', 'Database operations (session)', snap.localMode ? 1 : 0,
        `${snap.totalOps} ops, ${snap.sbSuccessPct}% success${snap.localMode ? ' — currently serving CACHED data (offline mode)' : ' — Supabase connected'}.`)
    }

    // ── Groq interprets the probe results ──
    const apiKey = process.env.GROQ_API_KEY
    const problems = checks.filter(c => c.status !== 'ok')
    if (!apiKey) {
      return res.status(200).json({
        ok: true, checkedAt: new Date().toISOString(), checks, fixed,
        ai: { simulated: true, summary: problems.length === 0 ? 'All checks pass.' : `${problems.length} area${problems.length === 1 ? '' : 's'} need attention — AI analysis not configured.` },
      })
    }

    const prompt = `You are the reliability engineer for a Zimbabwean micro-insurance platform (clients, policies, group schemes, agriculture cover, payments, SMS/email/WhatsApp notifications). Below are results from the system's deterministic health probes. Interpret them for an operations manager — plain English, actionable, no jargon.

PROBE RESULTS:
${JSON.stringify(checks, null, 1)}

AUTO-FIXES ALREADY APPLIED (do not recommend re-fixing these):
${JSON.stringify(fixed.length ? fixed : ['none'], null, 1)}

Respond with ONLY a JSON object:
{"summary": "<2-3 sentence verdict on system health>",
"findings": [{"severity": "critical|warning|info", "area": "<which part of the system>", "problem": "<what is wrong, one sentence>", "recommendation": "<what to do about it, one sentence>"}]
Include only real problems (severity critical or warning); omit healthy areas. If everything is fine, return an empty findings array.}`

    const groq = await callGroq(apiKey, [{ role: 'user', content: prompt }], { model: GROQ_TEXT_MODEL, maxTokens: 900, temperature: 0.3 })
    if (!groq.ok) {
      return res.status(200).json({
        ok: true, checkedAt: new Date().toISOString(), checks, fixed,
        ai: { simulated: true, summary: `Checks ran but AI analysis failed (${groq.status}). ${problems.length} area${problems.length === 1 ? '' : 's'} flagged — see the list.` },
      })
    }
    const parsed = extractJson<{ summary?: string; findings?: { severity?: string; area?: string; problem?: string; recommendation?: string }[] }>(groq.content)
    return res.status(200).json({
      ok: true, checkedAt: new Date().toISOString(), checks, fixed,
      ai: {
        summary: parsed?.summary ?? 'Analysis returned no summary — see the check list.',
        findings: Array.isArray(parsed?.findings) ? parsed.findings.filter(f => f && typeof f.problem === 'string') : [],
      },
    })
  } catch (e) {
    return res.status(500).json({ error: `System check failed: ${e}` })
  }
}
