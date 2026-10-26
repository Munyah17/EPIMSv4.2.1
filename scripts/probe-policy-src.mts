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

for (const num of ['TOB0576', 'TOB0578', 'TOB0579']) {
  const { data: pol } = await admin.from('policies')
    .select('id, policy_number, client_id, product_id, source, status, created_at, payment_method, premium, cover_amount, agent_id')
    .eq('policy_number', num).maybeSingle()
  let agent: unknown = null
  if (pol?.agent_id) {
    const { data } = await admin.from('profiles').select('id, name, email, role').eq('id', pol.agent_id).maybeSingle()
    agent = data
  }
  const { data: c } = await admin.from('clients').select('name, phone, created_at').eq('id', pol?.client_id ?? '').maybeSingle()
  const { data: logs } = await admin.from('notification_log').select('event, channel, recipient, status, detail, created_at').eq('ref', num).order('created_at')
  console.log(`\n=== ${num} ===`)
  console.log('policy:', JSON.stringify({ source: pol?.source, status: pol?.status, created_at: pol?.created_at, premium: pol?.premium, cover: pol?.cover_amount, method: pol?.payment_method }))
  console.log('agent :', JSON.stringify(agent))
  console.log('client:', JSON.stringify(c))
  console.log('logs  :', JSON.stringify(logs))
}

// All profiles (staff) for the agent mapping
const { data: profiles } = await admin.from('profiles').select('id, name, email, role, active')
console.log('\nstaff:', JSON.stringify((profiles ?? []).map(p => ({ id: p.id.slice(0, 8), name: p.name, email: p.email, role: p.role, active: p.active }))))
