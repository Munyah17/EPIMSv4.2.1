import type { SupabaseClient } from '@supabase/supabase-js'
import { sendText } from './whatsapp.js'
import { initiatePaynowPayment } from '../paynowInitiate.js'
import { chargeEip, eipConfigured, normalizeMsisdn } from '../ecocashInstant.js'
import { promotePendingPolicy } from './data.js'
import { isZwNationalId } from '../zwFormats.js'

export { normalizeNationalId } from '../zwFormats.js'

/** Input validators and the shared payment tail — the pieces every
 *  flow ends in. Validation rules are the Frappe version's. */

export const isFullName = (s: string) => s.trim().length >= 3 && /^[A-Za-z\s\-']+$/.test(s.trim())
export const isNationalId = isZwNationalId
/** A dependant's "ID" may be a birth record or passport number, not a
 *  national ID — children have none. The portal accepts any non-empty
 *  reference ("ID / Birth Record No."); the bot applies the same
 *  leniency. The strict national-ID shape only binds policyholders. */
export const isDependantId = (s: string) => { const v = s.trim(); return v.length >= 4 && v.length <= 40 }
export const isEmail = (s: string) => /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(s.trim())
export const isEcocashPhone = (s: string) => {
  const digits = s.replace(/\D/g, '')
  const msisdn = digits.startsWith('00263') ? digits.slice(2)
    : digits.startsWith('2630') ? `263${digits.slice(4)}`
    : digits.startsWith('263') ? digits
    : digits.startsWith('0') ? `263${digits.slice(1)}`
    : digits
  return /^2637[78][0-9]{7}$/.test(msisdn)
}

/** DD-MM-YYYY (what the Frappe bot asked for) -> ISO date, or null. */
export function parseDob(s: string): string | null {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s.trim())
  if (!m) return null
  const [, dd, mm, yyyy] = m
  const d = new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? null : `${yyyy}-${mm}-${dd}`
}

/** Index pick (user types '2' for item 2). Returns null on a bad pick —
 *  caller re-asks. */
export function pickIndex(input: string, count: number): number | null {
  const n = Number(input.trim())
  if (!Number.isInteger(n) || n < 1 || n > count) return null
  return n - 1
}

/** Payment methods, normalised to the portal's vocabulary
 *  (PAYMENT_METHODS in src/types/index.ts). WhatsApp can only collect
 *  remotely, so the list compresses to the three real channels:
 *    0  EcoCash      -> direct PIN push to the payer's phone
 *    1  Paynow       -> checkout link (cards, InnBucks, ZimSwitch ride it)
 *    2  Office/cash  -> instructions; staff record the payment on-site
 *  PORTAL_METHOD_NAMES maps each index to the string the portal writes
 *  on policies.payment_method, so a bot-made policy reads identically
 *  in the IMS. */
export const PAYMENT_METHODS: Record<string, string[]> = {
  usd: ['EcoCash (USD)', 'Paynow (Visa/MasterCard, InnBucks, ZimSwitch)', 'Office payment (cash, bank transfer)'],
  zig: ['EcoCash (ZiG)', 'Paynow (Visa/MasterCard, InnBucks, ZimSwitch)', 'Office payment (cash, bank transfer)'],
}
export const PORTAL_METHOD_NAMES = ['EcoCash', 'Paynow', 'Cash']

export const methodMenu = (currencyKey: string) =>
  PAYMENT_METHODS[currencyKey].map((m, i) => `${i + 1}. ${m}`).join('\n')

/** Latest ZWG-per-USD rate on record; null = ZiG can't be charged. */
async function zwgRate(admin: SupabaseClient): Promise<number | null> {
  const { data } = await admin.from('exchange_rates')
    .select('rate').eq('currency', 'ZWG')
    .order('effective_date', { ascending: false }).limit(1).maybeSingle()
  const rate = Number(data?.rate)
  return Number.isFinite(rate) && rate > 0 ? rate : null
}

/**
 * The shared payment tail every flow ends in:
 *   method index 0  -> EcoCash Instant push to the payer's phone
 *   anything else   -> a Paynow checkout link
 *
 * `usdAmount` is the billed USD figure; ZiG converts through the rate
 * on record — the same rule the portal uses.
 */
