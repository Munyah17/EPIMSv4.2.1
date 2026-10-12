import { useState, useEffect } from 'react'
import type { Policy, PolicyStatus, AppUser } from '../../types'
import { MANUAL_PAYMENT_METHODS } from '../../types'
import { db } from '../../lib/db'
import { HECTARAGE_OPTIONS, hectarageLabel } from '../../lib/productUtils'
import DateInput from '../ui/DateInput'

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
  const [staff, setStaff] = useState<AppUser[]>([])
  const [isAgriculture, setIsAgriculture] = useState(false)

  useEffect(() => {
    db.staff.list().then(({ data }) => { if (data) setStaff(data.filter(s => s.active)) })
    db.products.list().then(({ data }) => {
      const category = data?.find(p => p.id === policy.productId)?.category
      setIsAgriculture(category === 'agriculture')
    })
  }, [policy.productId])

  const handleSave = () => {
    const agent = staff.find(s => s.id === agentId)
    onSave({
      ...policy, status, paymentMethod, nextPaymentDate: nextPaymentDate || undefined,
      agentId: agentId || undefined, agentName: agent?.name ?? (agentId ? policy.agentName : undefined),
      growerNumber: isAgriculture ? (growerNumber || undefined) : policy.growerNumber,
      contractor: isAgriculture ? (contractor.trim() || undefined) : policy.contractor,
      hectarage: isAgriculture ? (hectarage ? Number(hectarage) : undefined) : policy.hectarage,
    })
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 500 }}>
        <div className="modal-header">
          <h3>Edit Policy: {policy.policyNumber}</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label>Client</label>
            <input className="form-control" value={policy.clientName} disabled style={{ opacity: 0.6 }} />
          </div>
          <div className="form-group">
            <label>Product</label>
            <input className="form-control" value={policy.productName} disabled style={{ opacity: 0.6 }} />
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
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave}>Save Changes</button>
        </div>
      </div>
    </div>
  )
}
