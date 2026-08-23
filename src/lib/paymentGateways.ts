/**
 * Payment Gateways
 *
 * EcoCash Instant — Econet's own direct merchant rail (EIP). A prompt is
 *                   pushed straight to the payer's handset and EcoCash
 *                   debits them. Standalone: nothing to do with Paynow.
 * Paynow          — an aggregator whose hosted page resells several rails
 *                   (EcoCash, OneMoney, InnBucks, ZIPIT, card). Its EcoCash
 *                   option is NOT EcoCash Instant — different credentials,
 *                   different references, different statuses, and a
 *                   transaction on one is invisible to the other.
 * Zipit           — ZimSwitch ZIPIT bank transfer (display-only; verified
 *                   manually by staff against the bank statement).
 *
 * EcoCash Instant credentials live on the server (EIP_* env vars, see
 * api/ecocash-instant.ts) and never touch the browser. Paynow's integration
 * id/key are still configured in Billing & Reminders → Gateway Settings and
 * relayed through api/gateway-proxy.ts, which exists because Paynow rejects
 * direct browser calls via CORS.
 */

import md5 from 'md5'
import type { GatewaySettings } from '../types'

/** Relays a request through the Netlify gateway-proxy function to avoid browser CORS blocks. */
async function proxyFetch(
  url: string,
  init: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string } = {},
): Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown> }> {
  const res = await fetch('/api/gateway-proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, method: init.method ?? 'POST', headers: init.headers, body: init.body }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as { error?: string })?.error ?? `Gateway proxy error (HTTP ${res.status})`)
  }
  const { status, ok, body } = await res.json() as { status: number; ok: boolean; body: string }
  return { ok, status, text: async () => body, json: async () => JSON.parse(body) }
}

const GW_KEY = 'tqfy_gateway_settings'

export const DEFAULT_GW_SETTINGS: GatewaySettings = {
  ecocashMerchantCode: '',
  ecocashMerchantPin: '',
  ecocashMerchantPhone: '',
  ecocashApiUrl: 'https://api.ecocash.co.zw/merchant',
  paynowIntegrationId: '',
  paynowIntegrationKey: '',
  paynowReturnUrl: window.location.origin + '/payment/return',
  paynowResultUrl: window.location.origin + '/payment/result',
  zipitBankName: 'CABS',
  zipitAccountName: 'Tariqify Insurance',
  zipitAccountNumber: '1001234567',
  zipitBranchCode: '003',
  smtpHost: 'smtp.gmail.com',
  smtpPort: 587,
  smtpUser: '',
  smtpPass: '',
  smtpFrom: 'noreply@tariqify.com',
  smtpFromName: 'Tariqify IMS',
}

export function getGatewaySettings(): GatewaySettings {
  try {
    const raw = localStorage.getItem(GW_KEY)
    if (raw) return { ...DEFAULT_GW_SETTINGS, ...JSON.parse(raw) }
  } catch { /**/ }
  return { ...DEFAULT_GW_SETTINGS }
}

export function saveGatewaySettings(s: GatewaySettings) {
  try { localStorage.setItem(GW_KEY, JSON.stringify(s)) } catch { /**/ }
}

// ── Common types ────────────────────────────────────────────────────

export interface PaymentRequest {
  policyId: string
  policyNumber: string
  clientName: string
  clientPhone: string
  clientEmail: string
  amount: number
  reference: string
}

export interface PaymentResponse {
  success: boolean
  transactionId?: string
  status: 'pending' | 'success' | 'failed' | 'redirect'
  redirectUrl?: string
  pollUrl?: string
  message: string
  gateway: 'ecocash' | 'paynow' | 'zipit'
  /** No longer set by any rail. An unconfigured gateway is reported as a
   *  refusal, not as a pretend payment that staff could then mark received. */
  simulated?: never
}

// ── Payment log ────────────────────────────────────────────────────

const PAYMENT_LOG_KEY = 'tqfy_online_payment_log'

export interface OnlinePaymentLog {
  id: string
  policyId: string
  policyNumber: string
  gateway: 'ecocash' | 'paynow' | 'zipit'
  amount: number
  reference: string
  status: 'pending' | 'success' | 'failed'
  transactionId?: string
  ts: string
}

export function getPaymentLog(): OnlinePaymentLog[] {
  try { return JSON.parse(localStorage.getItem(PAYMENT_LOG_KEY) ?? '[]') } catch { return [] }
}

