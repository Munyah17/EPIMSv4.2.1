/**
 * Corrects every Tobacco Field-to-Floor policy to the fixed season window
 * (15 Nov 2026 – 31 Aug 2027) and prints an endorsement ("alteration")
 * PDF per corrected policy into ./alteration-documents/.
 *
 *   node scripts/fix-tobacco-season-dates.mjs
 */
import { createClient } from '@supabase/supabase-js'
import { jsPDF } from 'jspdf'
import dotenv from 'dotenv'
import fs from 'node:fs'
import path from 'node:path'

dotenv.config({ path: '.env.local' })

const SEASON = { start: '2026-11-15', end: '2027-08-31' }
const OUT_DIR = path.resolve('alteration-documents')

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://ulglnabjwwdqnoutnvsl.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

function endorsementPdf(p, productName, clientName) {
  const doc = new jsPDF()
  const issued = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
  const fmt = iso => new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })

  doc.setFontSize(16)
  doc.text('Motions Microinsurance Company (Private) Limited', 105, 20, { align: 'center' })
  doc.setFontSize(13)
  doc.text('POLICY ENDORSEMENT — ALTERATION OF PERIOD OF INSURANCE', 105, 30, { align: 'center' })
  doc.setLineWidth(0.5)
  doc.line(20, 34, 190, 34)

  doc.setFontSize(11)
  let y = 46
  const row = (label, value) => { doc.setFont('helvetica', 'bold'); doc.text(label, 25, y); doc.setFont('helvetica', 'normal'); doc.text(String(value), 80, y); y += 8 }
  row('Policy Number:', p.policy_number)
  row('Policyholder:', clientName)
  row('Product:', productName)
  row('Endorsement Date:', issued)
  y += 4

  doc.setFont('helvetica', 'bold')
  doc.text(' alteration:', 25, y); y += 7
  doc.setFont('helvetica', 'normal')
  doc.text(`Previous Period of Insurance:  ${fmt(p.start_date)}  to  ${fmt(p.end_date)}`, 25, y); y += 7
  doc.text(`Amended Period of Insurance:   ${fmt(SEASON.start)}  to  ${fmt(SEASON.end)}`, 25, y); y += 12

  doc.setFontSize(10)
  const note = 'This endorsement corrects the period of insurance recorded on the above policy. ' +
    'Field to Floor tobacco cover runs with the tobacco selling season and not the date of registration. ' +
    'All other terms, conditions, sums insured and exclusions of the policy remain unchanged. ' +
    'This endorsement forms part of the policy and should be read together with the policy document.'
  doc.text(doc.splitTextToSize(note, 160), 25, y); y += 30

  doc.line(25, y, 90, y)
  doc.text('Authorised Signatory — Motions Microinsurance', 25, y + 6)
  return doc
}

const { data: products, error: pErr } = await supabase.from('products').select('id, name, category')
if (pErr) { console.error(pErr); process.exit(1) }
const tobacco = products.filter(p => p.category === 'agriculture' &&
  (p.name.toLowerCase().includes('tobacco') || p.name.toLowerCase().includes('field to floor')))
const productName = Object.fromEntries(products.map(p => [p.id, p.name]))
console.log('Tobacco products:', tobacco.map(p => p.name).join(', '))

const { data: policies, error } = await supabase
  .from('policies')
  .select('id, policy_number, product_id, start_date, end_date, clients(name)')
  .in('product_id', tobacco.map(p => p.id))
  .or(`start_date.neq.${SEASON.start},end_date.neq.${SEASON.end}`)
if (error) { console.error(error); process.exit(1) }
console.log(`${policies.length} policies to correct`)
if (!policies.length) process.exit(0)

fs.mkdirSync(OUT_DIR, { recursive: true })
let ok = 0, failed = 0
for (const p of policies) {
  const { error: uErr } = await supabase.from('policies').update({
    start_date: SEASON.start,
    end_date: SEASON.end,
    // Stop-order insurance: premium is deducted once from crop proceeds —
    // there is no next payment date.
    next_payment_date: null,
  }).eq('id', p.id)
  if (uErr) { failed++; console.error(`FAIL ${p.policy_number}: ${uErr.message}`); continue }
  try {
    endorsementPdf(p, productName[p.product_id] ?? 'Field to Floor', p.clients?.name ?? '')
      .save(path.join(OUT_DIR, `endorsement-${p.policy_number}.pdf`))
    ok++
  } catch (e) { console.error(`PDF FAIL ${p.policy_number}: ${e.message}`) }
}
console.log(`\nCorrected ${ok} policies, ${failed} update failures. Endorsements in ${OUT_DIR}`)
