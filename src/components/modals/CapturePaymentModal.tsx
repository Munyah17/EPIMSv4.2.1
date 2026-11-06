import { useState, useEffect, useMemo } from 'react'
import type { Policy, PaymentMethod, Product } from '../../types'
import { MANUAL_PAYMENT_METHODS } from '../../types'
import { db } from '../../lib/db'
import { uploadDocument } from '../../lib/storage'
import { serverReachable } from '../../lib/notify'
import { generateTransactionId } from '../../lib/transactionId'
import { policyBillablePremium, billableHeadCount } from '../../lib/premium'
import { premiumPeriodLabel } from '../../lib/productUtils'
import { arrearsSummary } from '../../lib/policyLifecycle'
import { settlement, defaultCharge, completedPays, allocatePayment } from '../../lib/paymentAllocation'
import { formatDate, toIsoDate } from '../../lib/dateUtils'
import { recordActivity } from '../../lib/activityLog'
import { notifyPaymentReceived } from '../../lib/signupNotifications'
import { useAuth } from '../../contexts/AuthContext'
import DateInput from '../ui/DateInput'

interface Props {
  /** Open straight onto one policy… */
  policy?: Policy
  /** …or let the Super Admin pick from a client's policies. */
  policies?: Policy[]
  clientName?: string
  onClose: () => void
  /** Fires with the updated policy once the payment and the policy write both succeeded. */
  onCaptured: (policy: Policy) => void
  showToast: (type: 'success' | 'error' | 'warning' | 'info', message: string) => void
}

const LIVE = new Set(['active', 'waiting_period', 'lapsed', 'defaulted', 'pending'])

/**
 * Super Admin only. Records money a client paid directly (EcoCash
 * send-money, bank transfer, cash) that the system never saw, and moves the
 * policy's paid-up-to date so it stops showing arrears. The new date is
 * worked out from the amount against the premium but can be overridden —
 * the person holding the slip knows exactly which months it settled.
 */
