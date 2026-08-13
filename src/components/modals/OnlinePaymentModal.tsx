import { useState, useEffect, useRef } from 'react'
import type { Policy } from '../../types'
import {
  initiateEcoCash, initiatePaynow, getZipitDetails, pollEcoCash, pollPaynow,
} from '../../lib/paymentGateways'
import type { PaymentResponse } from '../../lib/paymentGateways'
import { db } from '../../lib/db'
import PhoneInput from '../ui/PhoneInput'

interface Props {
  policy: Policy
  onClose: () => void
  onSuccess: () => void
  showToast: (type: 'success' | 'error' | 'warning' | 'info', msg: string) => void
}

type PayStep = 'select' | 'confirm' | 'processing' | 'success' | 'failed'
type Method = 'ecocash' | 'paynow_eco' | 'paynow_onemoney' | 'paynow_card' | 'zipit'

const METHOD_LABELS: Record<Method, string> = {
  ecocash: 'EcoCash (Direct)',
  paynow_eco: 'Paynow → EcoCash',
  paynow_onemoney: 'Paynow → OneMoney',
  paynow_card: 'Paynow → Card',
  zipit: 'Zipit / Bank Transfer',
}

export default function OnlinePaymentModal({ policy, onClose, onSuccess, showToast }: Props) {
  const [step, setStep] = useState<PayStep>('select')
  const [method, setMethod] = useState<Method>('ecocash')
  const [phone, setPhone] = useState('')
  const [result, setResult] = useState<PaymentResponse | null>(null)
  const [zipitDetails, setZipitDetails] = useState<ReturnType<typeof getZipitDetails> | null>(null)
  const [pollStatus, setPollStatus] = useState<string>('Awaiting payment…')
  const [hadCaution, setHadCaution] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const [client, setClient] = useState<{ phone?: string; email?: string } | null>(null)
  const [category, setCategory] = useState('')
  const [periods, setPeriods] = useState(1)
  useEffect(() => {
    db.clients.list().then(({ data }) => {
      setClient(data?.find(c => c.id === policy.clientId) ?? null)
    })
    db.products.list().then(({ data }) => {
      setCategory(data?.find(p => p.id === policy.productId)?.category ?? '')
    })
  }, [policy.clientId, policy.productId])
  const isAgriculture = category === 'agriculture'
  const ref = `${policy.policyNumber}${Date.now().toString(36).toUpperCase()}`
  const totalAmount = policy.premium * periods

  const req = {
    policyId: policy.id,
    policyNumber: policy.policyNumber,
    clientName: policy.clientName,
    clientPhone: phone || client?.phone || '',
    clientEmail: client?.email || '',
    amount: totalAmount,
    reference: ref,
  }

  function stopPoll() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }

  useEffect(() => () => stopPoll(), [])

  function startPoll(res: PaymentResponse) {
    if (!res.pollUrl) return
    const url = res.pollUrl
    const fn = res.gateway === 'ecocash' ? pollEcoCash : pollPaynow
    pollRef.current = setInterval(async () => {
      const { status, message } = await fn(url)
      setPollStatus(message)
      if (status === 'success') { stopPoll(); handleConfirmed() }
      if (status === 'failed') { stopPoll(); setStep('failed') }
    }, 4000)
  }

  async function handleConfirmed() {
    // Record payment in system
    await db.payments.create({
      reference: ref,
      policyId: policy.id,
      policyNumber: policy.policyNumber,
      clientName: policy.clientName,
      amount: totalAmount,
      method: method === 'zipit' ? 'Zipit' : method.startsWith('paynow') ? 'Paynow' : 'EcoCash',
      status: 'completed',
      date: new Date().toISOString().split('T')[0],
    })
    // Clear any caution flag
    const { data: existing } = await db.cautionFlags.get(policy.id)
    if (existing && !existing.cleared) {
      setHadCaution(true)
      await db.cautionFlags.clear(policy.id)
    }
    setStep('success')
    onSuccess()
  }

  async function handlePay() {
    if (!phone && method !== 'zipit') { showToast('warning', 'Please enter the client phone number.'); return }
    setStep('processing')

    let res: PaymentResponse

    if (method === 'ecocash') {
      res = await initiateEcoCash(req)
    } else if (method.startsWith('paynow')) {
      const pm = method === 'paynow_eco' ? 'ecocash' : method === 'paynow_onemoney' ? 'onemoney' : 'card'
      res = await initiatePaynow(req, pm as 'ecocash' | 'onemoney' | 'zipit' | 'card')
    } else {
      const z = getZipitDetails(req)
      setZipitDetails(z)
      setResult(z)
      setStep('confirm')
      return
    }

    setResult(res)

    if (!res.success) { setStep('failed'); return }

    if (res.status === 'redirect' && res.redirectUrl) {
      // Open Paynow in new tab
      window.open(res.redirectUrl, '_blank')
      setStep('confirm')
      if (res.pollUrl) startPoll(res)
      return
    }

    if (res.status === 'pending') {
      setStep('confirm')
      if (res.pollUrl) startPoll(res)
      return
    }

    if (res.simulated) {
      setStep('confirm')
    }
  }

  function handleManualConfirm() {
    stopPoll()
    handleConfirmed()
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 500 }}>
        <div className="modal-header">
          <h3>Pay Online — {policy.policyNumber}</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          {/* ── SELECT METHOD ── */}
          {step === 'select' && (
            <>
              <div style={{ background: 'var(--surface)', borderRadius: 9, padding: '12px 14px', marginBottom: 16, fontSize: 13 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span>{policy.clientName}</span>
                  <strong>${totalAmount.toFixed(2)}</strong>
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>{policy.productName} · {policy.policyNumber}</div>
              </div>

              <div className="form-group" style={{ marginBottom: 14 }}>
                <label>Number of {isAgriculture ? 'Years' : 'Months'} to Pay</label>
                <select className="form-control" value={periods} onChange={e => setPeriods(Number(e.target.value))}>
                  {Array.from({ length: 12 }, (_, i) => i + 1).map(n => (
                    <option key={n} value={n}>{n} {isAgriculture ? (n === 1 ? 'year' : 'years') : (n === 1 ? 'month' : 'months')} — ${(policy.premium * n).toFixed(2)}</option>
                  ))}
                </select>
              </div>

              <div className="form-group" style={{ marginBottom: 14 }}>
                <label>Payment Method</label>
                <div className="pay-method-grid">
                  {(Object.keys(METHOD_LABELS) as Method[]).map(m => (
                    <label key={m} className={`pay-method-card${method === m ? ' active' : ''}`}>
                      <input type="radio" name="method" checked={method === m} onChange={() => setMethod(m)} style={{ display: 'none' }} />
                      <span className="pay-method-icon">
                        {m === 'ecocash' ? '💚' : m.startsWith('paynow') ? '🟠' : '🏦'}
                      </span>
                      <span className="pay-method-label">{METHOD_LABELS[m]}</span>
                    </label>
                  ))}
                </div>
              </div>

              {method !== 'zipit' && (
                <div className="form-group">
                  <label>Client Phone Number</label>
                  <PhoneInput value={phone} onChange={setPhone} placeholder={client?.phone} />
                </div>
              )}
            </>
          )}

          {/* ── PROCESSING ── */}
          {step === 'processing' && (
            <div style={{ textAlign: 'center', padding: '24px 0' }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
              <p>Initiating payment via {METHOD_LABELS[method]}…</p>
            </div>
          )}

          {/* ── CONFIRM / POLL ── */}
          {step === 'confirm' && result && (
            <>
              <div className={`info-banner ${result.success ? 'info-banner-success' : 'info-banner-warning'}`} style={{ borderRadius: 8, padding: '10px 13px', marginBottom: 14, fontSize: 12 }}>
                {result.message}
              </div>

              {result.simulated && (
                <div className="info-banner info-banner-info" style={{ borderRadius: 8, padding: '10px 13px', marginBottom: 14, fontSize: 12 }}>
                  Running in simulation mode. Configure API keys in Billing &amp; Reminders → Gateway Settings for live payments.
                </div>
              )}

              {/* Zipit bank details */}
              {method === 'zipit' && zipitDetails?.bankDetails && (
                <div className="zipit-details">
                  <div className="sh-info-row"><span>Bank</span><strong>{zipitDetails.bankDetails.bankName}</strong></div>
                  <div className="sh-info-row"><span>Account Name</span><strong>{zipitDetails.bankDetails.accountName}</strong></div>
                  <div className="sh-info-row"><span>Account Number</span><strong className="mono">{zipitDetails.bankDetails.accountNumber}</strong></div>
                  <div className="sh-info-row"><span>Branch Code</span><strong>{zipitDetails.bankDetails.branchCode}</strong></div>
                  <div className="sh-info-row"><span>Reference</span><strong className="mono">{zipitDetails.bankDetails.reference}</strong></div>
                  <div className="sh-info-row"><span>Amount</span><strong>${zipitDetails.bankDetails.amount.toFixed(2)}</strong></div>
                </div>
              )}

              {/* Poll status */}
              {result.pollUrl && (
                <div style={{ textAlign: 'center', padding: '12px 0', fontSize: 12, color: 'var(--muted)' }}>
                  <div style={{ marginBottom: 4 }}>🔄 {pollStatus}</div>
                  <div>Checking every 4 seconds…</div>
                </div>
              )}
            </>
          )}

          {/* ── SUCCESS ── */}
          {step === 'success' && (
            <div style={{ textAlign: 'center', padding: '24px 0' }}>
              <div style={{ fontSize: 42, marginBottom: 12 }}>✅</div>
              <h4 style={{ marginBottom: 8 }}>Payment Confirmed</h4>
              <p style={{ color: 'var(--muted)', fontSize: 13 }}>${totalAmount.toFixed(2)} received for {policy.policyNumber}.</p>
              {hadCaution && <p style={{ color: 'var(--success)', marginTop: 8, fontSize: 12 }}>✓ Caution flag cleared.</p>}
            </div>
          )}

          {/* ── FAILED ── */}
          {step === 'failed' && (
            <div style={{ textAlign: 'center', padding: '24px 0' }}>
              <div style={{ fontSize: 42, marginBottom: 12 }}>❌</div>
              <h4 style={{ marginBottom: 8 }}>Payment Failed</h4>
              <p style={{ color: 'var(--muted)', fontSize: 13 }}>{result?.message ?? 'Payment could not be processed.'}</p>
            </div>
          )}
        </div>

        <div className="modal-footer">
          {step === 'select' && (
            <>
              <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" onClick={handlePay}>Continue →</button>
            </>
          )}
          {step === 'confirm' && (
            <>
              <button className="btn btn-ghost" onClick={() => { stopPoll(); onClose() }}>Close</button>
              {(method === 'zipit' || result?.simulated) && (
                <button className="btn btn-success" onClick={handleManualConfirm}>
                  ✓ Confirm Payment Received
                </button>
              )}
            </>
          )}
          {step === 'success' && (
            <button className="btn btn-primary btn-full" onClick={onClose}>Done</button>
          )}
          {step === 'failed' && (
            <>
              <button className="btn btn-ghost" onClick={onClose}>Close</button>
              <button className="btn btn-primary" onClick={() => setStep('select')}>Try Again</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
