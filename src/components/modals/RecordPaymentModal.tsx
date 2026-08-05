import { useState, useEffect } from 'react'
import type { Payment, PaymentMethod, SplitPayment, Policy } from '../../types'
import { db } from '../../lib/db'

interface Props {
  /** When omitted, the modal lets the user pick a policy from a dropdown. */
  policyId?: string
  onClose: () => void
  onSave: (payment: Payment) => void
}

const METHODS: PaymentMethod[] = ['OneMoney', 'InnBucks', 'Airtime Balance', 'Bank Transfer', 'Cash', 'Debit Order', 'EcoCash']

export default function RecordPaymentModal({ policyId: initialPolicyId, onClose, onSave }: Props) {
  const [allPolicies, setAllPolicies] = useState<Policy[] | null>(null)
  const [policyId, setPolicyId] = useState(initialPolicyId ?? '')
  const [policy, setPolicy] = useState<Policy | null>(null)
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<PaymentMethod>('OneMoney')
  const [useSplit, setUseSplit] = useState(false)
  const [splits, setSplits] = useState<SplitPayment[]>([
    { method: 'EcoCash', amount: 0 },
    { method: 'OneMoney', amount: 0 },
  ])

  useEffect(() => {
    if (!initialPolicyId) {
      db.policies.list().then(({ data }) => setAllPolicies(data ?? []))
    }
  }, [initialPolicyId])

  useEffect(() => {
    if (policyId) {
      db.policies.get(policyId).then(({ data }) => {
        if (data) setPolicy(data)
      })
    } else {
      setPolicy(null)
    }
  }, [policyId])

  const updateSplit = (i: number, field: keyof SplitPayment, value: string) => {
    setSplits(prev => prev.map((s, idx) => idx === i ? { ...s, [field]: field === 'amount' ? Number(value) : value } : s))
  }

  const handleSave = () => {
    if (!policyId || !amount) return
    const reference = `PAY${new Date().toISOString().slice(0, 10).replace(/-/g, '')}${String(Date.now()).slice(-3)}`
    const payment: Payment = {
      id: `pay${Date.now()}`,
      reference,
      policyId,
      policyNumber: policy!.policyNumber,
      clientName: policy!.clientName,
      amount: Number(amount),
      method,
      status: 'completed',
      date: new Date().toISOString().split('T')[0],
      splitPayments: useSplit ? splits.filter(s => s.amount > 0) : undefined,
    }
    onSave(payment)
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 500 }}>
        <div className="modal-header">
          <h3>Record Payment</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {!initialPolicyId && (
            <div className="form-group">
              <label>Policy *</label>
              <select className="form-control" value={policyId} onChange={e => setPolicyId(e.target.value)} disabled={!allPolicies}>
                <option value="">{allPolicies ? 'Select policy…' : 'Loading policies…'}</option>
                {allPolicies?.map(p => (
                  <option key={p.id} value={p.id}>{p.policyNumber} — {p.clientName}</option>
                ))}
              </select>
            </div>
          )}
          {policy && (
            <div className="info-banner info-banner-info" style={{ marginBottom: '1rem' }}>
              Policy: {policy.policyNumber} — {policy.clientName}<br />
              Expected premium: ${policy.premium.toFixed(2)}/mo
            </div>
          )}
          {!policy && policyId && (
            <div className="info-banner info-banner-warning" style={{ marginBottom: '1rem' }}>
              Loading policy information…
            </div>
          )}
          <div className="form-row">
            <div className="form-group">
              <label>Amount ($) *</label>
              <input type="number" className="form-control" min={0} value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" />
            </div>
            <div className="form-group">
              <label>Payment Method *</label>
              <select className="form-control" value={method} onChange={e => setMethod(e.target.value as PaymentMethod)} disabled={useSplit}>
                {METHODS.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          </div>
          <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" id="split" checked={useSplit} onChange={e => setUseSplit(e.target.checked)} />
            <label htmlFor="split" style={{ marginBottom: 0, cursor: 'pointer' }}>Split payment across multiple methods</label>
          </div>
          {useSplit && (
            <div style={{ marginTop: '0.75rem' }}>
              {splits.map((s, i) => (
                <div key={i} className="form-row" style={{ marginBottom: 8 }}>
                  <select className="form-control" value={s.method} onChange={e => updateSplit(i, 'method', e.target.value)}>
                    {METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <input type="number" className="form-control" placeholder="Amount" value={s.amount || ''} onChange={e => updateSplit(i, 'amount', e.target.value)} />
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={!policyId || !amount}>
            Record Payment
          </button>
        </div>
      </div>
    </div>
  )
}