export async function sendPaymentInstruction(opts: {
  admin: SupabaseClient
  phone: string                    // who we message on WhatsApp
  policyId: string
  reference: string                // paynow reference + tracking key
  usdAmount: number
  currency: 'USD' | 'ZiG'
  methodIndex: number
  ecocashNumber?: string
  origin: string
  description?: string
  email?: string
}): Promise<void> {
  const { admin, phone, policyId, reference, usdAmount, currency, ecocashNumber, origin, description, email } = opts
  let methodIndex = opts.methodIndex
  let resolvedPolicyId = policyId

  const officePayment = async () => {
    // If this is still a Paynow pending_policies row, move it into the
    // staff-visible pending queue before giving manual instructions.
    const promoted = await promotePendingPolicy(admin, resolvedPolicyId, 'Cash')
    if (promoted) resolvedPolicyId = promoted.id
    await sendText(phone,
      `Pay at any Motions office by cash or bank transfer.\n\n` +
      `Amount: USD ${usdAmount.toFixed(2)}\nReference: ${reference}\n\n` +
      `Quote the reference when you pay — cover starts once the payment is recorded.`)
  }

  if (methodIndex === 2) return officePayment()

  const canUseEcoCash = methodIndex === 0 && eipConfigured() && !!ecocashNumber
  if (methodIndex === 0 && !canUseEcoCash) {
    await sendText(phone, 'EcoCash is not available right now — opening the secure Paynow checkout instead.')
    methodIndex = 1
  }

  if (methodIndex === 0) {
    // Direct pushes are reconciled by staff, so the row must be a normal
    // pending policy rather than a Paynow checkout row.
    const promoted = await promotePendingPolicy(admin, resolvedPolicyId, 'EcoCash')
    if (promoted) resolvedPolicyId = promoted.id
    const amount = currency === 'ZiG'
      ? Math.round(usdAmount * ((await zwgRate(admin)) ?? 0) * 100) / 100
      : usdAmount
    if (!amount) {
      await sendText(phone, 'ZiG payments are unavailable until an exchange rate is set on the portal.')
      return officePayment()
    }
    const { httpStatus, result } = await chargeEip({
      phone: normalizeMsisdn(ecocashNumber!), amount, reference,
      description: (description ?? 'Insurance Premium').slice(0, 100),
    })
    const rejected = result.outcome === 'failed' || (httpStatus >= 400 && httpStatus < 500)
    if (rejected) {
      await sendText(phone, `EcoCash rejected the request: ${result.message ?? `HTTP ${httpStatus}`}`)
      return officePayment()
    }
    await sendText(phone, result.outcome === 'pending' || httpStatus >= 500
      ? `EcoCash did not confirm the request for ${currency} ${amount.toFixed(2)}. Do not retry yet — quote reference ${reference} if you need support, and we will verify before recording payment.`
      : `A payment request for ${currency} ${amount.toFixed(2)} has been pushed to ${ecocashNumber}.\nCheck the EcoCash PIN prompt on that phone to complete payment.`)
    return
  }

  const result = await initiatePaynowPayment({
    reference, usdAmount, policyId: resolvedPolicyId, origin, admin,
    currency: currency === 'ZiG' ? 'ZWG' : 'USD',
    description: description ?? 'Insurance Premium',
    email,
  })
  if (!result.ok || !result.redirectUrl) {
    await sendText(phone, `Could not open a checkout (${result.error ?? 'no link returned'}).`)
    return officePayment()
  }
  await sendText(phone,
    `Tap the link to pay ${result.currency === 'ZWG' ? 'ZiG' : 'USD'} ${(result.amount ?? usdAmount).toFixed(2)}:\n${result.redirectUrl}\n\nYour policy is activated once payment confirms.`)
}

export function datePlusOneYear(): { start: string; end: string } {
  const start = new Date().toISOString().slice(0, 10)
  const end = new Date(Date.now() + 365 * 864e5).toISOString().slice(0, 10)
  return { start, end }
}
