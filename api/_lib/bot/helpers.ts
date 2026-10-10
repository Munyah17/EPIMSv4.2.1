import type { SupabaseClient } from '@supabase/supabase-js'
import { sendText } from './whatsapp.js'
import { initiatePaynowPayment } from '../paynowInitiate.js'
import { chargeEip, eipConfigured, normalizeMsisdn } from '../ecocashInstant.js'

/** Input validators and the shared payment tail — the pieces every
 *  flow ends in. Validation rules are the Frappe version's. */

export const isFullName = (s: string) => s.trim().length >= 3 && /^[A-Za-z\s\-']+$/.test(s.trim())
export const isNationalId = (s: string) => /^[A-Za-z0-9]{6,20}$/.test(s.trim())
export const isEmail = (s: string) => /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(s.trim())
export const isEcocashPhone = (s: string) => /^2637[0-9]{8}$/.test(s.trim()) || /^07[17][0-9]{6}$/.test(s.trim())

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

/** Payment methods — verbatim from the Frappe constants.py. Index 0 is
 *  always EcoCash (the direct-push rail); everything else goes through
 *  Paynow, which covers cards, Innbucks and ZimSwitch itself. */
export const PAYMENT_METHODS: Record<string, string[]> = {
  usd: ['Ecocash - USD', 'Innbucks - USD', 'VISA/MasterCard - USD', "O'mari - USD", 'ZimSwitch - USD', 'PayGo - USD', 'SSB (Civil Servants) - USD'],
  zig: ['Ecocash - ZiG', 'ZimSwitch - ZiG', 'PayGo - ZiG', 'SSB (Civil Servants) - ZiG'],
}

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
}): Promise<void> {
  const { admin, phone, policyId, reference, usdAmount, currency, methodIndex, ecocashNumber, origin, description } = opts
  const isEcoCash = methodIndex === 0

  if (isEcoCash) {
    if (!eipConfigured() || !ecocashNumber) {
      await sendText(phone, 'EcoCash payments are not available right now — please choose another payment method.')
      return
    }
    const amount = currency === 'ZiG'
      ? Math.round(usdAmount * ((await zwgRate(admin)) ?? 0) * 100) / 100
      : usdAmount
    if (!amount) {
      await sendText(phone, 'ZiG payments are unavailable until an exchange rate is set on the portal.')
      return
    }
    const { httpStatus, result, lookupUrl } = await chargeEip({
      phone: normalizeMsisdn(ecocashNumber), amount, reference,
      description: (description ?? 'Insurance Premium').slice(0, 100),
    })
    const rejected = result.outcome === 'failed' || (httpStatus >= 400 && httpStatus < 500)
    if (rejected) {
      await sendText(phone, `EcoCash rejected the request: ${result.message ?? `HTTP ${httpStatus}`}`)
      return
    }
    await sendText(phone,
      `A payment request for ${currency} ${amount.toFixed(2)} has been pushed to ${ecocashNumber}.\n` +
      `Check the EcoCash PIN prompt on that phone to complete payment.${lookupUrl ? '' : ''}`)
    return
  }

  const result = await initiatePaynowPayment({
    reference, usdAmount, policyId, origin, admin,
    currency: currency === 'ZiG' ? 'ZWG' : 'USD',
    description: description ?? 'Insurance Premium',
  })
  if (!result.ok || !result.redirectUrl) {
    await sendText(phone, `Could not open a checkout: ${result.error ?? 'no link returned'}`)
    return
  }
  await sendText(phone,
    `Tap the link to pay ${result.currency === 'ZWG' ? 'ZiG' : 'USD'} ${result.amount?.toFixed(2)}:\n${result.redirectUrl}\n\nYour policy is activated once payment confirms.`)
}

export function datePlusOneYear(): { start: string; end: string } {
  const start = new Date().toISOString().slice(0, 10)
  const end = new Date(Date.now() + 365 * 864e5).toISOString().slice(0, 10)
  return { start, end }
}
