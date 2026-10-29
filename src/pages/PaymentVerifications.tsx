import { useState, useEffect } from 'react'
import type { ToastMessage, Policy, Product, Dependant, PaymentMethod } from '../types'
import { db } from '../lib/db'
import { supabase } from '../lib/supabase'
import { formatDate, toIsoDate } from '../lib/dateUtils'
import { getDocumentUrl } from '../lib/storage'
import { nextPolicyNumber } from '../lib/policyNumbers'
import { computeAssignedStartDate } from '../lib/policyLifecycle'
import { generateTransactionId } from '../lib/transactionId'
import { recordActivity } from '../lib/activityLog'
import { fetchAllRows } from '../lib/paged'
import { useAuth } from '../contexts/AuthContext'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
}

/**
 * Website applications paid by Bank Transfer or EcoCash Merchant Pay. No
 * gateway webhook ever arrives for those — the buyer uploads a proof of
 * payment and types their transaction reference, and a staff member must
 * sight the money on the statement before anything becomes a policy.
 *
 * Verify → creates/finds the client, writes each selected product as a
 * 'pending' policy (still subject to the normal Approve step on the
 * Policies page), records the payment with the PoP attached, and settles
 * the session 'paid'. Decline → 'cancelled'.
 */
interface CheckoutSession {
  id: string
  reference: string
  status: string
  gateway: string
  amount: number
  product_id: string
  client_name: string
  client_email: string | null
  client_phone: string
  client_national_id: string
  client_dob: string | null
  client_address: string | null
  client_occupation: string | null
  dependants: Dependant[]
  selections: Array<{ productId: string; dependants: Dependant[] }>
  pop_path: string | null
  pop_filename: string | null
  transaction_reference: string | null
  created_at: string
}

const GATEWAY_LABEL: Record<string, string> = {
  bank_transfer: 'Bank Transfer',
  ecocash_merchant: 'EcoCash Merchant Pay',
}
const GATEWAY_METHOD: Record<string, PaymentMethod> = {
  bank_transfer: 'Bank Transfer',
  ecocash_merchant: 'EcoCash',
}

