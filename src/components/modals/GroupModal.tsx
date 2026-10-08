import { useState } from 'react'
import type { Group, GroupType } from '../../types'
import PhoneInput from '../ui/PhoneInput'
import ValidationSummary, { MissingField, invalidClass, fieldId } from '../ui/ValidationSummary'

/** Display labels for the group's organisation type. */
export const GROUP_TYPE_LABEL: Record<GroupType, string> = {
  company: 'Company',
  church: 'Church',
  union: 'Union',
  sports: 'Sports Club',
  club: 'Club',
  society: 'Society',
  other: 'Other',
}

/** What the modal hands back — everything editable on a group. `active`
 *  is managed from the list row (Enable/Disable), not this form. */
export type GroupInput = Omit<Group, 'id' | 'memberCount' | 'createdAt' | 'active'>

interface Props {
  group: Group | null
  onClose: () => void
  onSave: (input: GroupInput) => void
}

export default function GroupModal({ group, onClose, onSave }: Props) {
  const [name, setName] = useState(group?.name ?? '')
  const [groupType, setGroupType] = useState<GroupType>(group?.groupType ?? 'company')
  const [registrationNumber, setRegistrationNumber] = useState(group?.registrationNumber ?? '')
  const [contactName, setContactName] = useState(group?.contactName ?? '')
  const [contactEmail, setContactEmail] = useState(group?.contactEmail ?? '')
  const [contactPhone, setContactPhone] = useState(group?.contactPhone ?? '')
  const [address, setAddress] = useState(group?.address ?? '')

  const [attempted, setAttempted] = useState(false)

  const missing: MissingField[] = []
  if (!name.trim()) missing.push({ key: 'name', label: 'Organisation Name' })

  const handleSave = () => {
    setAttempted(true)
    if (missing.length > 0) return
    onSave({
      name: name.trim(),
      groupType,
      registrationNumber: registrationNumber.trim() || undefined,
      contactName: contactName.trim() || undefined,
      contactEmail: contactEmail.trim() || undefined,
      contactPhone: contactPhone.trim() || undefined,
      address: address.trim() || undefined,
    })
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 520 }}>
        <div className="modal-header">
          <h3>{group ? 'Edit Organisation' : 'Register Organisation'}</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="info-banner info-banner-info" style={{ marginBottom: '1rem' }}>
            A company covers its employees; a church, union or club covers its members. Once registered, build the roster via Manage Members, then issue the organisation a Corporate or Group policy.
          </div>
          <ValidationSummary missing={missing} attempted={attempted} />
          <div className="form-row">
            <div className="form-group" id={fieldId('name')}>
              <label>Organisation Name *</label>
              <input className={invalidClass(missing, attempted, 'name')} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Acme Pvt Ltd, Glen View Church" />
            </div>
            <div className="form-group">
              <label>Type *</label>
              <select className="form-control" value={groupType} onChange={e => setGroupType(e.target.value as GroupType)}>
                {(Object.keys(GROUP_TYPE_LABEL) as GroupType[]).map(t => (
                  <option key={t} value={t}>{GROUP_TYPE_LABEL[t]}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Registration Number</label>
              <input className="form-control" value={registrationNumber} onChange={e => setRegistrationNumber(e.target.value)} placeholder="Company/organisation reg no." />
            </div>
            <div className="form-group">
              <label>Contact Person</label>
              <input className="form-control" value={contactName} onChange={e => setContactName(e.target.value)} placeholder="HR officer, secretary, chairperson" />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Contact Phone</label>
              <PhoneInput value={contactPhone} onChange={setContactPhone} />
            </div>
            <div className="form-group">
              <label>Contact Email</label>
              <input type="email" className="form-control" value={contactEmail} onChange={e => setContactEmail(e.target.value)} placeholder="accounts@company.co.zw" />
            </div>
          </div>
          <div className="form-group">
            <label>Address</label>
            <input className="form-control" value={address} onChange={e => setAddress(e.target.value)} placeholder="Physical address" />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave}>
            {group ? 'Save Changes' : 'Register Organisation'}
          </button>
        </div>
      </div>
    </div>
  )
}
