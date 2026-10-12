import { useState, useEffect } from 'react'
import type { Client, AppUser } from '../../types'
import { db } from '../../lib/db'
import PhoneInput from '../ui/PhoneInput'
import DateInput from '../ui/DateInput'
import ValidationSummary, { MissingField, invalidClass, fieldId } from '../ui/ValidationSummary'
import { toIsoDate } from '../../lib/dateUtils'

interface Props {
  onClose: () => void
  onSave: (client: Client) => void
  /** The parent's already-loaded clients — lets the national-ID field warn
   *  about a duplicate before the database has to. */
  existingClients?: Client[]
}

export default function RegisterClientModal({ onClose, onSave, existingClients }: Props) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [nationalId, setNationalId] = useState('')
  const [gender, setGender] = useState('')
  const [genderOther, setGenderOther] = useState('')
  const [dob, setDob] = useState('')
  const [address, setAddress] = useState('')
  const [occupation, setOccupation] = useState('')
  // Optional: the agent who brought this client in. Deliberately NOT
  // defaulted to the current user — a registration here may be a direct
  // walk-in, and attributing those to whoever typed them up would corrupt
  // agent books.
  const [agentId, setAgentId] = useState('')
  const [agents, setAgents] = useState<AppUser[]>([])

  useEffect(() => {
    db.staff.list().then(({ data }) => setAgents((data ?? []).filter(s => s.active)))
  }, [])

  const [attempted, setAttempted] = useState(false)

  const missing: MissingField[] = []
  if (!name.trim()) missing.push({ key: 'name', label: 'Full Name' })
  if (!phone.trim()) missing.push({ key: 'phone', label: 'Phone Number' })
  if (!nationalId.trim()) missing.push({ key: 'nationalId', label: 'National ID' })
  // National ID is unique — warn before the database has to.
  const duplicateNatId = nationalId.trim()
    ? existingClients?.find(c => c.nationalId.toLowerCase() === nationalId.trim().toLowerCase())
    : undefined
  if (duplicateNatId) missing.push({ key: 'nationalId', label: 'National ID', hint: `Already registered to ${duplicateNatId.name}` })

  const handleSave = () => {
    setAttempted(true)
    if (missing.length > 0) return
    const client: Client = {
      id: `c${Date.now()}`,
      name, email, phone, nationalId, dob, address, occupation,
      gender: gender === 'other' ? genderOther.trim() || 'other' : gender || undefined,
      agentId: agentId || undefined,
      createdAt: toIsoDate(new Date()),
      policyCount: 0,
      status: 'active',
    }
    onSave(client)
  }

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-header">
          <h3>Register New Client</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <ValidationSummary missing={missing} attempted={attempted} />
          <div className="form-row">
            <div className="form-group" id={fieldId('name')}>
              <label>Full Name *</label>
              <input className={invalidClass(missing, attempted, 'name')} placeholder="e.g. John Doe" value={name} onChange={e => setName(e.target.value)} />
            </div>
            <div className="form-group">
              <label>Email Address</label>
              <input type="email" className="form-control" placeholder="john@email.com" value={email} onChange={e => setEmail(e.target.value)} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group" id={fieldId('phone')} style={attempted && !phone.trim() ? { outline: '1px solid var(--danger)', borderRadius: 7, outlineOffset: 2 } : undefined}>
              <label>Phone Number *</label>
              <PhoneInput value={phone} onChange={setPhone} />
            </div>
            <div className="form-group" id={fieldId('nationalId')}>
              <label>National ID *</label>
              <input className={invalidClass(missing, attempted, 'nationalId')} placeholder="e.g. 632118532K12" value={nationalId} onChange={e => setNationalId(e.target.value.replace(/-/g, ''))} />
              {duplicateNatId && (
                <p style={{ fontSize: 11, color: 'var(--danger)', marginTop: 4 }}>
                  Already registered to {duplicateNatId.name} — search their name on the Clients list.
                </p>
              )}
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Gender</label>
              <select className="form-control" value={gender} onChange={e => setGender(e.target.value)}>
                <option value="">Not specified</option>
                <option value="male">Male</option>
                <option value="female">Female</option>
                <option value="other">Other…</option>
              </select>
            </div>
            {gender === 'other' && (
              <div className="form-group">
                <label>Preferred gender</label>
                <input className="form-control" placeholder="e.g. non-binary" value={genderOther} onChange={e => setGenderOther(e.target.value)} />
              </div>
            )}
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Date of Birth</label>
              <DateInput value={dob} onChange={setDob} />
            </div>
            <div className="form-group">
              <label>Occupation</label>
              <input className="form-control" placeholder="e.g. Teacher" value={occupation} onChange={e => setOccupation(e.target.value)} />
            </div>
          </div>
          <div className="form-group">
            <label>Address</label>
            <input className="form-control" placeholder="Street address, city" value={address} onChange={e => setAddress(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Referred By — Agent</label>
            <select className="form-control" value={agentId} onChange={e => setAgentId(e.target.value)}>
              <option value="">None — direct client</option>
              {agents.map(a => <option key={a.id} value={a.id}>{a.name} ({a.role.replace(/_/g, ' ')})</option>)}
            </select>
            <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>Optional — only if an agent brought this client in. Any policy created for them later will carry the same agent.</p>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave}>
            Register Client
          </button>
        </div>
      </div>
    </div>
  )
}
