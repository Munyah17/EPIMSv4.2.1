import { useState, useEffect } from 'react'
import type { Policy, PolicyStatus, AppUser, Dependant, Product } from '../../types'
import { MANUAL_PAYMENT_METHODS } from '../../types'
import { db } from '../../lib/db'
import { HECTARAGE_OPTIONS, hectarageLabel } from '../../lib/productUtils'
import DateInput from '../ui/DateInput'
import { cleanNationalIdInput } from '../../lib/validation'

interface Props {
  policy: Policy
  onClose: () => void
  onSave: (policy: Policy) => void
}

export default function EditPolicyModal({ policy, onClose, onSave }: Props) {
  const [status, setStatus] = useState<PolicyStatus>(policy.status)
  const [paymentMethod, setPaymentMethod] = useState(policy.paymentMethod)
  const [nextPaymentDate, setNextPaymentDate] = useState(policy.nextPaymentDate ?? '')
  const [agentId, setAgentId] = useState(policy.agentId ?? '')
  const [growerNumber, setGrowerNumber] = useState(policy.growerNumber ?? '')
  const [contractor, setContractor] = useState(policy.contractor ?? '')
  const [hectarage, setHectarage] = useState(policy.hectarage != null ? String(policy.hectarage) : '')
  const [premium, setPremium] = useState(policy.premium != null ? String(policy.premium) : '')
  const [coverAmount, setCoverAmount] = useState(policy.coverAmount != null ? String(policy.coverAmount) : '')
  const [endDate, setEndDate] = useState(policy.endDate ?? '')
  const [dependants, setDependants] = useState<Dependant[]>(policy.dependants ?? [])
  const [staff, setStaff] = useState<AppUser[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [clients, setClients] = useState<{ id: string; name: string }[]>([])
  const [clientId, setClientId] = useState(policy.clientId ?? '')
  const [productId, setProductId] = useState(policy.productId ?? '')
  const [isAgriculture, setIsAgriculture] = useState(false)
  const [isMedical, setIsMedical] = useState(false)

  useEffect(() => {
    db.staff.list().then(({ data }) => { if (data) setStaff(data.filter(s => s.active)) })
    db.products.list().then(({ data }) => {
      if (data) setProducts(data)
      const category = data?.find(p => p.id === policy.productId)?.category
      setIsAgriculture(category === 'agriculture')
      setIsMedical(category === 'health')
    })
    db.clients.list().then(({ data }) => {
      if (data) setClients(data.map(c => ({ id: c.id, name: c.name })))
    })
  }, [policy.productId])

  const addDependant = () => {
    if (isAgriculture && dependants.length >= 1) return
    setDependants(prev => [...prev, { name: '', relationship: '', dob: '', nationalId: '' }])
  }

  const removeDependant = (i: number) => {
    setDependants(prev => prev.filter((_, idx) => idx !== i))
  }

  const updateDependant = (i: number, field: keyof Dependant, value: string | boolean | undefined) => {
    setDependants(prev => prev.map((d, idx) => {
      if (idx !== i) return d
      const next = { ...d, [field]: value }
      // IDs store in canonical form — the dependant "ID" may be a birth
      // record number, so only separators are normalised, never rejected.
      if (field === 'nationalId' && typeof value === 'string') {
        next.nationalId = cleanNationalIdInput(value)
      }
      return next
    }))
  }

  const product = products.find(p => p.id === policy.productId)
  const dependantPlanOptions = product
    ? products.filter(p => p.active && p.category === product.category)
    : []

  const handleSave = () => {
    // Only send fields that actually changed. Comparisons have to be
    // grouped: `a ? b : c !== d` reads c !== d only when a is empty, so a
    // filled premium was treated as "changed" on every save.
    const updates: Partial<Policy> = { id: policy.id }

    if (status !== policy.status) updates.status = status
    if (paymentMethod && paymentMethod !== policy.paymentMethod) updates.paymentMethod = paymentMethod

    const nextPay = nextPaymentDate.trim()
    if (nextPay !== (policy.nextPaymentDate ?? '')) updates.nextPaymentDate = nextPay

    const nextAgent = agentId.trim()
    if (nextAgent !== (policy.agentId ?? '')) updates.agentId = nextAgent

    const nextClient = clientId.trim()
    if (nextClient !== (policy.clientId ?? '')) updates.clientId = nextClient

    const nextProduct = productId.trim()
    if (nextProduct !== (policy.productId ?? '')) updates.productId = nextProduct

    if (isAgriculture) {
      if (growerNumber.trim() !== (policy.growerNumber ?? '')) updates.growerNumber = growerNumber.trim()
      if (contractor.trim() !== (policy.contractor ?? '')) updates.contractor = contractor.trim()
      const nextHa = hectarage === '' ? undefined : Number(hectarage)
      if (nextHa !== policy.hectarage && !(nextHa === undefined && policy.hectarage == null)) {
        updates.hectarage = nextHa
      }
    }

    const nextPremium = Number(premium)
    if (premium.trim() !== '' && Number.isFinite(nextPremium) && nextPremium !== Number(policy.premium)) {
      updates.premium = nextPremium
    }
    const nextCover = Number(coverAmount)
    if (coverAmount.trim() !== '' && Number.isFinite(nextCover) && nextCover !== Number(policy.coverAmount)) {
      updates.coverAmount = nextCover
    }
    const nextEnd = endDate.trim()
    if (nextEnd && nextEnd !== (policy.endDate ?? '')) updates.endDate = nextEnd
    if (JSON.stringify(dependants) !== JSON.stringify(policy.dependants ?? [])) updates.dependants = dependants

    onSave(updates as Policy)
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 800 }}>
        <div className="modal-header">
          <h3>Edit Policy: {policy.policyNumber}</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label>Client</label>
            <select className="form-control" value={clientId} onChange={e => setClientId(e.target.value)}>
              <option value="">Select client...</option>
              {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label>Product</label>
            <select className="form-control" value={productId} onChange={e => setProductId(e.target.value)}>
              <option value="">Select product...</option>
              {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Status</label>
              <select className="form-control" value={status} onChange={e => setStatus(e.target.value as PolicyStatus)}>
                <option value="active">Active</option>
                <option value="waiting_period">Waiting Period</option>
                <option value="lapsed">Lapsed</option>
                <option value="pending">Pending</option>
                <option value="cancelled">Cancelled</option>
                <option value="expired">Expired</option>
              </select>
            </div>
            <div className="form-group">
              <label>Payment Method</label>
              <select className="form-control" value={paymentMethod} onChange={e => setPaymentMethod(e.target.value)}>
                {MANUAL_PAYMENT_METHODS.map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
          </div>
          {isAgriculture && (
            <div className="form-row">
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>Grower Number</label>
                <input className="form-control" placeholder="Grower registration number" value={growerNumber} onChange={e => setGrowerNumber(e.target.value)} />
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>Contractor</label>
                <input className="form-control" placeholder="The merchant the grower is contracted to" value={contractor} onChange={e => setContractor(e.target.value)} />
              </div>
              {/* Field Officer — tobacco industry language for the agent
                  on the grower book; same agent_id, agents only. */}
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>Field Officer</label>
                <select className="form-control" value={agentId} onChange={e => setAgentId(e.target.value)}>
                  <option value="">Unassigned</option>
                  {staff.filter(s => s.role === 'agent').map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>Hectarage</label>
                <select className="form-control" value={hectarage} onChange={e => setHectarage(e.target.value)}>
                  <option value="">Not recorded</option>
                  {HECTARAGE_OPTIONS.map(ha => <option key={ha} value={ha}>{hectarageLabel(ha)}</option>)}
                </select>
              </div>
            </div>
          )}
          <div className="form-group">
            <label>Next Payment Date</label>
            <DateInput value={nextPaymentDate} onChange={setNextPaymentDate} />
          </div>
          {/* On agriculture the agent is picked as Field Officer above —
              one agent_id, one picker. */}
          {!isAgriculture && (
          <div className="form-group">
            <label>Agent</label>
            <select className="form-control" value={agentId} onChange={e => setAgentId(e.target.value)}>
              <option value="">Unassigned</option>
              <optgroup label="Agents">
                {staff.filter(s => s.role === 'agent').map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </optgroup>
              <optgroup label="Office Staff">
                {staff.filter(s => s.role !== 'agent').map(s => <option key={s.id} value={s.id}>{s.name} ({s.role.replace(/_/g, ' ')})</option>)}
              </optgroup>
            </select>
          </div>
          )}
          <div className="form-row">
            <div className="form-group">
              <label>Premium</label>
              <input type="number" className="form-control" placeholder="Premium" value={premium} onChange={e => setPremium(e.target.value)} />
            </div>
            <div className="form-group">
              <label>Cover Amount</label>
              <input type="number" className="form-control" placeholder="Cover Amount" value={coverAmount} onChange={e => setCoverAmount(e.target.value)} />
            </div>
          </div>
          <div className="form-group">
            <label>End Date</label>
            <DateInput value={endDate} onChange={setEndDate} />
          </div>
          {!isAgriculture && (
            <div style={{ marginTop: '1rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <label>Dependants</label>
                <button type="button" className="btn btn-ghost btn-sm" onClick={addDependant}>+ Add Dependant</button>
              </div>
              {dependants.length === 0 ? (
                <p style={{ fontSize: 12, color: 'var(--muted)' }}>No dependants on this policy.</p>
              ) : (
                <>
                  <div className="new-policy-dependant-row" style={{ marginBottom: 4 }}>
                    <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>Name</span>
                    <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>Relationship</span>
                    <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>Date of Birth</span>
                    <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>ID / Birth Record No.</span>
                    <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>Plan</span>
                    <span />
                  </div>
                  {dependants.map((d, i) => (
                    <div key={i}>
                      <div className="new-policy-dependant-row" style={{ marginBottom: isMedical ? 4 : 8, alignItems: 'center' }}>
                        <input className="form-control" placeholder="Name" value={d.name} onChange={e => updateDependant(i, 'name', e.target.value)} />
                        <input className="form-control" placeholder="Relationship" value={d.relationship} onChange={e => updateDependant(i, 'relationship', e.target.value)} />
                        <DateInput value={d.dob} onChange={v => updateDependant(i, 'dob', v)} />
                        <input className="form-control" placeholder="ID (16+) or birth record no." value={d.nationalId} onChange={e => updateDependant(i, 'nationalId', e.target.value)} />
                        <select className="form-control" value={d.productId ?? ''} onChange={e => updateDependant(i, 'productId', e.target.value)} disabled={!product}>
                          <option value="">{product ? 'Select plan…' : 'Pick the product first'}</option>
                          {dependantPlanOptions.map(p => <option key={p.id} value={p.id}>{p.name} (${p.premium})</option>)}
                        </select>
                        <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} onClick={() => removeDependant(i)} title="Remove dependant">✕</button>
                      </div>
                      {isMedical && d.name.trim() && (
                        <div className="form-row" style={{ marginBottom: 8 }}>
                          <div className="form-group" style={{ marginBottom: 0 }}>
                            <label style={{ fontSize: 11 }}>Chronic illness for {d.name.trim()}?</label>
                            <select className="form-control" value={d.hasChronicIllness === undefined ? '' : d.hasChronicIllness ? 'yes' : 'no'}
                              onChange={e => updateDependant(i, 'hasChronicIllness', e.target.value === '' ? undefined : e.target.value === 'yes')}>
                              <option value="">Answer…</option>
                              <option value="yes">Yes</option>
                              <option value="no">No</option>
                            </select>
                          </div>
                          {d.hasChronicIllness && (
                            <div className="form-group" style={{ marginBottom: 0 }}>
                              <label style={{ fontSize: 11 }}>Condition(s)</label>
                              <input className="form-control" placeholder="e.g. Diabetes" value={d.chronicIllnessDetails ?? ''} onChange={e => updateDependant(i, 'chronicIllnessDetails', e.target.value)} />
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave}>Save Changes</button>
        </div>
      </div>
    </div>
  )
}
