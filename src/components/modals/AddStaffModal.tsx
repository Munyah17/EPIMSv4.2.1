import { useState, useEffect } from 'react'
import type { AppUser, UserRole, CustomRole, AgentProfile } from '../../types'
import { db } from '../../lib/db'
import PhoneInput from '../ui/PhoneInput'
import DateInput from '../ui/DateInput'
import ValidationSummary, { MissingField, invalidClass, fieldId, isMissing } from '../ui/ValidationSummary'
import { isNationalId, cleanNationalIdInput, isZwPhone, NATIONAL_ID_HINT, PHONE_HINT } from '../../lib/validation'

interface Props {
  staff: AppUser | null
  /** The agent file for the person being edited — loaded by the parent
   *  when the role is 'agent'. Agents are commission intermediaries, not
   *  employees: contract/KYC/payout fields show only for that role. */
  agentProfile?: AgentProfile | null
  /** Locks the role picker — opened from "+ Onboard Agent", the person
   *  is an agent, not a staff member being mis-categorised. */
  fixedRole?: UserRole
  onClose: () => void
  onSave: (staff: AppUser, password: string, agentInput?: Omit<AgentProfile, 'profileId'>) => void
  /** Only used in edit mode — sets a new password for an existing staff
   *  member (self-service Change Password needs their CURRENT password,
   *  which isn't something an admin resetting a locked-out account has). */
  onResetPassword: (staffId: string, newPassword: string) => Promise<void>
}

// Work roles only — Super Admin, Admin, and Tech Support are system access
// roles, managed on the System Access Roles page instead.
const ROLES: UserRole[] = ['claims_officer', 'policy_admin', 'finance', 'client_relations', 'agent']
const DEPARTMENTS = ['Claims', 'Policy Administration', 'Finance', 'Client Relations', 'Sales & Agents', 'Administration', 'IT']