export default function CapturePaymentModal({ policy: initialPolicy, policies, clientName, onClose, onCaptured, showToast }: Props) {
  const { user } = useAuth()
  const candidates = useMemo(
    () => (initialPolicy ? [initialPolicy] : (policies ?? []).filter(p => LIVE.has(p.status))),
    [initialPolicy, policies],
  )
  const [policyId, setPolicyId] = useState(initialPolicy?.id ?? (candidates.length === 1 ? candidates[0].id : ''))
  const policy = candidates.find(p => p.id === policyId) ?? null
  const [products, setProducts] = useState<Product[]>([])
  const [completed, setCompleted] = useState<{ amount: number; date: string }[]>([])
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<PaymentMethod>('EcoCash')
  const [date, setDate] = useState(toIsoDate(new Date()))
  const [externalRef, setExternalRef] = useState('')
  const [paidUntil, setPaidUntil] = useState('')
  const [paidUntilTouched, setPaidUntilTouched] = useState(false)
  const [popFile, setPopFile] = useState<File | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [attempted, setAttempted] = useState(false)

  useEffect(() => { db.products.list().then(({ data }) => setProducts(data ?? [])) }, [])
  useEffect(() => {
    if (!policy) { setCompleted([]); return }
    db.payments.list().then(({ data }) => {
      setCompleted(completedPays((data ?? []).filter(p => p.policyId === policy.id)))
    })
  }, [policy?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const category = policy ? products.find(p => p.id === policy.productId)?.category ?? '' : ''
  const cycleMonths = category === 'agriculture' ? 12 : 1
  const perPeriod = policy ? policyBillablePremium(policy, category) : 0
  const arrears = policy ? arrearsSummary(policy.nextPaymentDate, perPeriod, cycleMonths) : { periods: 0, amount: 0 }
  const due = policy ? settlement(perPeriod, cycleMonths, policy.nextPaymentDate, completed) : null

  // Default the amount to what's owed (dependant top-up, arrears, or one
  // period when up to date) the moment a policy is chosen.
  useEffect(() => {
    if (!policy || !perPeriod || !due) return
    setAmount(String(defaultCharge(due, 1)))
    setPaidUntilTouched(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [policyId, perPeriod, due?.dueNow, due?.credit, due?.isUpgrade])

  const amountValue = Number(amount)
  const amountInvalid = !amount.trim() || !Number.isFinite(amountValue) || amountValue <= 0
  // allocatePayment fills a mid-cycle dependant top-up first. floor(amount /
  // perPeriod) would treat a $6 capture against a $4 upgrade as a full extra
  // month and hide the leftover dollar.
  const alloc = policy && !amountInvalid
    ? allocatePayment(amountValue, perPeriod, cycleMonths, policy.nextPaymentDate, completed)
    : null

  useEffect(() => {
    if (!paidUntilTouched && alloc) setPaidUntil(alloc.nextPaymentDate)
  }, [alloc?.nextPaymentDate, paidUntilTouched]) // eslint-disable-line react-hooks/exhaustive-deps

  const partPayment = alloc !== null && alloc.periodsAdvanced === 0
  const stillInArrears = !!paidUntil && arrearsSummary(paidUntil, perPeriod, cycleMonths).periods > 0

  const blocked = !policy ? 'Choose the policy this payment is for.'
    : amountInvalid ? 'Enter the amount received (greater than zero).'
      : !date ? 'Enter the date the money was received.'
        : !paidUntil ? 'Set the date cover is paid up to.'
          : null

  const handleSave = async () => {
    setAttempted(true)
    setError('')
    if (blocked || !policy) return
    if (stillInArrears && !window.confirm(`Paid up to ${formatDate(paidUntil)} still leaves ${policy.policyNumber} in arrears. Record it anyway?`)) return

    setBusy('Checking connection…')
    if (!(await serverReachable())) {
      setBusy(null)
      setError('The server is unreachable right now — nothing was recorded. Try again in a moment.')
      return
    }

    let popUrl: string | undefined
    if (popFile) {
      setBusy('Uploading proof of payment…')
      const { data: doc, error: upErr } = await uploadDocument('policies', policy.clientId, popFile)
      if (upErr || !doc) {
        setBusy(null)
        setError(`Could not upload the proof of payment — ${upErr ?? 'try again.'}`)
        return
      }
      popUrl = doc.path
    }

    setBusy('Recording…')
    const result = await db.capturePayment({
      policyId: policy.id,
      amount: amountValue,
      method,
      date,
      paidUntil,
      externalRef: externalRef || undefined,
      popUrl,
      transactionId: generateTransactionId({ clientName: policy.clientName, method }),
    })
    setBusy(null)

    if (result.payment && user) {
      void recordActivity({
        action: 'payment.validated',
        actor: { id: user.id, name: user.name, role: user.role },
        entityType: 'payment',
        entityId: result.payment.id,
        entityLabel: result.payment.reference,
        detail: `Captured a direct payment: $${amountValue.toFixed(2)} via ${method} for ${policy.clientName} (${policy.policyNumber}), received ${formatDate(date)}${externalRef ? `, ref ${externalRef}` : ''}. Paid up to ${formatDate(paidUntil)}${result.policy ? '' : ' — POLICY UPDATE FAILED'}.`,
        severity: 'warning',
      })
    }
    if (result.error || !result.policy) {
      setError(result.error ?? 'Could not record the payment.')
      return
    }

    // Receipt SMS, same as any other confirmed payment. Best-effort.
    void (async () => {
      try {
        const client = (await db.clients.get(policy.clientId)).data ?? undefined
        void notifyPaymentReceived(result.payment!, client, category, policy.productId)
      } catch { /* best-effort */ }
    })()

    showToast('success', `${policy.policyNumber} — $${amountValue.toFixed(2)} captured. Paid up to ${formatDate(paidUntil)}.`)
    onCaptured(result.policy)
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 520 }}>
        <div className="modal-header">
          <h3>Capture Payment{clientName ? ` — ${clientName}` : ''}</h3>
          <button className="modal-close" onClick={onClose} disabled={!!busy}>✕</button>
        </div>
        <div className="modal-body">
          {!initialPolicy && (
            <div className="form-group">
              <label>Policy *</label>
              <select className="form-control" value={policyId} onChange={e => setPolicyId(e.target.value)}>
                <option value="">{candidates.length ? 'Select policy…' : 'This client has no live policies'}</option>
                {candidates.map(p => (
                  <option key={p.id} value={p.id}>{p.policyNumber} · {p.productName} · {p.status.replace('_', ' ')}</option>
                ))}
              </select>
            </div>
          )}

          {policy && (
            <div className={`info-banner ${arrears.periods > 0 ? 'info-banner-warning' : 'info-banner-info'}`} style={{ marginBottom: '1rem' }}>
              <strong>{policy.policyNumber}</strong> · {policy.clientName} · {policy.productName}<br />
              Premium: ${perPeriod.toFixed(2)}{premiumPeriodLabel(category, policy.productName, policy.paymentMethod)}
              {billableHeadCount(policy, category) > 1 && <span style={{ fontSize: 11 }}> ({billableHeadCount(policy, category)} people)</span>}
              <br />
              Currently paid up to: <strong>{formatDate(policy.nextPaymentDate)}</strong>
              {arrears.periods > 0
                ? <> — <strong style={{ color: 'var(--danger)' }}>in arrears {arrears.periods} {cycleMonths === 12 ? 'season' : 'month'}{arrears.periods === 1 ? '' : 's'} (${arrears.amount.toFixed(2)})</strong></>
                : <> — up to date</>}
              {due?.isUpgrade && (
                <><br />Holder already paid this {cycleMonths === 12 ? 'year' : 'month'}. Collect <strong>${due.dueNow.toFixed(2)}</strong> for the newly added dependants — not the full ${perPeriod.toFixed(2)}.</>
              )}
              {due && due.credit > 0 && (
                <><br />Overpayment on file: <strong>${due.credit.toFixed(2)}</strong> credit toward the next premium.</>
              )}
            </div>
          )}

          <div className="form-row">
            <div className="form-group">
              <label>Amount Received ($) *</label>
              <input type="number" className="form-control" min={0} step="0.01" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" />
            </div>
            <div className="form-group">
              <label>Paid Via *</label>
              <select className="form-control" value={method} onChange={e => setMethod(e.target.value as PaymentMethod)}>
                {MANUAL_PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Date Received *</label>
              <DateInput value={date} onChange={setDate} />
            </div>
            <div className="form-group">
              <label>Transaction / Slip Ref</label>
              <input type="text" className="form-control" value={externalRef} onChange={e => setExternalRef(e.target.value)} placeholder="e.g. EcoCash MP251104.1234" />
            </div>
          </div>

          <div className="form-group">
            <label>Cover Paid Up To *</label>
            <DateInput value={paidUntil} onChange={v => { setPaidUntil(v); setPaidUntilTouched(true) }} />
            <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>
              {alloc
                ? <>${amountValue.toFixed(2)} covers <strong>{alloc.periodsAdvanced}</strong> {cycleMonths === 12 ? 'season' : 'month'}{alloc.periodsAdvanced === 1 ? '' : 's'} from {formatDate(policy?.nextPaymentDate)} → suggested <strong>{formatDate(alloc.nextPaymentDate)}</strong>{alloc.credit > 0 ? <> · leftover <strong>${alloc.credit.toFixed(2)}</strong> is overpayment credit</> : null}. Override if the slip says otherwise.</>
                : 'Worked out from the amount — or set it yourself.'}
              {paidUntilTouched && alloc && paidUntil !== alloc.nextPaymentDate && (
                <> <button type="button" className="btn btn-ghost btn-sm" style={{ padding: '0 6px', fontSize: 11 }} onClick={() => { setPaidUntilTouched(false); setPaidUntil(alloc.nextPaymentDate) }}>Use suggested</button></>
              )}
            </p>
            {partPayment && due?.isUpgrade && (
              <p style={{ fontSize: 12, margin: '4px 0 0' }}>
                This is the dependant top-up for a month already paid — the paid-up-to date stays put{alloc && alloc.credit > 0 ? `, with $${alloc.credit.toFixed(2)} credit toward the next premium` : ''}.
              </p>
            )}
            {partPayment && !due?.isUpgrade && (
              <p style={{ fontSize: 12, color: 'var(--danger)', margin: '4px 0 0' }}>
                Less than one full {cycleMonths === 12 ? 'season' : 'month'} — the payment is recorded but the date won't move unless you set it.
              </p>
            )}
            {stillInArrears && !partPayment && (
              <p style={{ fontSize: 12, color: 'var(--danger)', margin: '4px 0 0' }}>This date still leaves the policy in arrears.</p>
            )}
          </div>

          <div className="form-group">
            <label>Proof of Payment (optional)</label>
            <input type="file" accept="*/*" className="form-control" onChange={e => setPopFile(e.target.files?.[0] ?? null)} />
            {popFile && <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{popFile.name} ({(popFile.size / 1024).toFixed(0)} KB)</p>}
          </div>

          {blocked && attempted && <p style={{ fontSize: 12, color: 'var(--danger)', margin: '10px 0 0' }}>{blocked}</p>}
          {error && <p style={{ fontSize: 12, color: 'var(--danger)', margin: '10px 0 0' }}>{error}</p>}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose} disabled={!!busy}>Cancel</button>
          <button className="btn btn-primary" onClick={() => void handleSave()} disabled={!!busy}>
            {busy ?? 'Capture Payment'}
          </button>
        </div>
      </div>
    </div>
  )
}
