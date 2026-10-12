import { useState } from 'react'
import type { Group, GroupType } from '../../types'
import PhoneInput from '../ui/PhoneInput'
import ValidationSummary, { MissingField, invalidClass, fieldId } from '../ui/ValidationSummary'

/** Display labels for the group's organisation type. */
export const GROUP_TYPE_LABEL: Record<GroupType, string> = {
  company: 'Company',
  church: 'Church',
  union: 'Union',
  sports: 'Sports Team/Club',
  club: 'Club',
  society: 'Society',
  other: 'Other',
}

/** Shown in lists/reports when the type is 'other' — the registrant's
 *  own label takes precedence over the generic word. */
export function groupTypeLabel(g: Pick<Group, 'groupType' | 'customType'>): string {
  return g.groupType === 'other' && g.customType ? g.customType : GROUP_TYPE_LABEL[g.groupType]
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
  const [customType, setCustomType] = useState(group?.customType ?? '')
  const [expectedMembers, setExpectedMembers] = useState(group?.expectedMembers !== undefined ? String(group.expectedMembers) : '')
  const [description, setDescription] = useState(group?.description ?? '')
  const [registrationNumber, setRegistrationNumber] = useState(group?.registrationNumber ?? '')
  const [orgPhone, setOrgPhone] = useState(group?.orgPhone ?? '')
  const [orgEmail, setOrgEmail] = useState(group?.orgEmail ?? '')
  const [address, setAddress] = useState(group?.address ?? '')
  const [contactName, setContactName] = useState(group?.contactName ?? '')
  const [contactPhone, setContactPhone] = useState(group?.contactPhone ?? '')
  const [contactEmail, setContactEmail] = useState(group?.contactEmail ?? '')

  const [attempted, setAttempted] = useState(false)

  // Number of Users is optional — the billed number is always the real
  // roster count, never this estimate.
  const memberCount = expectedMembers.trim() === '' ? NaN : Number(expectedMembers)

  const missing: MissingField[] = []
  if (!name.trim()) missing.push({ key: 'name', label: 'Organisation Name' })
  if (groupType === 'other' && !customType.trim()) missing.push({ key: 'customType', label: 'Custom Type', hint: 'Describe the organisation type in your own words' })
  if (expectedMembers.trim() !== '' && (!Number.isFinite(memberCount) || memberCount < 1)) missing.push({ key: 'expectedMembers', label: 'Number of Users', hint: 'Whole number, e.g. 25' })
  if (!orgPhone.trim() && !contactPhone.trim()) missing.push({ key: 'orgPhone', label: 'Organisation Phone', hint: 'At least one phone number — the org line or the representative' })
  if (!contactName.trim()) missing.push({ key: 'contactName', label: 'Representative Name', hint: 'Who we deal with on the organisation’s behalf' })

  const handleSave = () => {
    setAttempted(true)
    if (missing.length > 0) return
    onSave({
      name: name.trim(),
      groupType,
      customType: groupType === 'other' ? customType.trim() : undefined,
      expectedMembers: Number.isFinite(memberCount) && memberCount >= 1 ? memberCount : undefined,
      description: description.trim() || undefined,
      registrationNumber: registrationNumber.trim() || undefined,
      orgPhone: orgPhone.trim() || undefined,
      orgEmail: orgEmail.trim() || undefined,
      address: address.trim() || undefined,
      contactName: contactName.trim() || undefined,
      contactPhone: contactPhone.trim() || undefined,
      contactEmail: contactEmail.trim() || undefined,
    })
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 620 }}>
        <div className="modal-header">
          <h3>{group ? 'Edit Organisation' : 'Register Organisation'}</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="info-banner info-banner-info" style={{ marginBottom: '1rem' }}>
            A company covers its employees; a church, union or club covers its members; a team covers a named activity. Once registered, build the roster via Manage Members, then issue the organisation a Corporate, Group or Teams policy.
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
          {/* 'Other' never guesses for the registrant — they name it, and
              that label flows through to reports, claims and payments. */}
          {groupType === 'other' && (
            <div className="form-group" id={fieldId('customType')}>
              <label>Custom Type *</label>
              <input className={invalidClass(missing, attempted, 'customType')} value={customType} onChange={e => setCustomType(e.target.value)} placeholder="e.g. School, NGO, Burial Society, SACCO…" />
            </div>
          )}
          <div className="form-row">
            <div className="form-group" id={fieldId('expectedMembers')}>
              <label>Number of Users</label>
              <input
                type="number" min={1} className={invalidClass(missing, attempted, 'expectedMembers')}
                value={expectedMembers} onChange={e => setExpectedMembers(e.target.value)}
                placeholder={group?.memberCount ? `~${group.memberCount} on roster` : 'e.g. 25'}
              />
            </div>
            <div className="form-group">
              <label>Registration Number</label>
              <input className="form-control" value={registrationNumber} onChange={e => setRegistrationNumber(e.target.value)} placeholder="Company/organisation reg no." />
            </div>
          </div>
          <div className="form-group">
            <label>Description / Needs</label>
            <textarea
              className="form-control" rows={3} value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="What they want covered — demography, age ranges, the activity or group to be insured (e.g. travel insurance for a school educational tour, funeral cover for church members aged 18–65)…"
            />
          </div>

          <h4 style={{ margin: '0.5rem 0 0', fontSize: 13 }}>Organisation Contact</h4>
          <div className="form-row">
            <div className="form-group" id={fieldId('orgPhone')}>
              <label>Organisation Phone *</label>
              <div style={isMissingStyle(missing, attempted, 'orgPhone')}><PhoneInput value={orgPhone} onChange={setOrgPhone} /></div>
            </div>
            <div className="form-group">
              <label>Organisation Email</label>
              <input type="email" className="form-control" value={orgEmail} onChange={e => setOrgEmail(e.target.value)} placeholder="info@organisation.co.zw" />
            </div>
          </div>
          <div className="form-group">
            <label>Address</label>
            <input className="form-control" value={address} onChange={e => setAddress(e.target.value)} placeholder="Physical / postal address" />
          </div>

          <h4 style={{ margin: '0.5rem 0 0', fontSize: 13 }}>Representative (Contact Person)</h4>
          <div className="form-row">
            <div className="form-group" id={fieldId('contactName')}>
              <label>Full Name *</label>
              <input className={invalidClass(missing, attempted, 'contactName')} value={contactName} onChange={e => setContactName(e.target.value)} placeholder="HR officer, secretary, chairperson, coach" />
            </div>
            <div className="form-group">
              <label>Representative Phone</label>
              <PhoneInput value={contactPhone} onChange={setContactPhone} />
            </div>
          </div>
          <div className="form-group">
            <label>Representative Email</label>
            <input type="email" className="form-control" value={contactEmail} onChange={e => setContactEmail(e.target.value)} placeholder="person@organisation.co.zw" />
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

function isMissingStyle(missing: MissingField[], attempted: boolean, key: string) {
  return attempted && missing.some(m => m.key === key)
    ? { outline: '1px solid var(--danger)', borderRadius: 7, outlineOffset: 2 }
    : undefined
}
