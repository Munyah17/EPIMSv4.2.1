import { useState, useEffect } from 'react'
import type { ToastMessage, Quotation, QuotationStatus, Client, Product, Policy, CoverScope, QuotePolicyDetails } from '../../types'
import { db } from '../../lib/db'
import { formatDate } from '../../lib/dateUtils'
import { useAuth } from '../../contexts/AuthContext'
import ValidationSummary, { MissingField, invalidClass, fieldId } from '../ui/ValidationSummary'
import { MANUAL_PAYMENT_METHODS } from '../../types'
import NewPolicyModal from '../modals/NewPolicyModal'
import { notifyPolicyRegistered } from '../../lib/signupNotifications'
import { serverReachable } from '../../lib/notify'
import { sendSystemEmail } from '../../lib/mailService'
import { getPolicyReportPdfBase64 } from '../../lib/exportUtils'
import { exportQuotationPdf } from '../../lib/billingDocsPdf'
import { MAILBOXES } from '../../lib/mailboxes'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
}

const PILL: Record<QuotationStatus, string> = {
  draft: 'pill-pending',
  sent: 'pill-pending',
  accepted: 'pill-active',
  declined: 'pill-cancelled',
  expired: 'pill-cancelled',
}

/** Quotes a price before any cover exists. A quotation can reference an
 *  existing client (dropdown) or a pure prospect (typed name) — the quote
 *  number, status trail and product/premium snapshot are what matter. */