function logPayment(entry: OnlinePaymentLog) {
  try {
    const log = getPaymentLog()
    log.unshift(entry)
    localStorage.setItem(PAYMENT_LOG_KEY, JSON.stringify(log.slice(0, 300)))
  } catch { /**/ }
}

// ── EcoCash Instant (direct rail — not Paynow) ─────────────────────

interface EipChargeReply {
  outcome?: 'success' | 'failed' | 'pending'
  lookupUrl?: string
  transactionId?: string
  message?: string
  sandbox?: boolean
  error?: string
}

/**
 * Pushes an EcoCash prompt straight to the payer's handset.
 *
 * With EIP credentials unset on the server this returns a clearly-labelled
 * simulation instead — never something a user could mistake for a real
 * payment, and never a "failed" verdict for a rail that is merely switched
 * off.
 */
export async function initiateEcoCash(req: PaymentRequest): Promise<PaymentResponse> {
  const ref = req.reference

  let reply: EipChargeReply
  let httpStatus: number
  try {
    const res = await fetch('/api/ecocash-instant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'charge',
        phone: req.clientPhone,
        amount: req.amount,
        reference: ref,
        description: `Insurance Premium: ${req.policyNumber}`,
      }),
    })
    httpStatus = res.status
    reply = await res.json().catch(() => ({})) as EipChargeReply
  } catch (e) {
    return { success: false, status: 'failed', message: `Could not reach the EcoCash service: ${e}`, gateway: 'ecocash' }
  }

  // 503 means the rail isn't configured on this deployment. That is a
  // refusal, not a payment. It used to return success with simulated:true,
  // which put a "pending" entry in the payment log and offered staff a
  // button to mark it received -- money recorded for a prompt that was
  // never sent. If EcoCash cannot be reached, nothing happened.
  if (httpStatus === 503) {
    return {
      success: false, status: 'failed', gateway: 'ecocash',
      message: 'EcoCash Instant is not configured on the server, so no prompt was sent. Set the EIP credentials to collect through this rail, or take the payment another way and record it on the Payments page.',
    }
  }

  if (reply.outcome === 'failed' || reply.error) {
    logPayment({ id: `ECO${Date.now()}`, policyId: req.policyId, policyNumber: req.policyNumber, gateway: 'ecocash', amount: req.amount, reference: ref, status: 'failed', ts: new Date().toISOString() })
    return { success: false, status: 'failed', message: reply.message ?? reply.error ?? 'EcoCash declined the request.', gateway: 'ecocash' }
  }

  const txnId = reply.transactionId ?? ref
  logPayment({ id: txnId, policyId: req.policyId, policyNumber: req.policyNumber, gateway: 'ecocash', amount: req.amount, reference: ref, status: 'pending', transactionId: txnId, ts: new Date().toISOString() })
  return {
    success: true,
    transactionId: txnId,
    pollUrl: reply.lookupUrl,
    status: 'pending',
    message: `Payment prompt sent to ${req.clientPhone}. Approve it on the phone${reply.sandbox ? ' (sandbox credentials: only numbers whitelisted with EcoCash will receive it)' : ''}.`,
    gateway: 'ecocash',
  }
}

/**
 * Asks EcoCash what became of one transaction.
 *
 * Anything short of a definite answer comes back pending. A payment that
 * has not been confirmed is not a payment that failed, and the difference
 * decides whether a policy gets marked paid.
 */
export async function pollEcoCash(lookupUrl: string): Promise<{ status: 'pending' | 'success' | 'failed'; message: string }> {
  try {
    const res = await fetch('/api/ecocash-instant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'lookup', lookupUrl }),
    })
    const data = await res.json().catch(() => ({})) as { outcome?: 'success' | 'failed' | 'pending'; message?: string }
    if (data.outcome === 'success') return { status: 'success', message: data.message ?? 'Payment confirmed by EcoCash' }
    if (data.outcome === 'failed') return { status: 'failed', message: data.message ?? 'EcoCash declined this transaction' }
    return { status: 'pending', message: data.message ?? 'Waiting for the payer to approve…' }
  } catch {
    return { status: 'pending', message: 'Could not reach EcoCash; still waiting…' }
  }
}

// ── Paynow ─────────────────────────────────────────────────────────

function paynowHash(values: Record<string, string>, key: string): string {
  const str = Object.values(values).join('') + key
  return md5(str).toUpperCase()
}

