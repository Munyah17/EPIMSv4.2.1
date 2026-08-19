import { useState, useEffect, useRef } from 'react'
import type { Policy } from '../../types'
import {
  initiateEcoCash, initiatePaynow, getZipitDetails, pollEcoCash, pollPaynow,
} from '../../lib/paymentGateways'
import type { PaymentResponse } from '../../lib/paymentGateways'
import { db } from '../../lib/db'
import { policyBillablePremium, billableHeadCount } from '../../lib/premium'
import { recordActivity } from '../../lib/activityLog'
import { useAuth } from '../../contexts/AuthContext'
import PhoneInput from '../ui/PhoneInput'

interface Props {
  policy: Policy
  onClose: () => void
  onSuccess: () => void
  showToast: (type: 'success' | 'error' | 'warning' | 'info', msg: string) => void
}

type PayStep = 'select' | 'confirm' | 'processing' | 'success' | 'failed'

/**
 * Three rails, because there are only three.
 *
 * EcoCash Instant is Econet's own direct rail: a prompt goes straight to the
 * payer's handset. Paynow is an aggregator whose hosted page offers its full
 * picker — EcoCash, OneMoney, InnBucks, Omari, ZIPIT, card — so listing
 * those individually here duplicated Paynow's own checkout on our side.
 * Bank transfer is settled off-system and confirmed by staff.
 */
type Method = 'ecocash' | 'paynow' | 'zipit'

const METHODS: { id: Method; label: string; blurb: string; badge: string; alt: string }[] = [
  {
    id: 'paynow',
    label: 'Paynow',
    blurb: 'EcoCash, OneMoney, InnBucks, Omari, ZIPIT or card on Paynow’s secure page.',
    badge: '/badges/paynow.svg',
    alt: 'Paynow',
  },
  {
    id: 'ecocash',
    label: 'EcoCash Instant',
    blurb: 'Sends the payment prompt straight to the client’s phone.',
    badge: '/badges/ecocash.png',
    alt: 'EcoCash',
  },
  {
    id: 'zipit',
    label: 'Bank Transfer',
    blurb: 'Client transfers to our account; staff confirm it once it clears.',
    badge: '/badges/zimswitch.png',
    alt: 'ZimSwitch',
  },
]

const METHOD_LABELS: Record<Method, string> = {
  ecocash: 'EcoCash Instant',
  paynow: 'Paynow',
  zipit: 'Bank Transfer',
}

export default function OnlinePaymentModal({ policy, onClose, onSuccess, showToast }: Props) {
  const { user } = useAuth()
  const [step, setStep] = useState<PayStep>('select')
  const [method, setMethod] = useState<Method>('paynow')
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
  // Premiums are per head: the amount collected covers the policyholder and
  // every dependant on the policy, not the policyholder alone.
  const perPeriod = policyBillablePremium(policy, category)
  const heads = billableHeadCount(policy, category)
  const totalAmount = perPeriod * periods

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

  /**
   * Writes the payment down.
   *
   * `validatedManually` separates the two very different things that reach
   * this function: a gateway telling us it collected the money, and a staff
   * member asserting the money arrived some other way (a bank transfer that
   * cleared, or a simulated rail). Both produce a completed payment — the
   * money is equally real — but only the second is a human judgement, so it
   * is attributed to whoever made it.
   */
  async function handleConfirmed(validatedManually = false) {
    await db.payments.create({
      reference: ref,
      policyId: policy.id,
      policyNumber: policy.policyNumber,
      clientName: policy.clientName,
      amount: totalAmount,
      method: method === 'zipit' ? 'Zipit' : method === 'paynow' ? 'Paynow' : 'EcoCash',
      status: 'completed',
      date: new Date().toISOString().split('T')[0],
    })

    if (user) {
      void recordActivity({
        action: validatedManually ? 'payment.validated' : 'payment.recorded',
        actor: { id: user.id, name: user.name, role: user.role },
        entityType: 'payment',
        entityId: policy.id,
        entityLabel: policy.policyNumber,
        detail: validatedManually
          ? `Manually validated $${totalAmount.toFixed(2)} via ${METHOD_LABELS[method]} for ${policy.clientName}${result?.simulated ? ' (gateway in simulation mode)' : ''}. Not confirmed by a gateway.`
          : `$${totalAmount.toFixed(2)} confirmed by ${METHOD_LABELS[method]} for ${policy.clientName}. Reference ${ref}.`,
        severity: validatedManually ? 'warning' : 'info',
      })
    }

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
    // Only EcoCash Instant needs a number up front — it pushes the prompt to
    // that handset. Paynow collects whatever it needs on its own page.
    if (!phone && method === 'ecocash') { showToast('warning', "Enter the client's phone number — the EcoCash prompt is sent to it."); return }
    setStep('processing')

    let res: PaymentResponse

    if (method === 'ecocash') {
      res = await initiateEcoCash(req)
    } else if (method === 'paynow') {
      // Plain hosted checkout: Paynow's page presents its own rail picker,
      // so we don't pre-select one on its behalf.
      res = await initiatePaynow(req)
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
    void handleConfirmed(true)
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 500 }}>
        <div className="modal-header">
          <h3>Pay Online: {policy.policyNumber}</h3>
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
                {heads > 1 && (
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>
                    Covers {heads} people (policyholder + {heads - 1} dependant{heads === 2 ? '' : 's'})
                  </div>
                )}
              </div>

              <div className="form-group" style={{ marginBottom: 14 }}>
                <label>Number of {isAgriculture ? 'Years' : 'Months'} to Pay</label>
                <select className="form-control" value={periods} onChange={e => setPeriods(Number(e.target.value))}>
                  {Array.from({ length: 12 }, (_, i) => i + 1).map(n => (
                    <option key={n} value={n}>{n} {isAgriculture ? (n === 1 ? 'year' : 'years') : (n === 1 ? 'month' : 'months')} (${(perPeriod * n).toFixed(2)})</option>
                  ))}
                </select>
              </div>

              <div className="form-group" style={{ marginBottom: 14 }}>
                <label>Payment Method</label>
                <div className="pay-method-banners">
                  {METHODS.map(m => (
                    <label key={m.id} className={`pay-method-banner${method === m.id ? ' active' : ''}`}>
                      <input type="radio" name="method" checked={method === m.id} onChange={() => setMethod(m.id)} style={{ display: 'none' }} />
                      <img src={m.badge} alt={m.alt} className="pay-method-banner-badge" />
                      <span className="pay-method-banner-text">
                        <span className="pay-method-banner-label">{m.label}</span>
                        <span className="pay-method-banner-blurb">{m.blurb}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              {method === 'ecocash' && (
                <div className="form-group">
                  <label>Client Phone Number</label>
                  <PhoneInput value={phone} onChange={setPhone} placeholder={client?.phone} />
                  <span style={{ fontSize: 11, color: 'var(--muted)' }}>The EcoCash prompt is sent to this number.</span>
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

              {(method === 'zipit' || result.simulated) && (
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 10 }}>
                  Validating manually records this as received on your authority — use it once the money is actually
                  in hand (transfer cleared, cash counted, or an EcoCash send-money transfer verified). It is logged
                  against your name.
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
              {/* Only ever offered where no gateway is going to answer: a
                  bank transfer settles off-system, and a simulated rail
                  never collected anything. A live EcoCash Instant or Paynow
                  transaction is confirmed by the gateway or not at all —
                  staff cannot declare it paid from here. */}
              {(method === 'zipit' || result?.simulated) && (
                <button className="btn btn-success" onClick={handleManualConfirm}>
                  ✓ Validate Payment Manually
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