export default function AddStaffModal({ staff, agentProfile, fixedRole, onClose, onSave, onResetPassword }: Props) {
  const [name, setName] = useState(staff?.name ?? '')
  const [email, setEmail] = useState(staff?.email ?? '')
  const [phone, setPhone] = useState(staff?.phone ?? '')
  const [role, setRole] = useState<UserRole>(staff?.role ?? fixedRole ?? 'client_relations')
  const [department, setDepartment] = useState(staff?.department ?? 'Client Relations')
  const [password, setPassword] = useState('')
  const [resetPwd, setResetPwd] = useState('')
  const [resettingPwd, setResettingPwd] = useState(false)
  const [customRoleId, setCustomRoleId] = useState(staff?.customRoleId ?? '')
  const [roles, setRoles] = useState<CustomRole[]>([])

  // ── The agent file — contract, territory, payout. Only meaningful for
  // role 'agent'; employees have a department instead.
  const [nationalId, setNationalId] = useState(agentProfile?.nationalId ?? '')
  const [territory, setTerritory] = useState(agentProfile?.territory ?? '')
  const [contractStart, setContractStart] = useState(agentProfile?.contractStart ?? '')
  const [commissionPct, setCommissionPct] = useState(agentProfile?.commissionPct != null ? String(agentProfile.commissionPct) : '')
  const [bankName, setBankName] = useState(agentProfile?.bankName ?? '')
  const [bankAccount, setBankAccount] = useState(agentProfile?.bankAccount ?? '')
  const [ecocashNumber, setEcocashNumber] = useState(agentProfile?.ecocashNumber ?? '')
  const [agentNotes, setAgentNotes] = useState(agentProfile?.notes ?? '')

  // The parent's async get() lands after mount — a slow agent-profile
  // read shouldn't wipe what the capturer already typed.
  useEffect(() => {
    if (!agentProfile) return
    setNationalId(prev => prev || agentProfile.nationalId || '')
    setTerritory(prev => prev || agentProfile.territory || '')
    setContractStart(prev => prev || agentProfile.contractStart || '')
    setCommissionPct(prev => prev || (agentProfile.commissionPct != null ? String(agentProfile.commissionPct) : ''))
    setBankName(prev => prev || agentProfile.bankName || '')
    setBankAccount(prev => prev || agentProfile.bankAccount || '')
    setEcocashNumber(prev => prev || agentProfile.ecocashNumber || '')
    setAgentNotes(prev => prev || agentProfile.notes || '')
  }, [agentProfile])

  useEffect(() => { db.customRoles.list().then(({ data }) => setRoles(data)) }, [])

  const isAgent = role === 'agent'

  // New accounts are real Supabase Auth users now, so a real password is
  // required — no more silent 'staff1234' default. Editing an existing
  // member can leave it blank (this modal doesn't change an existing
  // user's password; that's handled elsewhere).
  const [attempted, setAttempted] = useState(false)

  const passwordValid = staff ? true : password.length >= 8
  const missing: MissingField[] = []
  if (!name.trim()) missing.push({ key: 'name', label: 'Full Name' })
  // Agents are field intermediaries — email is optional for them (the
  // account still gets created; sign-in resolves by full name anyway).
  // Staff accounts still require it, and any address given is checked.
  if (!email.trim()) { if (!isAgent) missing.push({ key: 'email', label: 'Email Address' }) }
  else if (!/^\S+@\S+\.\S+$/.test(email.trim())) missing.push({ key: 'email', label: 'Email Address', hint: 'Not a valid email format' })
  if (!passwordValid) missing.push({ key: 'password', label: 'Temporary Password', hint: 'Minimum 8 characters' })
  // Optional fields still obey the national formats once anything is typed.
  if (phone.trim() && !isZwPhone(phone)) missing.push({ key: 'phone', label: 'Phone Number', hint: PHONE_HINT })
  if (isAgent && nationalId.trim() && !isNationalId(nationalId)) missing.push({ key: 'nationalId', label: 'National ID', hint: NATIONAL_ID_HINT })
  if (isAgent && ecocashNumber.trim() && !isZwPhone(ecocashNumber)) missing.push({ key: 'ecocash', label: 'EcoCash Number', hint: PHONE_HINT })

  const handleSave = () => {
    setAttempted(true)
    if (missing.length > 0) return
    // Only snapshot the role's permissions in when the custom role selection
    // actually changed — otherwise re-saving this form for an unrelated edit
    // (e.g. phone number) would silently wipe out any manual permission
    // tweaks made afterwards via PermissionsModal.
    const roleChanged = customRoleId !== (staff?.customRoleId ?? '')
    const selectedRole = roleChanged ? roles.find(r => r.id === customRoleId) : undefined
    // A brand-new account with no custom role picked still needs a sane
    // default: Admin gets full access short of the two hard-gated Super
    // Admin-only actions (same 'all_except_super' sentinel AuthContext's
    // own fallback already uses), matching the 2026-08 access review.
    // Other staff roles default to none — granted explicitly via the
    // Permissions modal or a custom role, same as before this feature.
    const defaultPermissions = !staff ? (role === 'admin' ? ['all_except_super'] : []) : (staff.permissions ?? [])
    const member: AppUser = {
      id: staff?.id ?? '',
      name, email, phone, role, department: isAgent ? 'Sales & Agents' : department,
      active: staff?.active ?? true,
      permissions: selectedRole ? selectedRole.permissions : defaultPermissions,
      customRoleId: customRoleId || undefined,
    }
    const agentInput: Omit<AgentProfile, 'profileId'> | undefined = isAgent ? {
      nationalId: nationalId.trim() || undefined,
      territory: territory.trim() || undefined,
      contractStart: contractStart || undefined,
      commissionPct: commissionPct.trim() !== '' && Number.isFinite(Number(commissionPct)) ? Number(commissionPct) : undefined,
      bankName: bankName.trim() || undefined,
      bankAccount: bankAccount.trim() || undefined,
      ecocashNumber: ecocashNumber.trim() || undefined,
      notes: agentNotes.trim() || undefined,
    } : undefined
    onSave(member, password, agentInput)
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 520 }}>
        <div className="modal-header">
          <h3>{staff ? (isAgent ? 'Edit Agent' : 'Edit Staff Member') : (isAgent ? 'Onboard Agent' : 'Add Staff Member')}</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <ValidationSummary missing={missing} attempted={attempted} />
          <div className="form-row">
            <div className="form-group" id={fieldId('name')}>
              <label>Full Name *</label>
              <input className={invalidClass(missing, attempted, 'name')} value={name} onChange={e => setName(e.target.value)} placeholder="Full name — also the sign-in name" />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group" id={fieldId('email')}>
              <label>Email Address {!isAgent && '*'}</label>
              <input type="email" className={invalidClass(missing, attempted, 'email')} value={email} onChange={e => setEmail(e.target.value)} placeholder="staff@tariqify.com" />
            </div>
            <div className="form-group" id={fieldId('phone')} style={isMissing(missing, attempted, 'phone') ? { outline: '1px solid var(--danger)', borderRadius: 7, outlineOffset: 2 } : undefined}>
              <label>Phone Number</label>
              <PhoneInput value={phone} onChange={setPhone} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Role *</label>
              <select className="form-control" value={role} onChange={e => setRole(e.target.value as UserRole)} disabled={!!fixedRole}>
                {ROLES.map(r => <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>)}
              </select>
              {isAgent && (
                <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                  Agents are commission-based field intermediaries, not employees — they onboard clients and capture policies for commission.
                </p>
              )}
            </div>
            {!isAgent && (
              <div className="form-group">
                <label>Department</label>
                <select className="form-control" value={department} onChange={e => setDepartment(e.target.value)}>
                  {DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
            )}
          </div>
          {isAgent && (
            <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '0.9rem', marginBottom: '0.75rem' }}>
              <div className="form-row">
                <div className="form-group" id={fieldId('nationalId')}>
                  <label>National ID</label>
                  <input className={invalidClass(missing, attempted, 'nationalId')} value={nationalId} onChange={e => setNationalId(cleanNationalIdInput(e.target.value))} placeholder="e.g. 632118532K12" />
                </div>
                <div className="form-group">
                  <label>Territory / Area</label>
                  <input className="form-control" value={territory} onChange={e => setTerritory(e.target.value)} placeholder="e.g. Norton, Chipinge, Bindura" />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Contract Start</label>
                  <DateInput value={contractStart} onChange={setContractStart} />
                </div>
                <div className="form-group">
                  <label>Commission % (override)</label>
                  <input type="number" min={0} max={100} step="0.5" className="form-control" value={commissionPct} onChange={e => setCommissionPct(e.target.value)} placeholder="Blank = product default" />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Bank Name</label>
                  <input className="form-control" value={bankName} onChange={e => setBankName(e.target.value)} placeholder="Payout bank" />
                </div>
                <div className="form-group">
                  <label>Account Number</label>
                  <input className="form-control" value={bankAccount} onChange={e => setBankAccount(e.target.value)} placeholder="Payout account" />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group" id={fieldId('ecocash')} style={isMissing(missing, attempted, 'ecocash') ? { outline: '1px solid var(--danger)', borderRadius: 7, outlineOffset: 2 } : undefined}>
                  <label>EcoCash Number</label>
                  <PhoneInput value={ecocashNumber} onChange={setEcocashNumber} />
                </div>
                <div className="form-group">
                  <label>Notes</label>
                  <input className="form-control" value={agentNotes} onChange={e => setAgentNotes(e.target.value)} placeholder="Onboarding notes" />
                </div>
              </div>
            </div>
          )}
          <div className="form-group">
            <label>Custom Role (optional)</label>
            <select className="form-control" value={customRoleId} onChange={e => setCustomRoleId(e.target.value)}>
              <option value="">None (default permissions for this role)</option>
              {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          <div className="form-row">
            <div className="form-group" id={fieldId('password')}>
              <label>{staff ? 'Reset Password' : 'Temporary Password *'}</label>
              {staff ? (
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="password"
                    className="form-control"
                    value={resetPwd}
                    onChange={e => setResetPwd(e.target.value)}
                    placeholder="New password, min. 8 characters"
                  />
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={resetPwd.length < 8 || resettingPwd}
                    onClick={async () => {
                      setResettingPwd(true)
                      await onResetPassword(staff.id, resetPwd)
                      setResetPwd('')
                      setResettingPwd(false)
                    }}
                  >
                    {resettingPwd ? 'Resetting…' : 'Reset'}
                  </button>
                </div>
              ) : (
                <input type="password" className={invalidClass(missing, attempted, 'password')} value={password} onChange={e => setPassword(e.target.value)} placeholder="Min. 8 characters" />
              )}
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave}>
            {staff ? 'Save Changes' : isAgent ? 'Onboard Agent' : 'Add Staff Member'}
          </button>
        </div>
      </div>
    </div>
  )
}
