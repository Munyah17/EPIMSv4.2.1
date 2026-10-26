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

// Every sms/whatsapp log row from today, with the message text extracted.
// WhatsApp rows carry the full text inside the wa.me link; sms failures
// carry the gateway description.
const { data } = await admin.from('notification_log')
  .select('event, channel, recipient, ref, status, detail, created_at')
  .gte('created_at', '2026-10-26T00:00:00Z')
  .in('channel', ['sms', 'whatsapp'])
  .order('created_at')

const cat = (iso: string) => new Date(new Date(iso).getTime() + 2 * 3600_000).toISOString().slice(11, 19)

console.log(`sms/whatsapp rows today: ${(data ?? []).length}`)
for (const r of data ?? []) {
  const d = r.detail ?? ''
  const m = d.match(/text=([^&\s]+)/)
  const text = m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : d.slice(0, 160)
  console.log(`\n[${cat(r.created_at)} CAT] ${r.channel} -> ${r.recipient} | ${r.status} | ref=${r.ref ?? '-'} | event=${r.event}`)
  console.log(`  TEXT: ${text}`)
}