export default function QuotationsPanel({ showToast }: Props) {
  const { user } = useAuth()
  const [items, setItems] = useState<Quotation[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  // Quotation being converted — the modal carries the quote's product and
  // its negotiated figures; client is resolved when the quote links one.
  const [converting, setConverting] = useState<{ quote: Quotation; client?: Client } | null>(null)
  const [convertLoadingId, setConvertLoadingId] = useState<string | null>(null)

  const load = () => {
    setLoading(true)
    db.quotations.list().then(({ data, error }) => {
      if (error) showToast('error', error)
      setItems(data)
    }).finally(() => setLoading(false))
  }
  useEffect(load, []) // eslint-disable-line react-hooks/exhaustive-deps

  const setStatus = async (q: Quotation, status: QuotationStatus) => {
    const { data, error } = await db.quotations.setStatus(q.id, status)
    if (error || !data) { showToast('error', error ?? 'Failed to update the quotation.'); return }
    setItems(prev => prev.map(x => x.id === data.id ? data : x))
    showToast('success', `${q.quotationNumber} → ${status}.`)
  }

  const remove = async (q: Quotation) => {
    if (!window.confirm(`Delete quotation ${q.quotationNumber}?`)) return
    const { error } = await db.quotations.remove(q.id)
    if (error) { showToast('error', error); return }
    setItems(prev => prev.filter(x => x.id !== q.id))
    showToast('success', `${q.quotationNumber} deleted.`)
  }

  /** Quote → policy. A quote linked to a client locks that client into
   *  the new-policy form; a pure prospect seeds the name and lets staff
   *  finish the record inside the modal. */
  const startConvert = async (q: Quotation) => {
    setConvertLoadingId(q.id)
    try {
      let client: Client | undefined
      if (q.clientId) {
        const { data } = await db.clients.get(q.clientId)
        if (!data) { showToast('error', `Could not load ${q.clientName}'s client record — register them first.`); return }
        client = data
      }
      setConverting({ quote: q, client })
    } finally {
      setConvertLoadingId(null)
    }
  }

  /** Same registration path as Clients → Assign Policy / the no-policy
   *  register: the created policy texts the client and, for non-funeral
   *  cover, emails the policy document. */
  const handleConvertSave = async (policy: Policy): Promise<Policy | null> => {
    if (!(await serverReachable())) {
      showToast('error', 'The server is unreachable right now — nothing was registered. Try again in a moment.')
      return null
    }
    const { data, error } = await db.policies.create(policy)
    if (error || !data) {
      showToast('error', error ?? 'Failed to create policy.')
      return null
    }
    const quote = converting?.quote
    setConverting(null)
    showToast('success', `Policy ${data.policyNumber} issued from ${quote?.quotationNumber ?? 'the quotation'}.`)

    // Conversion IS acceptance — a sent quote flips to accepted, and a
    // converted quote never sits looking un-actioned afterwards.
    if (quote && quote.status !== 'accepted') {
      const { data: updated } = await db.quotations.setStatus(quote.id, 'accepted')
      if (updated) setItems(prev => prev.map(x => x.id === updated.id ? updated : x))
    }

    const { data: client } = await db.clients.get(data.clientId)
    void notifyPolicyRegistered(data, client ?? null)

    const { data: allProducts } = await db.products.list()
    const category = allProducts?.find(pr => pr.id === data.productId)?.category ?? ''
    if (category !== 'funeral' && client?.email) {
      try {
        const attachmentBase64 = await getPolicyReportPdfBase64(data, client, category)
        const result = await sendSystemEmail({
          from: MAILBOXES.noreply,
          to: client.email,
          subject: `Your Policy ${data.policyNumber}: Documents Enclosed`,
          body: `Dear ${client.name},\n\nThank you for choosing us. Your policy ${data.policyNumber} (${data.productName}) is now active. Your policy report is attached for your records.\n\nRegards,\nTariqify IMS`,
          linkedTo: data.id,
          attachmentBase64,
          attachmentFilename: `${data.policyNumber}-Policy-Report.pdf`,
        })
        if (!result.delivered) showToast('warning', 'Policy created, but the document email could not be sent; check Settings → Notifications.')
      } catch {
        showToast('warning', 'Policy created, but the document email could not be sent.')
      }
    }
    return data
  }

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">Quotations</span>
        <button className="btn btn-primary btn-sm" onClick={() => setShowForm(true)}>＋ New Quotation</button>
      </div>
      <p style={{ fontSize: 11, color: 'var(--muted)', margin: '0 0 12px' }}>
        Price a product for a prospect or existing client before cover exists. Send it, then mark
        whether the customer accepted — an accepted quotation is the hand-off point for issuing a policy.
      </p>
      {loading ? (
        <div className="empty-state">Loading quotations…</div>
      ) : items.length === 0 ? (
        <div className="empty-state">No quotations yet.</div>
      ) : (
        <div className="tbl-scroll">
        <table className="table">
          <thead>
            <tr><th>Quote</th><th>Customer</th><th>Product</th><th>Premium</th><th>Cover</th><th>Valid Until</th><th>Status</th><th>By</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {items.map(q => (
              <tr key={q.id}>
                <td><span className="mono">{q.quotationNumber}</span></td>
                <td>{q.clientName}</td>
                <td>{q.productName || '—'}</td>
                <td>${q.premium.toFixed(2)}</td>
                <td>{q.coverAmount != null ? `$${q.coverAmount.toFixed(2)}` : '—'}</td>
                <td>{formatDate(q.validUntil)}</td>
                <td><span className={`pill ${PILL[q.status]}`}>{q.status}</span></td>
                <td>{q.createdByName ?? '—'}</td>
                <td>
                  <div className="action-btns">
                    <button className="btn btn-ghost btn-sm" title="Download the branded quotation PDF"
                      onClick={() => void exportQuotationPdf(q).catch(() => showToast('error', 'Could not generate the PDF.'))}>
                      PDF
                    </button>
                    {q.status === 'draft' && (
                      <button className="btn btn-ghost btn-sm" style={{ color: 'var(--accent)' }} onClick={() => setStatus(q, 'sent')}>Send</button>
                    )}
                    {(q.status === 'draft' || q.status === 'sent') && (
                      <>
                        <button className="btn btn-ghost btn-sm" style={{ color: 'var(--success)' }} onClick={() => setStatus(q, 'accepted')}>Accept</button>
                        <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} onClick={() => setStatus(q, 'declined')}>Decline</button>
                      </>
                    )}
                    {q.status === 'draft' && (
                      <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} onClick={() => remove(q)}>Delete</button>
                    )}
                    {(q.status === 'sent' || q.status === 'accepted') && (
                      <button className="btn btn-primary btn-sm"
                        disabled={convertLoadingId === q.id}
                        title="Issue a real policy from this quote — product and agreed price carry over"
                        onClick={() => void startConvert(q)}>
                        {convertLoadingId === q.id ? 'Loading…' : '→ Policy'}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
      {converting && (
        <NewPolicyModal
          initialClient={converting.client}
          initialQuotation={converting.quote}
          onClose={() => setConverting(null)}
          onSave={handleConvertSave}
          showToast={showToast}
        />
      )}
      {showForm && (
        <NewQuotationModal
          createdBy={user?.id}
          createdByName={user?.name}
          saving={saving}
          onClose={() => setShowForm(false)}
          onSave={async (input) => {
            setSaving(true)
            const { data, error } = await db.quotations.create(input)
            setSaving(false)
            if (error || !data) { showToast('error', error ?? 'Failed to save the quotation.'); return }
            setItems(prev => [data, ...prev])
            setShowForm(false)
            showToast('success', `Quotation ${data.quotationNumber} created.`)
          }}
        />
      )}
    </div>
  )
}

function NewQuotationModal({ onClose, onSave, saving, createdBy, createdByName }: {
  onClose: () => void
  onSave: (q: Omit<Quotation, 'id' | 'quotationNumber' | 'status' | 'createdAt' | 'updatedAt'>) => void
  saving: boolean
  createdBy?: string
  createdByName?: string
}) {
  const [clients, setClients] = useState<Client[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [clientId, setClientId] = useState('')
  const [prospectName, setProspectName] = useState('')
  const [productId, setProductId] = useState('')
  const [premium, setPremium] = useState('')
  const [coverAmount, setCoverAmount] = useState('')
  const [validUntil, setValidUntil] = useState('')
  const [notes, setNotes] = useState('')
  const [attempted, setAttempted] = useState(false)
  // Product-matched policy fields — the quote captures what the policy
  // application needs so →Policy issues instantly, no re-interview.
  const [clientPhone, setClientPhone] = useState('')
  const [clientEmail, setClientEmail] = useState('')
  const [clientNationalId, setClientNationalId] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('OneMoney')
  const [dependants, setDependants] = useState<{ name: string; relationship: string; dob?: string }[]>([])
  const [growerNumber, setGrowerNumber] = useState('')
  const [contractor, setContractor] = useState('')
  const [hectarage, setHectarage] = useState('')
  const [coverScope, setCoverScope] = useState<CoverScope>('individual')

  useEffect(() => {
    db.clients.list().then(({ data }) => setClients(data ?? []))
    db.products.list().then(({ data }) => setProducts((data ?? []).filter(p => p.active)))
  }, [])

  const client = clients.find(c => c.id === clientId)
  const product = products.find(p => p.id === productId)
  const isAgriculture = product?.category === 'agriculture'
  const coversDependants = product?.category === 'funeral' || product?.category === 'life' || product?.category === 'health'

  const pickProduct = (id: string) => {
    setProductId(id)
    const p = products.find(x => x.id === id)
    if (p) { setPremium(String(p.premium)); setCoverAmount(String(p.coverAmount)) }
  }

  const missing: MissingField[] = []
  if (!clientId && !prospectName.trim()) missing.push({ key: 'customer', label: 'Customer', hint: 'Pick a client or type a prospect name' })
  if (!productId) missing.push({ key: 'product', label: 'Product' })
  if (!premium || Number(premium) <= 0) missing.push({ key: 'premium', label: 'Premium' })

  const handleSave = () => {
    setAttempted(true)
    if (missing.length > 0) return
    const details: QuotePolicyDetails = {
      clientPhone: client?.phone ?? (clientPhone.trim() || undefined),
      clientEmail: client?.email ?? (clientEmail.trim() || undefined),
      clientNationalId: client?.nationalId ?? (clientNationalId.trim() || undefined),
      clientDob: client?.dob,
      clientAddress: client?.address,
      clientOccupation: client?.occupation,
      paymentMethod: (paymentMethod || undefined) as QuotePolicyDetails['paymentMethod'],
      dependants: dependants.filter(d => d.name.trim()).length ? dependants.filter(d => d.name.trim()) : undefined,
      growerNumber: isAgriculture ? growerNumber.trim() || undefined : undefined,
      contractor: isAgriculture ? contractor.trim() || undefined : undefined,
      hectarage: isAgriculture ? hectarage.trim() || undefined : undefined,
      coverScope,
    }
    onSave({
      clientId: clientId || undefined,
      clientName: client?.name ?? prospectName.trim(),
      productId: product?.id,
      productName: product?.name ?? '',
      premium: Number(premium),
      coverAmount: coverAmount ? Number(coverAmount) : undefined,
      policyDetails: details,
      validUntil: validUntil || undefined,
      notes: notes.trim() || undefined,
      createdBy,
      createdByName,
    })
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 520 }}>
        <div className="modal-header">
          <h3>New Quotation</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <ValidationSummary missing={missing} attempted={attempted} />
          <div className="form-group" id={fieldId('customer')}>
            <label>Existing client</label>
            <select className={invalidClass(missing, attempted, 'customer')} value={clientId} onChange={e => { setClientId(e.target.value); if (e.target.value) setProspectName('') }}>
              <option value="">— or type a prospect name below —</option>
              {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          {!clientId && (
            <div className="form-group">
              <label>Prospect name</label>
              <input className={invalidClass(missing, attempted, 'customer')} value={prospectName} onChange={e => setProspectName(e.target.value)} placeholder="Customer not yet a client…" />
            </div>
          )}
          <div className="form-group" id={fieldId('product')}>
            <label>Product *</label>
            <select className={invalidClass(missing, attempted, 'product')} value={productId} onChange={e => pickProduct(e.target.value)}>
              <option value="">Select product…</option>
              {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="form-row">
            <div className="form-group" id={fieldId('premium')}>
              <label>Premium ($) *</label>
              <input type="number" min="0" step="0.01" className={invalidClass(missing, attempted, 'premium')} value={premium} onChange={e => setPremium(e.target.value)} />
            </div>
            <div className="form-group">
              <label>Cover amount ($)</label>
              <input type="number" min="0" step="0.01" className="form-control" value={coverAmount} onChange={e => setCoverAmount(e.target.value)} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Valid until</label>
              <input type="date" className="form-control" value={validUntil} onChange={e => setValidUntil(e.target.value)} />
            </div>
            <div className="form-group">
              <label>Payment method</label>
              <select className="form-control" value={paymentMethod} onChange={e => setPaymentMethod(e.target.value)}>
                {MANUAL_PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          </div>

          {/* Product-matched application answers — carried into the
              policy on conversion so nothing is asked twice. */}
          {product && (
            <>
              {!clientId && (
                <div className="form-row">
                  <div className="form-group">
                    <label>Prospect phone</label>
                    <input className="form-control" value={clientPhone} onChange={e => setClientPhone(e.target.value)} placeholder="07…" />
                  </div>
                  <div className="form-group">
                    <label>Prospect email</label>
                    <input className="form-control" value={clientEmail} onChange={e => setClientEmail(e.target.value)} placeholder="Optional" />
                  </div>
                </div>
              )}
              <div className="form-row">
                <div className="form-group">
                  <label>Cover scope</label>
                  <select className="form-control" value={coverScope} onChange={e => setCoverScope(e.target.value as CoverScope)}>
                    <option value="individual">Individual</option>
                    <option value="corporate">Corporate</option>
                    <option value="group">Group</option>
                    <option value="team">Team</option>
                  </select>
                </div>
                {!clientId && (
                  <div className="form-group">
                    <label>National ID</label>
                    <input className="form-control" value={clientNationalId} onChange={e => setClientNationalId(e.target.value)} placeholder="Optional" />
                  </div>
                )}
              </div>
              {isAgriculture && (
                <div className="form-row">
                  <div className="form-group">
                    <label>Grower number</label>
                    <input className="form-control" value={growerNumber} onChange={e => setGrowerNumber(e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label>Contractor</label>
                    <input className="form-control" value={contractor} onChange={e => setContractor(e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label>Hectarage</label>
                    <input className="form-control" value={hectarage} onChange={e => setHectarage(e.target.value)} />
                  </div>
                </div>
              )}
              {coversDependants && (
                <div className="form-group">
                  <label>Dependants {dependants.length > 0 && `(${dependants.length})`}</label>
                  {dependants.map((d, i) => (
                    <div key={i} className="form-row" style={{ marginBottom: 4 }}>
                      <input className="form-control" placeholder="Name" value={d.name}
                        onChange={e => setDependants(prev => prev.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                      <input className="form-control" placeholder="Relationship" value={d.relationship}
                        onChange={e => setDependants(prev => prev.map((x, j) => j === i ? { ...x, relationship: e.target.value } : x))} />
                      <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }}
                        onClick={() => setDependants(prev => prev.filter((_, j) => j !== i))}>✕</button>
                    </div>
                  ))}
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDependants(prev => [...prev, { name: '', relationship: '' }])}>
                    ＋ Add dependant
                  </button>
                </div>
              )}
            </>
          )}

          <div className="form-group">
            <label>Notes</label>
            <input className="form-control" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional…" />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save Quotation'}
          </button>
        </div>
      </div>
    </div>
  )
}