/**
 * Starts a Paynow transaction.
 *
 * With no `method`, this is a plain HOSTED checkout: Paynow's own page
 * presents its full rail picker (EcoCash, OneMoney, InnBucks, Omari, ZIPIT,
 * card) and we never pre-select one on the payer's behalf. Passing a method
 * opts into Paynow's express flow for that specific rail instead.
 */
export async function initiatePaynow(req: PaymentRequest, method?: 'ecocash' | 'onemoney' | 'zipit' | 'card'): Promise<PaymentResponse> {
  const cfg = getGatewaySettings()
  const ref = req.reference

  // Unconfigured is a refusal, not a payment. This used to hand back a
  // fabricated DEMO redirect and log a pending transaction, so a checkout
  // that could not possibly collect anything looked like one in progress.
  if (!cfg.paynowIntegrationId || !cfg.paynowIntegrationKey) {
    return {
      success: false, status: 'failed', gateway: 'paynow',
      message: 'Paynow is not configured: add the Integration ID and Key in Billing & Reminders → Gateway Settings. No payment was started.',
    }
  }

  const fields: Record<string, string> = {
    id: cfg.paynowIntegrationId,
    reference: ref,
    amount: req.amount.toFixed(2),
    additionalinfo: `Insurance Premium: ${req.policyNumber}`,
    returnurl: cfg.paynowReturnUrl,
    resulturl: cfg.paynowResultUrl,
    status: 'Message',
    email: req.clientEmail,
    // Express flow only: a hosted checkout must not carry phone/method, or
    // Paynow skips its own picker.
    ...(method && method !== 'card' ? { phone: req.clientPhone.replace(/\s/g, ''), method } : {}),
  }
  fields.hash = paynowHash(fields, cfg.paynowIntegrationKey)

  try {
    const res = await proxyFetch('https://www.paynow.co.zw/interface/initiatetransaction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    })
    const text = await res.text()
    const parsed = Object.fromEntries(new URLSearchParams(text))

    if (parsed.status === 'Ok') {
      logPayment({ id: parsed.reference ?? ref, policyId: req.policyId, policyNumber: req.policyNumber, gateway: 'paynow', amount: req.amount, reference: ref, status: 'pending', transactionId: parsed.reference, ts: new Date().toISOString() })
      return { success: true, transactionId: parsed.reference, redirectUrl: parsed.browserurl, pollUrl: parsed.pollurl, status: 'redirect', message: 'Redirecting to Paynow…', gateway: 'paynow' }
    }
    return { success: false, status: 'failed', message: parsed.error ?? 'Paynow initiation failed', gateway: 'paynow' }
  } catch (e) {
    return { success: false, status: 'failed', message: `Paynow request failed: ${e}`, gateway: 'paynow' }
  }
}

export async function pollPaynow(pollUrl: string): Promise<{ status: 'pending' | 'success' | 'failed'; message: string }> {
  try {
    const res = await proxyFetch(pollUrl, { method: 'GET' })
    const parsed = Object.fromEntries(new URLSearchParams(await res.text()))
    const s = (parsed.status ?? '').toLowerCase()
    if (s === 'paid') return { status: 'success', message: 'Payment successful' }
    if (s.includes('fail') || s.includes('cancel')) return { status: 'failed', message: parsed.status }
    return { status: 'pending', message: parsed.status ?? 'Awaiting payment' }
  } catch {
    return { status: 'pending', message: 'Polling…' }
  }
}

// ── Zipit (ZimSwitch bank transfer) ────────────────────────────────

export function getZipitDetails(req: PaymentRequest): PaymentResponse & { bankDetails: typeof _details } {
  const cfg = getGatewaySettings()
  const _details = {
    bankName: cfg.zipitBankName,
    accountName: cfg.zipitAccountName,
    accountNumber: cfg.zipitAccountNumber,
    branchCode: cfg.zipitBranchCode,
    reference: req.reference,
    amount: req.amount,
  }
  logPayment({ id: `ZIPIT${Date.now()}`, policyId: req.policyId, policyNumber: req.policyNumber, gateway: 'zipit', amount: req.amount, reference: req.reference, status: 'pending', ts: new Date().toISOString() })
  return {
    success: true,
    status: 'pending',
    message: 'Transfer bank details below. Payment will be confirmed by staff within 1 business day.',
    gateway: 'zipit',
    bankDetails: _details,
  }
}
