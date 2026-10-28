import { useState, useEffect } from 'react'
import type { Client } from '../../types'
import { db } from '../../lib/db'
import PhoneInput from '../ui/PhoneInput'
import DateInput from '../ui/DateInput'
import ValidationSummary, { MissingField, invalidClass, fieldId } from '../ui/ValidationSummary'

interface Props {
  client: Client
  onClose: () => void
  onSave: (client: Client) => void
  onAssignPolicy: () => void
}

export default function EditClientModal({ client, onClose, onSave, onAssignPolicy }: Props) {
  const [name, setName] = useState(client.name)
  const [email, setEmail] = useState(client.email)
  const [phone, setPhone] = useState(client.phone)
  const [address, setAddress] = useState(client.address)
  const [occupation, setOccupation] = useState(client.occupation ?? '')
  const [gender, setGender] = useState(client.gender === 'male' || client.gender === 'female' || !client.gender ? client.gender ?? '' : 'other')
  const [genderOther, setGenderOther] = useState(client.gender && client.gender !== 'male' && client.gender !== 'female' ? client.gender : '')
  const [status, setStatus] = useState(client.status)
  const [dob, setDob] = useState(client.dob ?? '')
  const [nationalId, setNationalId] = useState(client.nationalId ?? '')

  // Portal login — the account's email is the client record's email (RLS
  // binds them), so provisioning needs the SAVED email, not whatever is
  // being typed into the field above.
  const [portalPassword, setPortalPassword] = useState('')
  const [portalBusy, setPortalBusy] = useState(false)
  const [portalMsg, setPortalMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [portalExists, setPortalExists] = useState<boolean | null>(null)

  useEffect(() => {
    if (!client.email?.trim()) { setPortalExists(null); return }
    db.clients.portalAccountExists(client.email).then(setPortalExists)
  }, [client.email])

  const emailDirty = email.trim().toLowerCase() !== (client.email ?? '').trim().toLowerCase()

  const handleSetPortalPassword = async () => {
    if (portalPassword.length < 8) { setPortalMsg({ ok: false, text: 'Password must be at least 8 characters.' }); return }
    setPortalBusy(true)
    setPortalMsg(null)
    const { created, error } = await db.clients.setPortalPassword(client.id, portalPassword)
    setPortalBusy(false)
    if (error) { setPortalMsg({ ok: false, text: error }); return }
    setPortalExists(true)
    setPortalPassword('')
    setPortalMsg({ ok: true, text: created ? `Login created — they sign in with ${client.email} or their full name.` : 'Password updated.' })
  }

  const [attempted, setAttempted] = useState(false)

  const missing: MissingField[] = []
  if (!name.trim()) missing.push({ key: 'name', label: 'Full Name' })
  if (!phone.trim()) missing.push({ key: 'phone', label: 'Phone' })
  // ID and DOB are never optional — the National ID field is locked
  // (identity doesn't change), and DOB must stay filled once captured.
  if (!dob) missing.push({ key: 'dob', label: 'Date of Birth' })

  const handleSave = () => {
    setAttempted(true)
    if (missing.length > 0) return
    // Ensure phone is not empty string (database requires NOT NULL)
    const phoneValue = phone.trim() || client.phone
    onSave({ ...client, name: name.trim(), email, phone: phoneValue, address, occupation, status, dob, nationalId: nationalId.trim(), gender: gender === 'other' ? genderOther.trim() || 'other' : gender || undefined })
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 520 }}>
        <div className="modal-header">
          <h3>Edit Client</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <ValidationSummary missing={missing} attempted={attempted} />
          <div className="form-row">
            <div className="form-group" id={fieldId('name')}>
              <label>Full Name *</label>
              <input className={invalidClass(missing, attempted, 'name')} value={name} onChange={e => setName(e.target.value)} />
            </div>
            <div className="form-group">
              <label>Email</label>
              <input type="email" className="form-control" value={email} onChange={e => setEmail(e.target.value)} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group" id={fieldId('phone')} style={attempted && !phone.trim() ? { outline: '1px solid var(--danger)', borderRadius: 7, outlineOffset: 2 } : undefined}>
              <label>Phone *</label>
              <PhoneInput value={phone} onChange={setPhone} />
            </div>
            <div className="form-group">
              <label>National ID</label>
              <input className="form-control" value={nationalId} onChange={e => setNationalId(e.target.value)} placeholder="16-digit ID number" />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group" id={fieldId('dob')} style={attempted && !dob ? { outline: '1px solid var(--danger)', borderRadius: 7, outlineOffset: 2 } : undefined}>
              <label>Date of Birth *</label>
              <DateInput value={dob} onChange={setDob} />
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
              <label>Occupation</label>
              <input className="form-control" value={occupation} onChange={e => setOccupation(e.target.value)} />
            </div>
            <div className="form-group">
              <label>Status</label>
              <select className="form-control" value={status} onChange={e => setStatus(e.target.value as Client['status'])}>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>
          </div>
          <div className="form-group">
            <label>Address</label>
            <input className="form-control" value={address} onChange={e => setAddress(e.target.value)} />
          </div>

          {/* ── CLIENT PORTAL ACCESS ── */}
          <div style={{ borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 12 }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Client Portal Login</label>
              {!client.email?.trim() ? (
                <p style={{ fontSize: 11, color: 'var(--muted)', margin: 0 }}>
                  Save an email first — the client signs in to the portal with that email or their full name.
                </p>
              ) : emailDirty ? (
                <p style={{ fontSize: 11, color: 'var(--warning)', margin: 0 }}>
                  The email change isn't saved yet — save first, then set the portal password (the login binds to the saved email).
                </p>
              ) : (
                <>
                  <p style={{ fontSize: 11, color: 'var(--muted)', margin: '0 0 6px' }}>
                    {portalExists === null
                      ? 'Checking portal account…'
                      : portalExists
                        ? `Portal account active — signs in as ${client.email} or “${client.name}”.`
                        : `No portal account yet — set a password to create one for ${client.email}.`}
                  </p>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input
                      className="form-control"
                      style={{ flex: 1 }}
                      type="text"
                      autoComplete="off"
                      placeholder="New password — min 8 characters"
                      value={portalPassword}
                      onChange={e => setPortalPassword(e.target.value)}
                    />
                    <button type="button" className="btn btn-primary btn-sm" onClick={handleSetPortalPassword} disabled={portalBusy}>
                      {portalBusy ? 'Saving…' : portalExists ? 'Reset Password' : 'Create Login'}
                    </button>
                  </div>
                  {portalMsg && (
                    <p style={{ fontSize: 11, color: portalMsg.ok ? 'var(--success)' : 'var(--danger)', margin: '6px 0 0' }}>
                      {portalMsg.text}
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-success" onClick={onAssignPolicy}>+ Assign Policy</button>
          <button className="btn btn-primary" onClick={handleSave}>Save Changes</button>
        </div>
      </div>
    </div>
  )
}
