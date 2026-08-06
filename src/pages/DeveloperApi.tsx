import { useState, useEffect, Fragment } from 'react'
import type { ToastMessage } from '../types'
import type { ActivePanel } from '../App'
import { db } from '../lib/db'
import type { ApiDeveloper, ApiKeyRow } from '../lib/db'
import { useAuth } from '../contexts/AuthContext'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
  setActivePanel: (panel: ActivePanel) => void
}

export default function DeveloperApi({ showToast }: Props) {
  const { user } = useAuth()
  const canEdit = user?.role === 'super_admin' || user?.role === 'admin'
  const [developers, setDevelopers] = useState<ApiDeveloper[]>([])
  const [keysByDeveloper, setKeysByDeveloper] = useState<Record<string, ApiKeyRow[]>>({})
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [newRawKey, setNewRawKey] = useState<string | null>(null)

  const load = () => {
    db.developerApi.listDevelopers().then(({ data, error }) => {
      if (error) showToast('error', 'Failed to load developers.')
      setDevelopers(data)
      setLoading(false)
    })
  }

  useEffect(load, [])

  const toggleExpand = async (dev: ApiDeveloper) => {
    if (expanded === dev.id) { setExpanded(null); return }
    setExpanded(dev.id)
    if (!keysByDeveloper[dev.id]) {
      const { data } = await db.developerApi.listKeys(dev.id)
      setKeysByDeveloper(prev => ({ ...prev, [dev.id]: data }))
    }
  }

  const handleIssueKey = async (dev: ApiDeveloper) => {
    const { data, error } = await db.developerApi.issueKey(dev.id)
    if (error || !data) { showToast('error', error ?? 'Failed to issue key.'); return }
    setNewRawKey(data.rawKey)
    const { data: keys } = await db.developerApi.listKeys(dev.id)
    setKeysByDeveloper(prev => ({ ...prev, [dev.id]: keys }))
  }

  const handleRevoke = async (keyId: string, developerId: string) => {
    if (!window.confirm('Revoke this API key? Any app using it will immediately lose access.')) return
    const { error } = await db.developerApi.revokeKey(keyId)
    if (error) { showToast('error', error); return }
    const { data: keys } = await db.developerApi.listKeys(developerId)
    setKeysByDeveloper(prev => ({ ...prev, [developerId]: keys }))
    showToast('success', 'Key revoked.')
  }

  const handleSuspend = async (dev: ApiDeveloper) => {
    const next = dev.status === 'active' ? 'suspended' : 'active'
    const { error } = await db.developerApi.setDeveloperStatus(dev.id, next)
    if (error) { showToast('error', error); return }
    setDevelopers(prev => prev.map(d => d.id === dev.id ? { ...d, status: next } : d))
    showToast('success', `${dev.companyName} ${next === 'active' ? 'reactivated' : 'suspended'}.`)
  }

  const handleCommission = async (dev: ApiDeveloper, value: string) => {
    const pct = value.trim() === '' ? null : Number(value)
    const { error } = await db.developerApi.setCommissionOverride(dev.id, pct)
    if (error) { showToast('error', error); return }
    setDevelopers(prev => prev.map(d => d.id === dev.id ? { ...d, commissionOverridePercent: pct ?? undefined } : d))
  }

  return (
    <div className="panel">
      <div className="info-banner info-banner-info" style={{ marginBottom: 16 }}>
        🔌 External developers integrate with <code>/api/v1/…</code> using an issued API key to sell your insurance products through their own apps. Every policy they create is attributed to them as an agent, so their commission is tracked automatically using the rate below (or the default rate set in Settings → Agent Commission).
      </div>

      {!canEdit && (
        <div className="info-banner info-banner-warning" style={{ marginBottom: 16 }}>
          🔒 Read-only — only Super Admin or Admin accounts can register developers or issue keys.
        </div>
      )}

      <div className="panel-toolbar">
        <div />
        <button className="btn btn-primary" onClick={() => setShowNew(true)} disabled={!canEdit}>+ New Developer</button>
      </div>

      <div className="card">
        {loading ? (
          <div className="empty-state">Loading developers…</div>
        ) : developers.length === 0 ? (
          <div className="empty-state">No API developers registered yet.</div>
        ) : (
          <table className="table">
            <thead>
              <tr><th>Company</th><th>Contact</th><th>Status</th><th>Commission Override</th><th>Keys</th><th></th></tr>
            </thead>
            <tbody>
              {developers.map(dev => (
                <Fragment key={dev.id}>
                  <tr>
                    <td><strong>{dev.companyName}</strong></td>
                    <td>{dev.contactEmail}{dev.contactPhone ? ` · ${dev.contactPhone}` : ''}</td>
                    <td><span className={`pill ${dev.status === 'active' ? 'pill-active' : 'pill-lapsed'}`}>{dev.status}</span></td>
                    <td>
                      <input
                        className="form-control"
                        style={{ width: 90 }}
                        type="number"
                        placeholder="default"
                        disabled={!canEdit}
                        defaultValue={dev.commissionOverridePercent ?? ''}
                        onBlur={e => handleCommission(dev, e.target.value)}
                      />
                    </td>
                    <td>{keysByDeveloper[dev.id]?.filter(k => k.status === 'active').length ?? '—'}</td>
                    <td>
                      <button className="btn btn-ghost btn-sm" onClick={() => toggleExpand(dev)}>{expanded === dev.id ? 'Hide' : 'Manage'}</button>
                    </td>
                  </tr>
                  {expanded === dev.id && (
                    <tr>
                      <td colSpan={6}>
                        <div style={{ padding: '10px 0' }}>
                          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                            <button className="btn btn-primary btn-sm" onClick={() => handleIssueKey(dev)} disabled={!canEdit}>+ Issue New Key</button>
                            <button className="btn btn-ghost btn-sm" onClick={() => handleSuspend(dev)} disabled={!canEdit}>
                              {dev.status === 'active' ? 'Suspend Developer' : 'Reactivate Developer'}
                            </button>
                          </div>
                          {(keysByDeveloper[dev.id]?.length ?? 0) === 0 ? (
                            <div className="empty-state" style={{ padding: '12px 0' }}>No keys issued yet.</div>
                          ) : (
                            <table className="table">
                              <thead><tr><th>Prefix</th><th>Scopes</th><th>Rate Limit</th><th>Status</th><th>Last Used</th><th></th></tr></thead>
                              <tbody>
                                {keysByDeveloper[dev.id].map(k => (
                                  <tr key={k.id}>
                                    <td className="mono">{k.keyPrefix}…</td>
                                    <td style={{ fontSize: 11 }}>{k.scopes.join(', ')}</td>
                                    <td>{k.rateLimitPerMin}/min</td>
                                    <td><span className={`pill ${k.status === 'active' ? 'pill-active' : 'pill-lapsed'}`}>{k.status}</span></td>
                                    <td>{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString('en-GB') : 'Never'}</td>
                                    <td>
                                      {k.status === 'active' && (
                                        <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} onClick={() => handleRevoke(k.id, dev.id)} disabled={!canEdit}>Revoke</button>
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showNew && (
        <NewDeveloperModal
          onClose={() => setShowNew(false)}
          onSave={async input => {
            const { data, error } = await db.developerApi.createDeveloper(input)
            if (error || !data) { showToast('error', error ?? 'Failed to register developer.'); return }
            setDevelopers(prev => [data, ...prev])
            setShowNew(false)
            showToast('success', `${data.companyName} registered. Issue them an API key to get started.`)
          }}
        />
      )}

      {newRawKey && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 520 }}>
            <div className="modal-header">
              <h3>API Key Issued</h3>
              <button className="modal-close" onClick={() => setNewRawKey(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="info-banner info-banner-warning" style={{ marginBottom: 14 }}>
                ⚠ This is shown only once. Copy it now and hand it to the developer securely — it cannot be retrieved again.
              </div>
              <div className="form-group">
                <label>API Key</label>
                <input className="form-control mono" readOnly value={newRawKey} onFocus={e => e.target.select()} />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-primary" onClick={() => { navigator.clipboard?.writeText(newRawKey); showToast('success', 'Copied to clipboard.') }}>Copy</button>
              <button className="btn btn-ghost" onClick={() => setNewRawKey(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function NewDeveloperModal({ onClose, onSave }: { onClose: () => void; onSave: (input: { companyName: string; contactEmail: string; contactPhone?: string }) => void }) {
  const [companyName, setCompanyName] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    if (!companyName.trim() || !contactEmail.trim()) return
    setSaving(true)
    try {
      await onSave({ companyName: companyName.trim(), contactEmail: contactEmail.trim(), contactPhone: contactPhone.trim() || undefined })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 480 }}>
        <div className="modal-header">
          <h3>New API Developer</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label>Company / App Name *</label>
            <input className="form-control" value={companyName} onChange={e => setCompanyName(e.target.value)} placeholder="e.g. QuickCover App" />
          </div>
          <div className="form-group">
            <label>Contact Email *</label>
            <input className="form-control" type="email" value={contactEmail} onChange={e => setContactEmail(e.target.value)} placeholder="dev@company.com" />
          </div>
          <div className="form-group">
            <label>Contact Phone</label>
            <input className="form-control" value={contactPhone} onChange={e => setContactPhone(e.target.value)} placeholder="optional" />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving || !companyName.trim() || !contactEmail.trim()}>
            {saving ? 'Registering…' : 'Register Developer'}
          </button>
        </div>
      </div>
    </div>
  )
}
