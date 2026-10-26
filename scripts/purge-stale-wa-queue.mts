import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

// One-off: every notification_log row still 'queued' on the whatsapp
// channel carries the PRE-standardisation wording frozen inside its
// wa.me link. Left in place, any staff member can tap one tomorrow and
// send the old format. Mark them all 'skipped' so the outbox empties —
// the rows stay in the delivery log for audit.
const env: Record<string, string> = {}
for (const f of ['../.env.local', '../.env']) {
  for (const l of readFileSync(new URL(f, import.meta.url), 'utf8').split('\n')) {
    const t = l.trim()
    if (!t || t.startsWith('#') || !t.includes('=')) continue
    env[t.slice(0, t.indexOf('='))] = t.slice(t.indexOf('=') + 1)
  }
}
const admin = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

const { count: before } = await admin.from('notification_log')
  .select('*', { count: 'exact', head: true })
  .eq('channel', 'whatsapp').eq('status', 'queued')
console.log('queued whatsapp rows before:', before)

const { data: rows, error } = await admin.from('notification_log')
  .update({ status: 'skipped' })
  .eq('channel', 'whatsapp').eq('status', 'queued')
  .select('id')
if (error) { console.error('purge failed:', error.message); process.exit(1) }
console.log('purged:', rows?.length ?? 0)

const { count: after } = await admin.from('notification_log')
  .select('*', { count: 'exact', head: true })
  .eq('channel', 'whatsapp').eq('status', 'queued')
console.log('queued whatsapp rows after:', after)
