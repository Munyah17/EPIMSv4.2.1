import { Paynow } from 'paynow'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The transaction-creation half of api/paynow.ts, lifted out so anything
 * server-side — the payment route, the WhatsApp bot, a future cron — can
 * start a real payable Paynow transaction without going over HTTP and
 * pretending to be a signed-in browser.
 *
 * Behaviour is unchanged: currency check, ZWG rate conversion, the SDK
 * owns the wire format, and the paynow_transactions tracking row is
 * written before the caller gets the redirect URL.
 */

export type PaynowCurrency = 'USD' | 'ZWG'

/** Paynow settles in the currency of the integration that created the
 *  transaction, so each currency has its own integration pair. Exported
 *  for api/paynow.ts's 'poll' action, which still needs the raw key. */
export function integrationFor(currency: PaynowCurrency): { id?: string; key?: string } {
  return currency === 'ZWG'
    ? { id: process.env.PAYNOW_ZWG_INTEGRATION_ID, key: process.env.PAYNOW_ZWG_INTEGRATION_KEY }
    : { id: process.env.PAYNOW_INTEGRATION_ID, key: process.env.PAYNOW_INTEGRATION_KEY }
}

/** Whether a currency is currently accepted. Absent settings mean accepted,
 *  matching the app's own default. */
async function currencyIsActive(currency: PaynowCurrency, admin: SupabaseClient): Promise<boolean> {
  const { data } = await admin.from('app_settings').select('value').eq('key', 'currency_settings').maybeSingle()
  const active = (data?.value as { active?: Record<string, boolean> } | null)?.active
  return active?.[currency] !== false
}

async function rateFor(currency: PaynowCurrency, admin: SupabaseClient): Promise<number | null> {
  if (currency !== 'ZWG') return 1
  const { data } = await admin.from('exchange_rates')
    .select('rate').eq('currency', 'ZWG')
    .order('effective_date', { ascending: false }).limit(1).maybeSingle()
  const rate = Number(data?.rate)
  return Number.isFinite(rate) && rate > 0 ? rate : null
}

export interface PaynowInitiateResult {
  ok: boolean
  error?: string
  redirectUrl?: string
  pollUrl?: string
  currency?: PaynowCurrency
  /** What Paynow will actually charge, in `currency`. */
  amount?: number
}

export async function initiatePaynowPayment(opts: {
  reference: string
  /** Always USD — the billed amount. Converted when charging ZWG. */
  usdAmount: number
  currency: PaynowCurrency
  description?: string
  email?: string
  /** Required — paynow-webhook reconciles the tracking row by policy. */
  policyId: string
  /** Origin used for result/return urls, e.g. https://portal.motions.co.zw */
  origin: string
  admin: SupabaseClient
}): Promise<PaynowInitiateResult> {
  const { id: integrationId, key: integrationKey } = integrationFor(opts.currency)
  if (!integrationId || !integrationKey) {
    return { ok: false, error: `Paynow is not configured on the server for ${opts.currency}.` }
  }

  if (opts.currency !== 'USD' && !(await currencyIsActive(opts.currency, opts.admin))) {
    return { ok: false, error: 'Temporary Unavailable Due To Maintenance' }
  }

  const rate = await rateFor(opts.currency, opts.admin)
  if (rate === null) {
    return { ok: false, error: 'ZiG payments are unavailable until an exchange rate is set.' }
  }
  const amount = Math.round(opts.usdAmount * rate * 100) / 100
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: 'Could not determine the amount to charge.' }
  }

  const paynow = new Paynow(integrationId, integrationKey)
  paynow.resultUrl = `${opts.origin}/api/paynow-webhook`
  paynow.returnUrl = `${opts.origin}/payment/return`

  // While the integration is in TEST MODE Paynow rejects the whole
  // transaction if authemail is anything but the merchant's own address
  // — so the buyer's email only goes out once PAYNOW_LIVE=true.
  const paynowIsLive = process.env.PAYNOW_LIVE === 'true'
  const payment = (paynowIsLive && opts.email)
    ? paynow.createPayment(opts.reference, opts.email)
    : paynow.createPayment(opts.reference)
  payment.add(opts.description || 'Insurance Premium', amount)

  const response = await paynow.send(payment)
  if (!response || !response.success) {
    return { ok: false, error: String(response?.error ?? 'Paynow declined the request.') }
  }

  // Tracked before the caller is answered — see api/paynow.ts for why the
  // row exists and why a failure here is logged, not thrown.
  const { error: trackError } = await opts.admin.from('paynow_transactions').insert({
    reference: opts.reference, policy_id: opts.policyId, expected_amount: amount,
    status: 'pending', currency: opts.currency, usd_amount: opts.usdAmount, rate,
  })
  if (trackError) {
    console.error('paynow_transactions insert failed', opts.reference, trackError.message)
  }

  return {
    ok: true,
    redirectUrl: String(response.redirectUrl ?? ''),
    pollUrl: String(response.pollUrl ?? ''),
    currency: opts.currency,
    amount,
  }
}
