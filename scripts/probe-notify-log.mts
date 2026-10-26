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

// Everything logged today (UTC) — the 3 policies registered 09:11–09:22.
const { data: today, error } = await admin.from('notification_log')
  .select('event, channel, recipient, ref, status, detail, created_at')
  .gte('created_at', '2026-10-26T00:00:00Z')
  .order('created_at', { ascending: false })
  .limit(60)
console.log('rows today:', today?.length ?? 0, error?.message ?? '')
for (const r of today ?? []) console.log(JSON.stringify(r))

// Any rows ever mentioning the three client numbers.
for (const digits of ['784704279', '779134593', '778394589']) {
  const { data } = await admin.from('notification_log')
    .select('event, channel, recipient, ref, status, created_at')
    .ilike('recipient', `%${digits}%`).limit(10)
  console.log(`\nrecipient ~${digits}:`, JSON.stringify(data))
}

// Total table size + latest rows regardless of date, to confirm the
// table is being written at all.
const { count } = await admin.from('notification_log').select('*', { count: 'exact', head: true })
console.log('\ntotal notification_log rows:', count)
const { data: latest } = await admin.from('notification_log')
  .select('event, channel, recipient, ref, status, created_at')
  .order('created_at', { ascending: false }).limit(10)
console.log('latest:', JSON.stringify(latest, null, 1))

// The saved Settings -> SMS Recipients list: which numbers are ticked
// for 'registration'? An empty bucket means office alerts go to nobody
// and no send is ever attempted (so nothing is logged either).
const { data: settings } = await admin.from('app_settings').select('key, value').eq('key', 'notif_settings').maybeSingle()
console.log('\nnotif_settings:', JSON.stringify((settings?.value as { smsRecipients?: unknown[] } | null)?.smsRecipients ?? settings?.value ?? null, null, 1))

// SMS-channel rows today — the question that started this: did ANY text
// reach the server's log?
const { data: smsRows } = await admin.from('notification_log')
  .select('event, channel, recipient, ref, status, created_at')
  .gte('created_at', '2026-10-26T00:00:00Z').eq('channel', 'sms').order('created_at')
console.log('\nsms rows today:', (smsRows ?? []).length)
for (const r of smsRows ?? []) console.log(JSON.stringify(r))
