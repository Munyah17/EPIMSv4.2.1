import { useState, useEffect } from 'react'
import type { Payment, PaymentMethod, PaymentStatus, SplitPayment, Policy } from '../../types'
import ValidationSummary, { MissingField, invalidClass, fieldId } from '../ui/ValidationSummary'
import { generateTransactionId } from '../../lib/transactionId'
import { MANUAL_PAYMENT_METHODS } from '../../types'
import { db } from '../../lib/db'
import { uploadDocument } from '../../lib/storage'
import { serverReachable } from '../../lib/notify'
import { premiumPeriodLabel } from '../../lib/productUtils'
import { policyBillablePremium, billableHeadCount } from '../../lib/premium'
import DateInput from '../ui/DateInput'
import { toIsoDate } from '../../lib/dateUtils'

interface Props {
  /** When omitted, the modal lets the user pick a policy from a dropdown. */
  policyId?: string
  /** When set, edits this existing payment instead of recording a new one —
   *  the policy it's tied to is locked (a payment doesn't get reassigned to
   *  a different policy after the fact). */
  payment?: Payment
  onClose: () => void
  onSave: (payment: Payment) => void
}

const METHODS = MANUAL_PAYMENT_METHODS
const STATUSES: PaymentStatus[] = ['completed', 'pending', 'failed', 'reversed']

