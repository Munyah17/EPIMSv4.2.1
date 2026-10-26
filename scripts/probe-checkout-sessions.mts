import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env: Record<string, string> = {}
for (const f of ['../.env.local', '../.env']) {
  try {
    for (const l of readFileSync(new URL(f, import.meta.url), 'utf8').split('\n')) {
      const t = l.trim()
      if (!t || t.startsWith('#') || !t.includes('=')) continue
      env[t.slice(0, t.indexOf('='))] = t.slice(t.indexOf('=') + 1)
    }
  } catch { /* file may not exist */ }
}
const admin = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

// 1) Do the manual-gateway columns exist at all?
const colProbe = await admin.from('checkout_sessions')
  .select('id, pop_path, pop_filename, transaction_reference')
  .limit(1)
console.log('columns probe:', colProbe.error ? `ERROR ${colProbe.error.message}` : 'OK — pop_path/pop_filename/transaction_reference exist')

// 2) What do recent sessions look like — especially manual ones?
const { data: sessions, error } = await admin.from('checkout_sessions')
  .select('reference, gateway, status, failure_reason, amount, transaction_reference, pop_path, created_at')
  .order('created_at', { ascending: false })
  .limit(25)
if (error) console.log('sessions read ERROR:', error.message)
else {
  for (const s of sessions ?? []) {
    console.log(`${s.created_at}  ${s.reference}  gw=${s.gateway}  status=${s.status}  amt=${s.amount}  txnRef=${s.transaction_reference ?? '—'}  pop=${s.pop_path ? 'yes' : 'no'}  fail=${s.failure_reason ?? '—'}`)
  }
}

// 3) How many manual-gateway rows ever got in?
const { count } = await admin.from('checkout_sessions')
  .select('id', { count: 'exact', head: true })
  .in('gateway', ['bank_transfer', 'ecocash_merchant'])
console.log(`\nmanual-gateway rows total: ${count}`)