export default function PaymentVerifications({ showToast }: Props) {
  const { user } = useAuth()
  const [sessions, setSessions] = useState<CheckoutSession[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const load = async () => {
    const { data, error } = await fetchAllRows(
      () => supabase
        .from('checkout_sessions')
        .select('*')
        .eq('status', 'pending_verification')
        .order('created_at', { ascending: false }),
      { orderBy: 'id' },
    )
    if (error) showToast('error', `Could not load pending verifications: ${error.message}`)
    else setSessions((data ?? []) as CheckoutSession[])
    const { data: prods } = await db.products.list()
    setProducts(prods ?? [])
    setLoading(false)
  }
  useEffect(() => { void load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const productFor = (id: string) => products.find(p => p.id === id)
  const sessionSelections = (s: CheckoutSession) =>
    s.selections?.length ? s.selections : [{ productId: s.product_id, dependants: s.dependants ?? [] }]

  const viewPop = async (s: CheckoutSession) => {
    if (!s.pop_path) { showToast('warning', 'No proof of payment was stored with this application.'); return }
    const url = await getDocumentUrl(s.pop_path)
    if (url) window.open(url, '_blank', 'noopener')
    else showToast('error', 'Could not open the proof of payment.')
  }

  const handleVerify = async (s: CheckoutSession) => {
    const productNames = sessionSelections(s).map(sel => productFor(sel.productId)?.name ?? 'unknown').join(', ')
    if (!window.confirm(`Verify ${s.client_name}'s ${GATEWAY_LABEL[s.gateway] ?? s.gateway} payment of $${s.amount.toFixed(2)} (ref ${s.transaction_reference ?? 'none'}) and register ${productNames}?`)) return
    setBusy(s.id)
    try {
      // Client: the national ID is the dedupe key — a returning buyer must
      // land on their existing profile, never a second one.
      const { data: existing } = await supabase
        .from('clients').select('id, name').eq('national_id', s.client_national_id).maybeSingle()
      let clientId = existing?.id as string | undefined
      if (!clientId) {
        const { data: created, error } = await db.clients.create({
          name: s.client_name, email: s.client_email ?? '', phone: s.client_phone,
          nationalId: s.client_national_id, dob: s.client_dob ?? '',
          address: s.client_address ?? '', occupation: s.client_occupation ?? undefined,
          createdAt: toIsoDate(new Date()), status: 'active',
        })
        if (error || !created) { showToast('error', error ?? 'Could not create the client profile.'); return }
        clientId = created.id
      }

      const method = GATEWAY_METHOD[s.gateway] ?? 'Bank Transfer'
      const startDate = computeAssignedStartDate()
      const endDate = new Date(startDate); endDate.setFullYear(endDate.getFullYear() + 1)
      const nextPayment = new Date(startDate); nextPayment.setMonth(nextPayment.getMonth() + 1)
      const policyIds: string[] = []

      for (const sel of sessionSelections(s)) {
        const product = productFor(sel.productId)
        if (!product) { showToast('error', 'A selected product no longer exists — register it by hand.'); return }
        const policyNumber = await nextPolicyNumber(product)
        const policy: Omit<Policy, 'id'> = {
          policyNumber,
          clientId, clientName: s.client_name,
          productId: product.id, productName: product.name,
          premium: product.premium, coverAmount: product.coverAmount,
          startDate, endDate: toIsoDate(endDate),
          // Manual channels never auto-activate — the policy waits for a
          // staff member's Approve on the Policies page like any walk-in.
          status: 'pending',
          dependants: sel.dependants ?? [],
          paymentMethod: method,
          source: 'motions_website',
          createdAt: toIsoDate(new Date()),
          nextPaymentDate: toIsoDate(nextPayment),
        }
        const { data: created, error } = await db.policies.create(policy)
        if (error || !created) { showToast('error', error ?? `Could not create the ${product.name} policy.`); return }
        policyIds.push(created.id)

        const { error: payErr } = await db.payments.create({
          reference: s.reference,
          transactionId: generateTransactionId({ clientName: s.client_name, method }),
          policyId: created.id,
          policyNumber,
          clientName: s.client_name,
          amount: Math.round(product.premium * (1 + (sel.dependants?.length ?? 0)) * 100) / 100,
          method, status: 'completed', date: toIsoDate(new Date()),
          popUrl: s.pop_path ?? undefined,
          popDescription: s.transaction_reference ?? undefined,
        })
        if (payErr) showToast('warning', `Policy ${policyNumber} created but its payment record failed: ${payErr}`)
      }

      await supabase.from('checkout_sessions').update({
        status: 'paid', payment_method: method,
        policy_id: policyIds[0] ?? null, policy_ids: policyIds,
        updated_at: new Date().toISOString(),
      }).eq('id', s.id)

      void recordActivity({
        action: 'policy.created',
        actor: { id: user?.id, name: user?.name ?? 'Unknown', role: user?.role ?? 'unknown' },
        entityType: 'policy', entityId: policyIds[0], entityLabel: s.reference,
        detail: `Manual payment verified — ${s.client_name}, $${s.amount.toFixed(2)} via ${GATEWAY_LABEL[s.gateway] ?? s.gateway}, txn ref ${s.transaction_reference ?? 'none'}`,
      })
      setSessions(prev => prev.filter(x => x.id !== s.id))
      showToast('success', `${s.client_name} verified — ${policyIds.length} ${policyIds.length === 1 ? 'policy' : 'policies'} registered as pending. Approve on the Policies page to activate.`)
    } finally {
      setBusy(null)
    }
  }

  const handleDecline = async (s: CheckoutSession) => {
    const reason = window.prompt(`Decline ${s.client_name}'s ${s.reference}? Give a reason (shown on the record):`)
    if (reason === null) return
    setBusy(s.id)
    const { error } = await supabase.from('checkout_sessions')
      .update({ status: 'cancelled', failure_reason: reason.trim() || 'Declined at manual verification', updated_at: new Date().toISOString() })
      .eq('id', s.id)
    setBusy(null)
    if (error) { showToast('error', error.message); return }
    setSessions(prev => prev.filter(x => x.id !== s.id))
    showToast('success', `${s.reference} declined.`)
  }

  return (
    <div className="panel">
      <div className="panel-toolbar">
        <div className="filter-row">
          <h2 style={{ margin: 0 }}>Payment Verifications</h2>
          <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
            Website payments made by bank transfer or EcoCash merchant pay — review the proof of payment against the statement, then verify or decline.
          </span>
        </div>
        <button type="button" className="btn btn-ghost" onClick={() => { setLoading(true); void load() }}>↻ Refresh</button>
      </div>

      <div className="card">
        {loading ? (
          <div className="empty-state">Loading…</div>
        ) : sessions.length === 0 ? (
          <div className="empty-state">Nothing awaiting verification — manual website payments land here.</div>
        ) : (
          <div className="tbl-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Client</th>
                  <th>Cover</th>
                  <th>Amount</th>
                  <th>Method</th>
                  <th>Txn Ref</th>
                  <th>Submitted</th>
                  <th>PoP</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map(s => (
                  <tr key={s.id}>
                    <td><span className="mono">{s.reference}</span></td>
                    <td>
                      {s.client_name}
                      <div style={{ fontSize: 11, color: 'var(--muted)' }}>{s.client_phone} · ID {s.client_national_id}</div>
                    </td>
                    <td>{sessionSelections(s).map(sel => productFor(sel.productId)?.name ?? sel.productId).join(', ')}</td>
                    <td>${s.amount.toFixed(2)}</td>
                    <td>{GATEWAY_LABEL[s.gateway] ?? s.gateway}</td>
                    <td><span className="mono">{s.transaction_reference ?? '—'}</span></td>
                    <td>{formatDate(s.created_at)}</td>
                    <td>
                      {s.pop_path
                        ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => viewPop(s)}>📎 {s.pop_filename ?? 'View'}</button>
                        : '—'}
                    </td>
                    <td>
                      <div className="action-btns">
                        <button type="button" className="btn btn-primary btn-sm" disabled={busy === s.id} onClick={() => handleVerify(s)}>
                          {busy === s.id ? 'Working…' : 'Verify & Register'}
                        </button>
                        <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} disabled={busy === s.id} onClick={() => handleDecline(s)}>Decline</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
