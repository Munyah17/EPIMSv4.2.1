import type { VercelRequest, VercelResponse } from '@vercel/node'
import { callGroq, extractJson, GROQ_TEXT_MODEL } from './groq.js'
import { serviceClient } from './sessionAuth.js'
import { fetchAllRows } from '../../src/lib/paged.js'

/**
 * AI-powered system problem checker.
 *
 * The model does NOT roam the database: deterministic probes run first
 * (a fixed checklist â€” proven engineering, not invention), a whitelisted
 * auto-fix repairs the one class of problem that's safe to repair blind
 * (malformed client phone numbers that can be re-normalised to a valid
 * Zimbabwe MSISDN), and Groq then interprets the probe results into a
 * plain-English diagnosis. If the AI is unreachable, the probes still
 * return their raw results â€” the checker's value doesn't depend on the
 * model.
 */

interface CheckResult {
  key: string
  label: string
  status: 'ok' | 'warning' | 'problem'
  count: number
  detail: string
}

// The same rules the SMS channel validates against â€” the fix has to
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

  // Who ran this check â€” fixes are logged against them.
  const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
  const { data: { user } } = await admin.auth.getUser(token)

  try {
    // â”€â”€ 0. Configuration â€” every integration this deployment relies on.
    //    Presence only; secret VALUES never leave the server. â”€â”€
    const env = process.env
    const config: { name: string; present: boolean; severity: 'problem' | 'warning' }[] = [
      { name: 'SMS gateway (Afrosoft)', present: !!env.AFROSOFT_SMS_API_KEY, severity: 'problem' },
      { name: 'Paynow USD', present: !!(env.PAYNOW_INTEGRATION_ID && env.PAYNOW_INTEGRATION_KEY), severity: 'problem' },
      { name: 'Paynow live mode', present: env.PAYNOW_LIVE === 'true', severity: 'warning' },
      { name: 'WhatsApp bot', present: !!(env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID), severity: 'problem' },
      { name: 'EcoCash Instant', present: !!(env.EIP_USERNAME && env.EIP_PASSWORD), severity: 'warning' },
      { name: 'Email', present: !!(env.SMTP_HOST && env.SMTP_PASSWORD) || !!(env.MS_CLIENT_ID && env.MS_CLIENT_SECRET), severity: 'warning' },
      { name: 'AI (Groq)', present: !!env.GROQ_API_KEY, severity: 'warning' },
    ]
    const missing = config.filter(c => !c.present)
    check('config', 'Service configuration', missing.length,
      missing.length === 0 ? 'Every integration is configured.'
        : `Not configured: ${missing.map(c => c.name).join(', ')} â€” set the environment variables and redeploy.`,
      2)
    // Keep severity distinction in the check status: 'problem' items stay
    // red, 'warning'-only gaps stay amber.
    checks[checks.length - 1].status = missing.length === 0 ? 'ok'
      : missing.some(c => c.severity === 'problem') ? 'problem' : 'warning'

    // â”€â”€ 0b. The portalâ†”database link, checked the way the website does â”€â”€
    try {
      const hc = await fetch('https://portal.motions.co.zw/api/health-check', { signal: AbortSignal.timeout(8000) })
        .then(r => r.json()).catch(() => null)
      check('portal-link', 'Portal â†” database link', hc?.ok && hc?.db ? 0 : 1,
        hc === null ? 'The health endpoint did not answer â€” the portal may be down.'
          : hc?.ok && hc?.db ? 'Portal reaches the database.'
          : `Health endpoint answers but reports a fault (${hc?.detail ?? 'see System Health'}).`)
    } catch {
      check('portal-link', 'Portal â†” database link', 1, 'Could not reach the health endpoint.')
    }

    // â”€â”€ 0c. Schema â€” the columns the code depends on must actually exist â”€â”€
    const REQUIRED: [string, string][] = [
      ['policies', 'hectarage'], ['policies', 'contractor'], ['policies', 'grower_number'],
      ['group_members', 'premium'], ['group_members', 'cover_amount'],
      ['notification_log', 'dismissed_at'], ['recon_dismissals', 'kind'], ['system_fixes', 'kind'],
    ]
    const missingCols: string[] = []
    for (const [table, col] of REQUIRED) {
      const { error } = await admin.from(table).select(col).limit(1)
      if (error) missingCols.push(`${table}.${col}`)
    }
    check('schema', 'Database schema', missingCols.length,
      missingCols.length === 0 ? 'Every required table and column exists.'
        : `Missing: ${missingCols.join(', ')} â€” apply the outstanding database/*.sql migrations.`)

    // â”€â”€ 1. Notification delivery failures (24h, undismissed) â”€â”€
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {})
    // Run Check probes and PROPOSES; Run Fix applies the whitelisted
    // repairs and logs each one in system_fixes.
    const apply = body.apply === true
    let fixable = 0
    const logFix = async (kind: string, detail: string, records: number) =>
      admin.from('system_fixes').insert({ kind, detail, records, applied_by: user?.id ?? null })

    const { data: fails } = await admin.from('notification_log')
      .select('channel, recipient, detail, created_at')
      .eq('status', 'failed').is('dismissed_at', null)
      .gte('created_at', dayAgo())
      .order('created_at', { ascending: false }).limit(50)
    const failList = fails ?? []
    const byChannel: Record<string, number> = {}
    for (const f of failList) byChannel[f.channel] = (byChannel[f.channel] ?? 0) + 1
    if (apply && failList.length) {
      // Acknowledge current failures â€” the records keep status='failed',
      // they just stop re-raising the banner (same as pressing Clear).
      await admin.from('notification_log').update({ dismissed_at: new Date().toISOString() })
        .eq('status', 'failed').is('dismissed_at', null).gte('created_at', dayAgo())
      await logFix('notifications_acknowledged', `Acknowledged ${failList.length} failed notification${failList.length === 1 ? '' : 's'} â€” records kept, banner cleared.`, failList.length)
      fixed.push(`Acknowledged ${failList.length} failed notification${failList.length === 1 ? '' : 's'} â€” the failure records stay, the banner clears.`)
    }
    check('notifications', 'Notification delivery (24h)', apply ? 0 : failList.length,
      apply && failList.length ? `${failList.length} failure${failList.length === 1 ? '' : 's'} acknowledged.`
        : failList.length === 0 ? 'All notifications delivered.'
        : `${Object.entries(byChannel).map(([c, n]) => `${n} ${c}`).join(', ')} failed. Latest: ${failList[0].channel} â†’ ${failList[0].recipient}${failList[0].detail ? ` (${String(failList[0].detail).slice(0, 100)})` : ''}`)
    if (!apply && failList.length) fixable += failList.length

    // â”€â”€ 2. Client phone validity â€” auto-fix: re-normalise â”€â”€
    const { data: clients } = await fetchAllRows(
      () => admin.from('clients').select('id, name, phone').not('phone', 'is', null),
      { orderBy: 'id' },
    )
    const badPhones: string[] = []
    let phonesFixed = 0, phonesFixable = 0
    for (const c of clients ?? []) {
      const phone = String(c.phone ?? '')
      if (!phone.trim() || isValidMsisdn(phone)) continue
      const norm = normalizeMsisdn(phone)
      if (isValidMsisdn(norm)) {
        if (apply) {
          const { error } = await admin.from('clients').update({ phone: `+${norm}` }).eq('id', c.id)
          if (!error) { phonesFixed++; continue }
        } else { phonesFixable++; continue }
      }
      badPhones.push(`${c.name} (${phone})`)
    }
    if (apply && phonesFixed) {
      fixed.push(`Normalised ${phonesFixed} invalid client phone number${phonesFixed === 1 ? '' : 's'} to +263 format â€” SMS deliveries to them now work.`)
      await logFix('phone_normalized', `Normalised ${phonesFixed} client phone number${phonesFixed === 1 ? '' : 's'} to valid +263 MSISDN format.`, phonesFixed)
    }
    fixable += phonesFixable
    check('phones', 'Client phone numbers', badPhones.length,
      badPhones.length === 0 && phonesFixable === 0
        ? `Every client phone validates${phonesFixed ? ` (${phonesFixed} just repaired)` : ''}.`
        : [
            badPhones.length ? `Unfixable numbers: ${badPhones.slice(0, 5).join('; ')}${badPhones.length > 5 ? ` and ${badPhones.length - 5} more` : ''} â€” correct these by hand.` : '',
            phonesFixable ? `${phonesFixable} invalid number${phonesFixable === 1 ? '' : 's'} the fixer can normalise.` : '',
          ].filter(Boolean).join(' '))

    // â”€â”€ 3. Group members without negotiated terms â€” auto-fix: the
    //     group's product default is the floor when nothing is agreed â”€â”€
    const { data: unpriced } = await admin.from('group_members')
      .select('id, group_id').eq('status', 'active').or('premium.is.null,cover_amount.is.null').limit(500)
    let membersFixed = 0, membersFixable = 0
    if (unpriced?.length) {
      const groupIds = [...new Set(unpriced.map(m => m.group_id))]
      const { data: groupPolicies } = await admin.from('policies')
        .select('group_id, products!product_id(premium, cover_amount)').in('group_id', groupIds).limit(500)
      const defaults = new Map<string, { premium: number; cover_amount: number }>()
      for (const p of (groupPolicies ?? []) as unknown as { group_id: string; products: { premium: number; cover_amount: number } | null }[]) {
        if (p.products && !defaults.has(p.group_id)) defaults.set(p.group_id, p.products)
      }
      for (const m of unpriced) {
        const d = defaults.get(m.group_id)
        if (!d) continue
        if (apply) {
          const { error } = await admin.from('group_members')
            .update({ premium: d.premium, cover_amount: d.cover_amount }).eq('id', m.id)
          if (!error) membersFixed++
        } else membersFixable++
      }
    }
    if (apply && membersFixed) {
      fixed.push(`Set ${membersFixed} unpriced group member${membersFixed === 1 ? '' : 's'} to their group's product defaults â€” they can be re-negotiated later.`)
      await logFix('group_member_pricing', `Set ${membersFixed} unpriced group member${membersFixed === 1 ? '' : 's'} to the product default premium and sum assured.`, membersFixed)
    }
    fixable += membersFixable
    check('group-pricing', 'Group member pricing', (unpriced ?? []).length - membersFixed,
      (unpriced ?? []).length === 0 ? 'Every active group member has negotiated terms.'
        : apply ? `${membersFixed} priced at product defaults${(unpriced ?? []).length - membersFixed > 0 ? `, ${(unpriced ?? []).length - membersFixed} unresolved` : ''}.`
        : `${(unpriced ?? []).length} member${(unpriced ?? []).length === 1 ? '' : 's'} missing terms${membersFixable ? ` â€” the fixer can set ${membersFixable} to product defaults` : ''}.`)

    // â”€â”€ 4. Agriculture policies missing hectarage â€” planted area is
    //     data only the grower knows; the fixer cannot invent it. â”€â”€
    const { data: agriPolicies } = await admin.from('policies')
      .select('id, policy_number, products!product_id(category)')
      .is('hectarage', null).in('status', ['active', 'waiting_period']).limit(500)
    const missingHa = (agriPolicies ?? []).filter(p => (p.products as { category?: string } | null)?.category === 'agriculture')
    check('hectarage', 'Agriculture hectarage', missingHa.length,
      missingHa.length === 0 ? 'Every live agriculture policy records the planted area.'
        : `${missingHa.length} live agriculture polic${missingHa.length === 1 ? 'y has' : 'ies have'} no hectarage â€” edit them to record the planted area.`)

    // â”€â”€ 5. Live policies billing $0 â€” auto-fix: the product default â”€â”€
    const { data: zeroPrem } = await admin.from('policies')
      .select('id, policy_number, products!product_id(premium, cover_amount)')
      .in('status', ['active', 'waiting_period']).lte('premium', 0).limit(50)
    let premFixed = 0, premFixable = 0
    for (const p of (zeroPrem ?? []) as unknown as { id: string; policy_number: string; products: { premium: number; cover_amount: number } | null }[]) {
      const d = p.products
      if (!d?.premium) continue
      if (apply) {
        const { error } = await admin.from('policies').update({ premium: d.premium }).eq('id', p.id)
        if (!error) premFixed++
      } else premFixable++
    }
    if (apply && premFixed) {
      fixed.push(`Set ${premFixed} $0 polic${premFixed === 1 ? 'y' : 'ies'} to the product default premium â€” billing resumes.`)
      await logFix('policy_premium_default', `Set ${premFixed} $0 live polic${premFixed === 1 ? 'y' : 'ies'} to the product default premium.`, premFixed)
    }
    fixable += premFixable
    check('premiums', 'Policy premiums', (zeroPrem ?? []).length - premFixed,
      (zeroPrem ?? []).length === 0 ? 'Every live policy carries a positive premium.'
        : apply ? `${premFixed} set to product defaults${(zeroPrem ?? []).length - premFixed > 0 ? `, ${(zeroPrem ?? []).length - premFixed} unresolved` : ''}.`
        : `Live policies billing $0: ${(zeroPrem ?? []).slice(0, 5).map(p => p.policy_number).join(', ')}${premFixable ? ` â€” the fixer can price ${premFixable} from product defaults` : ''}.`)

    // â”€â”€ 6. Client-posted health snapshot (optional) â”€â”€
    const snap = body.health as { totalOps?: number; sbSuccessPct?: number; localMode?: boolean } | undefined
    if (snap && typeof snap.totalOps === 'number') {
      check('db-health', 'Database operations (session)', snap.localMode ? 1 : 0,
        `${snap.totalOps} ops, ${snap.sbSuccessPct}% success${snap.localMode ? ' â€” currently serving CACHED data (offline mode)' : ' â€” Supabase connected'}.`)
    }

    // â”€â”€ The fix log â€” what the checker has repaired lately â”€â”€
    const { data: fixLog } = await admin.from('system_fixes')
      .select('kind, detail, records, applied_at')
      .order('applied_at', { ascending: false }).limit(10)

    // â”€â”€ Groq interprets the probe results â”€â”€
    const apiKey = process.env.GROQ_API_KEY
    const problems = checks.filter(c => c.status !== 'ok')
    if (!apiKey) {
      return res.status(200).json({
        ok: true, checkedAt: new Date().toISOString(), checks, fixed, fixable, fixLog: fixLog ?? [],
        ai: { simulated: true, summary: problems.length === 0 ? 'All checks pass.' : `${problems.length} area${problems.length === 1 ? '' : 's'} need attention â€” AI analysis not configured.` },
      })
    }

    const prompt = `You are the reliability engineer for a Zimbabwean micro-insurance platform (clients, policies, group schemes, agriculture cover, payments, SMS/email/WhatsApp notifications). Below are results from the system's deterministic health probes. Interpret them for an operations manager â€” plain English, actionable, no jargon.

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
        ok: true, checkedAt: new Date().toISOString(), checks, fixed, fixable, fixLog: fixLog ?? [],
        ai: { simulated: true, summary: `Checks ran but AI analysis failed (${groq.status}). ${problems.length} area${problems.length === 1 ? '' : 's'} flagged â€” see the list.` },
      })
    }
    const parsed = extractJson<{ summary?: string; findings?: { severity?: string; area?: string; problem?: string; recommendation?: string }[] }>(groq.content)
    return res.status(200).json({
      ok: true, checkedAt: new Date().toISOString(), checks, fixed, fixable, fixLog: fixLog ?? [],
      ai: {
        summary: parsed?.summary ?? 'Analysis returned no summary â€” see the check list.',
        findings: Array.isArray(parsed?.findings) ? parsed.findings.filter(f => f && typeof f.problem === 'string') : [],
      },
    })
  } catch (e) {
    return res.status(500).json({ error: `System check failed: ${e}` })
  }
}
