import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env: Record<string, string> = {}
for (const f of ['../.env.local', '../.env']) {
  for (const l of readFileSync(new URL(f, import.meta.url), 'utf8').split('\n')) {
    const t = l.trim()
    if (!t || t.startsWith('#') || !t.includes('=')) continue
    env[t.slice(0, t.indexOf('='))] = t.slice(t.indexOf('=') + 1)
  }
}
const admin = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

// All clients with NO policy — anti-join via !inner like the dashboard
const all: { id: string; name: string; phone: string | null; national_id: string | null; created_at: string; captured_by: string | null; agent_id: string | null }[] = []
let from = 0
for (;;) {
  const { data } = await admin.from('clients')
    .select('id, name, phone, national_id, created_at, captured_by, agent_id, policies!inner(id)')
    .is('policies.id', null)
    .order('created_at', { ascending: false })
    .range(from, from + 999)
  if (!data || data.length === 0) break
  all.push(...(data as typeof all))
  if (data.length < 1000) break
  from += 1000
}
console.log(`total no-policy clients: ${all.length}`)
const staff = all.filter(c => c.captured_by)
console.log(`staff-captured among them: ${staff.length}`)

// per-day distribution, last 10 days
const byDay = new Map<string, { total: number; staff: number }>()
for (const c of all) {
  const d = c.created_at.slice(0, 10)
  const e = byDay.get(d) ?? { total: 0, staff: 0 }
  e.total++; if (c.captured_by) e.staff++
  byDay.set(d, e)
}
for (const [d, e] of [...byDay.entries()].sort().slice(-14)) console.log(`  ${d}: ${e.total} no-policy (${e.staff} staff-captured)`)

console.log('\n40 most recent uncovered:')
for (const c of all.slice(0, 40)) {
  console.log(`  ${c.created_at}  ${c.name.padEnd(28)}  id=${c.national_id ?? '—'}  phone=${c.phone ?? '—'}  captured_by=${c.captured_by ? 'YES' : '—'} agent=${c.agent_id ? 'YES' : '—'}`)
}

// Twins: same national_id or phone on a DIFFERENT client row that has policies
let twins = 0
for (const c of all.filter(c => c.captured_by).slice(0, 60)) {
  const ors = [c.national_id ? `national_id.eq.${c.national_id}` : '', c.phone ? `phone.eq.${c.phone}` : ''].filter(Boolean).join(',')
  if (!ors) continue
  const { data: t } = await admin.from('clients').select('id, name, created_at, policies(count)').or(ors).neq('id', c.id)
  for (const x of t ?? []) {
    const pc = (x.policies as { count: number }[])?.[0]?.count ?? 0
    if (pc > 0) { twins++; console.log(`  TWIN-COVERED: ${c.name} created ${c.created_at.slice(0, 16)} — matches ${x.name} (${pc} policies, created ${x.created_at.slice(0, 16)})`) }
    else twins += 0
  }
}
console.log(`\ntwins with cover found among first 60 staff-captured: ${twins}`)
