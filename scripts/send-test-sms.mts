// One-off SMS test through the REAL pipeline:
//   policyRegisteredSms() (the same builder the app calls) -> generated
//   text -> /api/gateway-proxy action:'sms' -> Afrosoft.
// A throwaway auth user is created purely to satisfy requireSession, then
// deleted. No policy, client, or notification_log record is written —
// gateway-proxy only relays.
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { policyRegisteredSms } from '../src/lib/smsText'

// ── env (.env.local) ────────────────────────────────────────────────
const env: Record<string, string> = {}
for (const f of ['../.env.local', '../.env']) {
  for (const l of readFileSync(new URL(f, import.meta.url), 'utf8').split('\n')) {
    const t = l.trim()
    if (!t || t.startsWith('#') || !t.includes('=')) continue
    env[t.slice(0, t.indexOf('='))] = t.slice(t.indexOf('=') + 1)
  }
}
const SUPABASE_URL = env.VITE_SUPABASE_URL as string
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY as string
const ANON_KEY = (env.VITE_SUPABASE_ANON_KEY ?? env.VITE_SUPABASE_KEY) as string
const PORTAL = env.PORTAL_URL ?? 'https://portal.motions.co.zw'
if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
  throw new Error('Missing SUPABASE url/service/anon key in .env.local')
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

// ── the text the system actually generates ──────────────────────────
const message = policyRegisteredSms({
  clientName: 'Demo User',
  policyNumber: 'TOB0514',
  productName: 'Field To Floor Standard',
  productCategory: 'agriculture',
  coverAmount: 2000,
  premium: 105,
  paymentMethod: 'Stop Order',
  clientPhone: '0773909307',
})
console.log('TEXT:', message)

// ── throwaway active user → real session token ──────────────────────
const email = `sms-test-${Date.now()}@motions.local`
const password = `T${Date.now()}${Math.random().toString(36).slice(2)}x!`
const { data: created, error: createErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
if (createErr || !created.user) throw new Error(`createUser: ${createErr?.message}`)
const uid = created.user.id
try {
  await admin.from('profiles').upsert({ id: uid, email, active: true })

  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  const { data: sess, error: signInErr } = await anon.auth.signInWithPassword({ email, password })
  if (signInErr || !sess.session) throw new Error(`signIn: ${signInErr?.message}`)

  // ── send — same endpoint the app uses ──────────────────────────────
  const res = await fetch(`${PORTAL}/api/gateway-proxy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sess.session.access_token}` },
    body: JSON.stringify({ action: 'sms', mobiles: '263773909307,263780086175', message }),
  })
  console.log('HTTP', res.status, JSON.stringify(await res.json()))
} finally {
  await admin.from('profiles').delete().eq('id', uid)
  const { error } = await admin.auth.admin.deleteUser(uid)
  if (error) console.error('cleanup: user delete failed —', error.message)
}
