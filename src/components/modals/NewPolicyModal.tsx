import { useState } from 'react'
import type { Policy, Beneficiary, Insurer, Client } from '../../types'
import { PRODUCTS } from '../../data/mockData'
import { db } from '../../lib/db'

const INSURERS: Insurer[] = ['Motions', 'CBZ Life', 'EcoSure', 'ZB Life', 'Nyaradzo Funeral', 'Doves']

interface Props {
  onClose: () => void
  onSave: (policy: Policy) => void
  showToast?: (type: 'success' | 'error' | 'warning' | 'info', message: string) => void
}

export default function NewPolicyModal({ onClose, onSave, showToast }: Props) {
  // Client fields
  const [clientName, setClientName] = useState('')
  const [clientPhone, setClientPhone] = useState('')
  const [clientEmail, setClientEmail] = useState('')
  const [clientNationalId, setClientNationalId] = useState('')
  const [clientDob, setClientDob] = useState('')
  const [clientAddress, setClientAddress] = useState('')
  const [clientOccupation, setClientOccupation] = useState('')
  const [clientInsurer, setClientInsurer] = useState<Insurer | ''>('')
  
  // Policy fields
  const [productId, setProductId] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('OneMoney')
  const [policyInsurer, setPolicyInsurer] = useState<Insurer | ''>('')
  const [startDate, setStartDate] = useState(new Date().toISOString().split('T')[0])
  const [beneficiaries, setBeneficiaries] = useState<Beneficiary[]>([
    { name: '', relationship: '', percentage: 100 }
  ])
  const product = PRODUCTS.find(p => p.id === productId)

  const addBeneficiary = () => {
    setBeneficiaries(prev => [...prev, { name: '', relationship: '', percentage: 0 }])
  }

  const updateBeneficiary = (i: number, field: keyof Beneficiary, value: string | number) => {
    setBeneficiaries(prev => prev.map((b, idx) => idx === i ? { ...b, [field]: value } : b))
  }

  const handleSave = async () => {
    if (!clientName || !clientPhone || !clientNationalId || !productId) {
      if (showToast) showToast('error', 'Please fill in all required fields.')
      return
    }
    
    // Create new client first
    const newClient: Client = {
      id: `c${Date.now()}`,
      name: clientName,
      email: clientEmail,
      phone: clientPhone,
      nationalId: clientNationalId,
      dob: clientDob,
      address: clientAddress,
      occupation: clientOccupation,
      insurer: clientInsurer || undefined,
      createdAt: new Date().toISOString().split('T')[0],
      policyCount: 0,
      status: 'active',
    }
    
    const { data: createdClient, error: clientError } = await db.clients.create(newClient)
    if (clientError || !createdClient) {
      if (showToast) showToast('error', 'Failed to create client.')
      return
    }
    
    // Create policy with the new client
    const policyNumber = `EMA-${new Date().getFullYear()}-${String(Date.now()).slice(-3)}`
    const endDate = new Date(startDate)
    endDate.setFullYear(endDate.getFullYear() + 1)
    const policy: Policy = {
      id: `pol${Date.now()}`,
      policyNumber,
      clientId: createdClient.id,
      clientName: createdClient.name,
      productId,
      productName: product!.name,
      premium: product!.premium,
      coverAmount: product!.coverAmount,
      startDate,
      endDate: endDate.toISOString().split('T')[0],
      status: 'active',
      beneficiaries,
      paymentMethod,
      insurer: policyInsurer || undefined,
      createdAt: new Date().toISOString().split('T')[0],
      nextPaymentDate: new Date(new Date(startDate).setMonth(new Date(startDate).getMonth() + 1)).toISOString().split('T')[0],
    }
    onSave(policy)
  }

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-header">
          <h3>New Policy (New Customer)</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <h4 style={{ marginBottom: '1rem', marginTop: 0 }}>Customer Information</h4>
          <div className="form-row">
            <div className="form-group">
              <label>Full Name *</label>
              <input className="form-control" placeholder="Enter full name" value={clientName} onChange={e => setClientName(e.target.value)} />
            </div>
            <div className="form-group">
              <label>Phone Number *</label>
              <input className="form-control" placeholder="e.g. +263 777 123 456" value={clientPhone} onChange={e => setClientPhone(e.target.value)} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Email</label>
              <input type="email" className="form-control" placeholder="email@example.com" value={clientEmail} onChange={e => setClientEmail(e.target.value)} />
            </div>
            <div className="form-group">
              <label>National ID *</label>
              <input className="form-control" placeholder="e.g. 12-345678-A-12" value={clientNationalId} onChange={e => setClientNationalId(e.target.value)} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Date of Birth</label>
              <input type="date" className="form-control" value={clientDob} onChange={e => setClientDob(e.target.value)} />
            </div>
            <div className="form-group">
              <label>Occupation</label>
              <input className="form-control" placeholder="e.g. Teacher" value={clientOccupation} onChange={e => setClientOccupation(e.target.value)} />
            </div>
          </div>
          <div className="form-group">
            <label>Address</label>
            <input className="form-control" placeholder="Street address, city" value={clientAddress} onChange={e => setClientAddress(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Client Insurer</label>
            <select className="form-control" value={clientInsurer} onChange={e => setClientInsurer(e.target.value as Insurer)}>
              <option value="">Select insurer…</option>
              {INSURERS.map(i => <option key={i} value={i}>{i}</option>)}
            </select>
          </div>
          
          <h4 style={{ marginBottom: '1rem', marginTop: '1.5rem' }}>Policy Information</h4>
          <div className="form-row">
            <div className="form-group">
              <label>Product *</label>
              <select className="form-control" value={productId} onChange={e => setProductId(e.target.value)}>
                <option value="">Select product…</option>
                {PRODUCTS.filter(p => p.active).map(p => <option key={p.id} value={p.id}>{p.name} — ${p.premium}/mo</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>Start Date *</label>
              <input type="date" className="form-control" value={startDate} onChange={e => setStartDate(e.target.value)} />
            </div>
          </div>
          {product && (
            <div className="info-banner info-banner-info" style={{ marginBottom: '1rem' }}>
              Cover: ${product.coverAmount.toLocaleString()} · Premium: ${product.premium}/mo · Commission: {product.commissionPct}%
            </div>
          )}
          <div className="form-row">
            <div className="form-group">
              <label>Payment Method *</label>
              <select className="form-control" value={paymentMethod} onChange={e => setPaymentMethod(e.target.value)}>
                {['OneMoney', 'InnBucks', 'Airtime Balance', 'Bank Transfer', 'Cash', 'Debit Order', 'EcoCash'].map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label>Policy Insurer</label>
              <select className="form-control" value={policyInsurer} onChange={e => setPolicyInsurer(e.target.value as Insurer)}>
                <option value="">Select insurer…</option>
                {INSURERS.map(i => <option key={i} value={i}>{i}</option>)}
              </select>
            </div>
          </div>

          <div style={{ marginTop: '1rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <label>Beneficiaries</label>
              <button type="button" className="btn btn-ghost btn-sm" onClick={addBeneficiary}>+ Add</button>
            </div>
            {beneficiaries.map((b, i) => (
              <div key={i} className="form-row" style={{ marginBottom: 8 }}>
                <input className="form-control" placeholder="Name" value={b.name} onChange={e => updateBeneficiary(i, 'name', e.target.value)} />
                <input className="form-control" placeholder="Relationship" value={b.relationship} onChange={e => updateBeneficiary(i, 'relationship', e.target.value)} />
                <input className="form-control" type="number" placeholder="%" min={0} max={100} value={b.percentage} onChange={e => updateBeneficiary(i, 'percentage', Number(e.target.value))} style={{ width: 80 }} />
              </div>
            ))}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={!clientName || !clientPhone || !clientNationalId || !productId}>
            Create Policy & Register Client
          </button>
        </div>
      </div>
    </div>
  )
}
