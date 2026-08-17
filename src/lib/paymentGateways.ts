/**
 * Payment Gateways
 *
 * EcoCash  — Econet merchant payment API
 * Paynow   — Zimbabwe's hosted payment gateway (supports EcoCash, OneMoney, ZimSwitch)
 * Zipit    — ZimSwitch ZIPIT bank transfer (display-only; verified manually)
 *
 * Configure credentials in Billing & Reminders → Gateway Settings.
 * All API keys are stored in localStorage under 'tqfy_gateway_settings'.
 *
 * Live EcoCash/Paynow calls are routed through netlify/functions/gateway-proxy.ts
 * server-side, since both APIs reject direct browser calls via CORS.
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
  smsApiKey: '',
  smsUsername: 'sandbox',
  smsSenderId: 'TARIQIFY',
  smsSandbox: true,
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
  simulated?: boolean
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

// ── EcoCash ────────────────────────────────────────────────────────

export async function initiateEcoCash(req: PaymentRequest): Promise<PaymentResponse> {
  const cfg = getGatewaySettings()
  const ref = req.reference

  if (!cfg.ecocashMerchantCode || !cfg.ecocashMerchantPin) {
    // Simulation mode
    const txnId = `ECO${Date.now()}`
    logPayment({ id: txnId, policyId: req.policyId, policyNumber: req.policyNumber, gateway: 'ecocash', amount: req.amount, reference: ref, status: 'pending', transactionId: txnId, ts: new Date().toISOString() })
    return { success: true, transactionId: txnId, status: 'pending', message: `SIMULATION: EcoCash prompt sent to ${req.clientPhone}. Check your phone to approve.`, gateway: 'ecocash', simulated: true }
  }

  const body = {
    merchantCode: cfg.ecocashMerchantCode,
    merchantPin: cfg.ecocashMerchantPin,
    merchantPhoneNumber: cfg.ecocashMerchantPhone,
    clientPhoneNumber: req.clientPhone.replace(/\s/g, '').replace(/^\+263/, '0'),
    amount: req.amount.toFixed(2),
    clientReference: ref,
    transactionOperationType: 'billpayment',
    transactionInfo: `Insurance Premium: ${req.policyNumber}`,
  }

  try {
    const res = await proxyFetch(`${cfg.ecocashApiUrl}/transaction/initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json() as { status?: string; transactionId?: string; pollUrl?: string; message?: string }
    const success = data.status === 'Message' || res.ok
    const txnId = data.transactionId ?? data.pollUrl ?? `ECO${Date.now()}`

    logPayment({ id: txnId, policyId: req.policyId, policyNumber: req.policyNumber, gateway: 'ecocash', amount: req.amount, reference: ref, status: success ? 'pending' : 'failed', transactionId: String(txnId), ts: new Date().toISOString() })
    return { success, transactionId: String(txnId), pollUrl: data.pollUrl, status: success ? 'pending' : 'failed', message: success ? `Payment prompt sent to ${req.clientPhone}. Approve on your phone.` : (data.message ?? 'EcoCash request failed'), gateway: 'ecocash' }
  } catch (e) {
    return { success: false, status: 'failed', message: `EcoCash error: ${e}`, gateway: 'ecocash' }
  }
}

export async function pollEcoCash(pollUrl: string): Promise<{ status: 'pending' | 'success' | 'failed'; message: string }> {
  const cfg = getGatewaySettings()
  try {
    const res = await proxyFetch(`${cfg.ecocashApiUrl}/transaction/check?pollUrl=${encodeURIComponent(pollUrl)}`, { method: 'GET' })
    const data = await res.json() as { status?: string }
    const status: 'pending' | 'success' | 'failed' =
      data.status === 'Transaction Successful' ? 'success'
      : data.status === 'Transaction Failed' ? 'failed'
      : 'pending'
    return { status, message: data.status ?? 'Unknown' }
  } catch {
    return { status: 'pending', message: 'Polling error, retrying…' }
  }
}

// ── Paynow ─────────────────────────────────────────────────────────

function paynowHash(values: Record<string, string>, key: string): string {
  const str = Object.values(values).join('') + key
  return md5(str).toUpperCase()
}

export async function initiatePaynow(req: PaymentRequest, method: 'ecocash' | 'onemoney' | 'zipit' | 'card' = 'ecocash'): Promise<PaymentResponse> {
  const cfg = getGatewaySettings()
  const ref = req.reference

  if (!cfg.paynowIntegrationId || !cfg.paynowIntegrationKey) {
    const txnId = `PNW${Date.now()}`
    logPayment({ id: txnId, policyId: req.policyId, policyNumber: req.policyNumber, gateway: 'paynow', amount: req.amount, reference: ref, status: 'pending', transactionId: txnId, ts: new Date().toISOString() })
    return {
      success: true, transactionId: txnId, status: 'redirect',
      redirectUrl: `https://www.paynow.co.zw/payment/initiate/${cfg.paynowIntegrationId || 'DEMO'}/${encodeURIComponent(ref)}`,
      message: 'SIMULATION: Would redirect to Paynow. Configure Integration ID & Key to go live.',
      gateway: 'paynow', simulated: true,
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
    ...(method !== 'card' ? { phone: req.clientPhone.replace(/\s/g, ''), method } : {}),
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