export default function RecordPaymentModal({ policyId: initialPolicyId, payment: editing, onClose, onSave }: Props) {
  const [allPolicies, setAllPolicies] = useState<Policy[] | null>(null)
  const [policyId, setPolicyId] = useState(editing?.policyId ?? initialPolicyId ?? '')
  const [policy, setPolicy] = useState<Policy | null>(null)
  const [policyCategory, setPolicyCategory] = useState('')
  const [amount, setAmount] = useState(editing ? String(editing.amount) : '')
  const [method, setMethod] = useState<PaymentMethod>(editing?.method ?? 'OneMoney')
  const [status, setStatus] = useState<PaymentStatus>(editing?.status ?? 'completed')
  const [date, setDate] = useState(editing?.date ?? toIsoDate(new Date()))
  const [useSplit, setUseSplit] = useState(!!editing?.splitPayments?.length)
  // The group representative hands in a bank slip / EcoCash screenshot —
  // any format a phone produces goes (the bucket has no mime whitelist).
  const [popFile, setPopFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [splits, setSplits] = useState<SplitPayment[]>(
    editing?.splitPayments?.length ? editing.splitPayments : [{ method: 'EcoCash', amount: 0 }, { method: 'OneMoney', amount: 0 }]
  )

  useEffect(() => {
    if (!initialPolicyId && !editing) {
      db.policies.list().then(({ data }) => setAllPolicies(data ?? []))
    }
  }, [initialPolicyId, editing])

  useEffect(() => {
    if (policyId) {
      db.policies.get(policyId).then(({ data }) => {
        if (!data) return
        setPolicy(data)
        db.products.list().then(({ data: products }) => {
          setPolicyCategory(products?.find(pr => pr.id === data.productId)?.category ?? '')
        })
      })
    } else {
      setPolicy(null)
      setPolicyCategory('')
    }
  }, [policyId])

  const updateSplit = (i: number, field: keyof SplitPayment, value: string) => {
    setSplits(prev => prev.map((s, idx) => idx === i ? { ...s, [field]: field === 'amount' ? Number(value) : value } : s))
  }

  const addSplit = () => setSplits(prev => [...prev, { method: 'Cash', amount: 0 }])
  const removeSplit = (i: number) => setSplits(prev => prev.filter((_, idx) => idx !== i))

  const splitTotal = splits.reduce((sum, s) => sum + (s.amount || 0), 0)
  const splitMismatch = useSplit && Math.abs(splitTotal - Number(amount || 0)) > 0.01

  /**
   * A recorded payment is money asserted to have been received, so the
   * figure has to be a real one.
   *
   * `!amount` alone let "0" through — a non-empty string is truthy — and
   * the min={0} on the input is only a browser hint, so a negative could be
   * typed or pasted straight past it. Both then reached the policy update
   * and moved the next payment date.
   */
  const amountValue = Number(amount)
  const amountInvalid = !amount.trim() || !Number.isFinite(amountValue) || amountValue <= 0
  const negativeSplit = useSplit && splits.some(s => s.amount < 0)
  const [attempted, setAttempted] = useState(false)

  const missing: MissingField[] = []
  if (!initialPolicyId && !editing && !policyId) missing.push({ key: 'policyId', label: 'Policy' })
  if (amountInvalid) missing.push({ key: 'amount', label: 'Amount', hint: 'Must be greater than zero' })

  const blockedReason = !policyId ? 'Select the policy this payment is for.'
    : amountInvalid ? 'Enter an amount greater than zero.'
      : negativeSplit ? 'A split line cannot be a negative amount.'
        : splitMismatch ? 'The split lines must add up to the amount.'
          : !policy ? 'Still loading the policy — try again in a moment.'
            : null

  const handleSave = async () => {
    // Never a silent return: the button stays live and says what is wrong,
    // including the policy-still-loading case, which used to make the
    // button do nothing at all with no explanation.
    setAttempted(true)
    if (blockedReason) return

    // No payment is recorded when the server can't be reached — a
    // collected payment nobody was notified about is worse than a retry.
    setUploading(true)
    const up = await serverReachable()
    setUploading(false)
    if (!up) {
      setSaveError('The server is unreachable right now — nothing was recorded. Try again in a moment.')
      return
    }

    // PoP goes up BEFORE the payment row — a recorded payment without its
    // receipt is the exact gap this exists to close, so a failed upload
    // blocks the save rather than recording a naked payment.
    let popUrl = editing?.popUrl
    if (popFile && policy) {
      setUploading(true)
      const { data: doc, error: uploadError } = await uploadDocument('policies', policy.clientId, popFile)
      setUploading(false)
      if (uploadError || !doc) {
        setSaveError(`Could not upload the proof of payment — ${uploadError ?? 'try again.'}`)
        return
      }
      popUrl = doc.path
    }

    const reference = editing?.reference ?? `PAY${new Date().toISOString().slice(0, 10).replace(/-/g, '')}${String(Date.now()).slice(-3)}`
    const paymentRecord: Payment = {
      id: editing?.id ?? `pay${Date.now()}`,
      reference,
      // Manual rails have no gateway transaction ID to capture, so one is
      // minted from the payer initials + method + timestamp instead
      // (LAM-CSH081020261649). Edits keep the original — re-saving must
      // not look like a different transaction.
      transactionId: editing?.transactionId ?? generateTransactionId({
        clientName: policy!.clientName,
        method: useSplit ? 'Split Payment' : method,
      }),
      policyId,
      policyNumber: policy!.policyNumber,
      clientName: policy!.clientName,
      amount: amountValue,
      method,
      status,
      date,
      splitPayments: useSplit ? splits.filter(s => s.amount > 0) : undefined,
      popUrl,
    }
    onSave(paymentRecord)
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 500 }}>
        <div className="modal-header">
          <h3>{editing ? `Edit Payment: ${editing.reference}` : 'Record Payment'}</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <ValidationSummary missing={missing} attempted={attempted} />
          {!initialPolicyId && !editing && (
            <div className="form-group" id={fieldId('policyId')}>
              <label>Policy *</label>
              <select className={invalidClass(missing, attempted, 'policyId')} value={policyId} onChange={e => setPolicyId(e.target.value)} disabled={!allPolicies}>
                <option value="">{allPolicies ? 'Select policy…' : 'Loading policies…'}</option>
                {allPolicies?.map(p => (
                  <option key={p.id} value={p.id}>{p.policyNumber} ({p.clientName})</option>
                ))}
              </select>
            </div>
          )}
          {policy && (
            <div className="info-banner info-banner-info" style={{ marginBottom: '1rem' }}>
              Policy: {policy.policyNumber} ({policy.clientName})<br />
              {/* Per head: the policyholder plus every dependant. */}
              Expected premium: ${policyBillablePremium(policy, policyCategory).toFixed(2)}{premiumPeriodLabel(policyCategory, policy.productName, policy.paymentMethod)}
              {billableHeadCount(policy, policyCategory) > 1 && (
                <> &nbsp;<span style={{ fontSize: 11 }}>({billableHeadCount(policy, policyCategory)} people on this policy)</span></>
              )}
            </div>
          )}
          {!policy && policyId && (
            <div className="info-banner info-banner-warning" style={{ marginBottom: '1rem' }}>
              Loading policy information…
            </div>
          )}
          <div className="form-row">
            <div className="form-group" id={fieldId('amount')}>
              <label>Amount ($) *</label>
              <input type="number" className={invalidClass(missing, attempted, 'amount')} min={0} step="0.01" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" />
            </div>
            <div className="form-group">
              <label>Payment Method *</label>
              <select className="form-control" value={method} onChange={e => setMethod(e.target.value as PaymentMethod)} disabled={useSplit}>
                {METHODS.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          </div>
          {editing && (
            <div className="form-row">
              <div className="form-group">
                <label>Status</label>
                <select className="form-control" value={status} onChange={e => setStatus(e.target.value as PaymentStatus)}>
                  {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label>Date</label>
                <DateInput value={date} onChange={setDate} />
              </div>
            </div>
          )}
          <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" id="split" checked={useSplit} onChange={e => setUseSplit(e.target.checked)} />
            <label htmlFor="split" style={{ marginBottom: 0, cursor: 'pointer' }}>Split payment across multiple methods</label>
          </div>
          {useSplit && (
            <div style={{ marginTop: '0.75rem' }}>
              {splits.map((s, i) => (
                <div key={i} className="form-row" style={{ marginBottom: 8, alignItems: 'center' }}>
                  <select className="form-control" value={s.method} onChange={e => updateSplit(i, 'method', e.target.value)}>
                    {METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <input type="number" className="form-control" placeholder="Amount" value={s.amount || ''} onChange={e => updateSplit(i, 'amount', e.target.value)} />
                  {splits.length > 1 && (
                    <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} onClick={() => removeSplit(i)} title="Remove method">✕</button>
                  )}
                </div>
              ))}
              <button type="button" className="btn btn-ghost btn-sm" onClick={addSplit}>+ Add Method</button>
              <p style={{ fontSize: 12, marginTop: 6, color: splitMismatch ? 'var(--danger)' : 'var(--muted)' }}>
                Split total: ${splitTotal.toFixed(2)} {splitMismatch && `(must equal the amount $${Number(amount || 0).toFixed(2)})`}
              </p>
            </div>
          )}
          {(policy?.groupId || editing?.popUrl) && (
            <div className="form-group" style={{ marginTop: '0.5rem' }}>
              <label>Proof of Payment (PoP) — any file type</label>
              <input type="file" accept="*/*" className="form-control" onChange={e => { setPopFile(e.target.files?.[0] ?? null); setSaveError('') }} />
              {editing?.popUrl && !popFile && (
                <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>A proof of payment is already attached — picking a new file replaces it.</p>
              )}
              {popFile && (
                <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{popFile.name} ({(popFile.size / 1024).toFixed(0)} KB)</p>
              )}
            </div>
          )}
          {blockedReason && (attempted || amount.trim() || policyId) && (
            <p style={{ fontSize: 12, color: 'var(--danger)', margin: '10px 0 0' }}>{blockedReason}</p>
          )}
          {saveError && (
            <p style={{ fontSize: 12, color: 'var(--danger)', margin: '10px 0 0' }}>{saveError}</p>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose} disabled={uploading}>Cancel</button>
          <button className="btn btn-primary" onClick={() => void handleSave()} disabled={uploading}>
            {uploading ? 'Uploading PoP…' : editing ? 'Save Changes' : 'Record Payment'}
          </button>
        </div>
      </div>
    </div>
  )
}
