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

const { data: product } = await admin.from('products').select('id, name').eq('active', true).limit(1).maybeSingle()
if (!product) { console.log('no product found'); process.exit(1) }
console.log('using product:', product.name)

// Exactly what create-checkout.ts inserts for a manual gateway.
const { data: session, error } = await admin.from('checkout_sessions').insert({
  reference: 'PROBE-MANUAL-GATEWAY-DELETE-ME',
  gateway: 'bank_transfer',
  amount: 1,
  product_id: product.id,
  dependants: [],
  selections: [{ productId: product.id, dependants: [] }],
  client_name: 'Probe',
  client_email: 'probe@probe.test',
  client_phone: '+263771234567',
  client_national_id: '000000000A00',
  client_dob: null,
  client_address: null,
  client_occupation: null,
  preferred_insurer: 'Motions Microinsurance',
  transaction_reference: 'PROBE1234',
  status: 'pending_verification',
}).select('id, reference').single()

if (error) {
  console.log('INSERT FAILED:', error.message)
  process.exit(0)
}
console.log('INSERT OK:', session)

const { error: delErr } = await admin.from('checkout_sessions').delete().eq('id', session.id)
console.log(delErr ? `cleanup FAILED: ${delErr.message}` : 'cleanup OK — probe row deleted')
