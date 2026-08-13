import { useState, useEffect, Fragment } from 'react'
import type { ToastMessage } from '../types'
import type { ActivePanel } from '../App'
import { db } from '../lib/db'
import type { ApiDeveloper, ApiKeyRow } from '../lib/db'
import { useAuth } from '../contexts/AuthContext'
import { API_TERMS_TEXT, API_TERMS_VERSION } from '../lib/apiTerms'
import { sendSystemEmail } from '../lib/mailService'
import { MAILBOXES } from '../lib/mailboxes'

const ALL_SCOPES = ['products:read', 'quotes:read', 'clients:write', 'policies:write', 'policies:read', 'payments:write']

const ENDPOINTS: { method: string; path: string; scope: string; desc: string }[] = [
  { method: 'GET', path: '/api/v1/products', scope: 'products:read', desc: 'List active insurance products available to sell.' },
  { method: 'POST', path: '/api/v1/quotes', scope: 'quotes:read', desc: 'Get a premium quote and eligibility check for a product.' },
  { method: 'POST', path: '/api/v1/clients', scope: 'clients:write', desc: 'Register a new client (or fetch an existing one by national ID).' },
  { method: 'POST', path: '/api/v1/policies', scope: 'policies:write', desc: 'Create a policy for a client. Attributed to the developer as agent.' },
  { method: 'GET', path: '/api/v1/policies/:policyNumber', scope: 'policies:read', desc: 'Look up a policy the developer created.' },
  { method: 'POST', path: '/api/v1/payments', scope: 'payments:write', desc: 'Record a premium payment against a policy.' },
  { method: 'POST', path: '/api/v1/tickets', scope: 'support:write (always granted)', desc: "File a support ticket for one of your clients — the only way to request a correction. There is no update/delete endpoint for clients or policies." },
]

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
  const [newKey, setNewKey] = useState<{ rawKey: string; publishableKey: string; environment: 'sandbox' | 'live'; developer: ApiDeveloper } | null>(null)
  const [sendingToPartner, setSendingToPartner] = useState(false)
  const [issueKeyFor, setIssueKeyFor] = useState<ApiDeveloper | null>(null)
  const [showDocs, setShowDocs] = useState(false)

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

  const handleIssueKey = async (dev: ApiDeveloper, opts: { scopes: string[]; rateLimitPerMin: number; environment: 'sandbox' | 'live' }) => {
    const { data, error } = await db.developerApi.issueKey(dev.id, opts)
    if (error || !data) { showToast('error', error ?? 'Failed to issue key.'); return }
    setNewKey({ rawKey: data.rawKey, publishableKey: data.publishableKey, environment: data.environment, developer: dev })
    setIssueKeyFor(null)
    const { data: keys } = await db.developerApi.listKeys(dev.id)
    setKeysByDeveloper(prev => ({ ...prev, [dev.id]: keys }))
  }

  const handleSendToPartner = async () => {
    if (!newKey) return
    setSendingToPartner(true)
    try {
      const { delivered, error } = await sendSystemEmail({
        from: MAILBOXES.admin,
        fromName: 'Tariqify IMS — Developer API',
        to: newKey.developer.contactEmail,
        subject: `Your API Credentials — ${newKey.environment === 'live' ? 'Live' : 'Sandbox'} Key`,
        body: `Hello,

Here are your API credentials for ${newKey.developer.companyName}'s integration (${newKey.environment} environment):

Publishable Key: ${newKey.publishableKey}
Secret Key: ${newKey.rawKey}

The secret key authorizes real requests and must be kept server-side only — never expose it in a browser, mobile app bundle, or public repository. Treat it exactly like a password. If it's ever compromised, contact us immediately to have it revoked and reissued.

Full API documentation is available on request.

Regards,
Tariqify IMS`,
      })
      if (delivered) showToast('success', `Credentials sent to ${newKey.developer.contactEmail}.`)
      else showToast('warning', error ?? 'Could not deliver the email — copy the keys manually instead.')
    } finally {
      setSendingToPartner(false)
    }
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

  const handleTerminate = async (dev: ApiDeveloper) => {
    const reason = window.prompt(
      `Permanently terminate ${dev.companyName}? This revokes all their active keys immediately and cannot be undone — they would need to be re-registered from scratch.\n\nEnter a reason for the record:`,
    )
    if (reason === null) return
    if (!reason.trim()) { showToast('warning', 'A termination reason is required.'); return }
    const { error } = await db.developerApi.terminateDeveloper(dev.id, reason.trim())
    if (error) { showToast('error', error); return }
    setDevelopers(prev => prev.map(d => d.id === dev.id ? { ...d, status: 'terminated', terminationReason: reason.trim() } : d))
    setKeysByDeveloper(prev => prev[dev.id] ? { ...prev, [dev.id]: prev[dev.id].map(k => ({ ...k, status: 'revoked' })) } : prev)
    showToast('success', `${dev.companyName} terminated. All their keys have been revoked.`)
  }

  const handleCommission = async (dev: ApiDeveloper, value: string) => {
    const pct = value.trim() === '' ? null : Number(value)
    const { error } = await db.developerApi.setCommissionOverride(dev.id, pct)
    if (error) { showToast('error', error); return }
    setDevelopers(prev => prev.map(d => d.id === dev.id ? { ...d, commissionOverridePercent: pct ?? undefined } : d))
  }

  return (
    <div className="panel">
      {!canEdit && (
        <div className="info-banner info-banner-warning" style={{ marginBottom: 16 }}>
          🔒 Read-only — only Super Admin or Admin accounts can register developers or issue keys.
        </div>
      )}

      <div className="panel-toolbar">
        <button className="btn btn-ghost" onClick={() => setShowDocs(true)}>📖 API Documentation</button>
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
                    <td>
                      <span className={`pill ${dev.status === 'active' ? 'pill-active' : dev.status === 'terminated' ? 'pill-cancelled' : 'pill-lapsed'}`}>{dev.status}</span>
                    </td>
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
                          {dev.status === 'terminated' && dev.terminationReason && (
                            <div className="info-banner info-banner-danger" style={{ marginBottom: 10 }}>
                              Terminated{dev.terminatedAt ? ` on ${new Date(dev.terminatedAt).toLocaleDateString('en-GB')}` : ''} — {dev.terminationReason}
                            </div>
                          )}
                          <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                            <button className="btn btn-primary btn-sm" onClick={() => setIssueKeyFor(dev)} disabled={!canEdit || dev.status === 'terminated'}>+ Issue New Key</button>
                            <button className="btn btn-ghost btn-sm" onClick={() => handleSuspend(dev)} disabled={!canEdit || dev.status === 'terminated'}>
                              {dev.status === 'active' ? 'Suspend Developer' : 'Reactivate Developer'}
                            </button>
                            {dev.status !== 'terminated' && (
                              <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} onClick={() => handleTerminate(dev)} disabled={!canEdit}>
                                Terminate Developer
                              </button>
                            )}
                          </div>
                          {(keysByDeveloper[dev.id]?.length ?? 0) === 0 ? (
                            <div className="empty-state" style={{ padding: '12px 0' }}>No keys issued yet.</div>
                          ) : (
                            <table className="table">
                              <thead><tr><th>Environment</th><th>Publishable Key</th><th>Secret Prefix</th><th>Scopes</th><th>Rate Limit</th><th>Status</th><th>Last Used</th><th></th></tr></thead>
                              <tbody>
                                {keysByDeveloper[dev.id].map(k => (
                                  <tr key={k.id}>
                                    <td><span className={`pill ${k.environment === 'live' ? 'pill-active' : 'pill-pending'}`}>{k.environment}</span></td>
                                    <td className="mono" style={{ fontSize: 11 }}>{k.publishableKey || '—'}</td>
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
            const { data, error } = await db.developerApi.createDeveloper({ ...input, termsVersion: API_TERMS_VERSION })
            if (error || !data) { showToast('error', error ?? 'Failed to register developer.'); return }
            setDevelopers(prev => [data, ...prev])
            setShowNew(false)
            showToast('success', `${data.companyName} registered. Issue them an API key to get started.`)
          }}
        />
      )}

      {issueKeyFor && (
        <IssueKeyModal
          developer={issueKeyFor}
          onClose={() => setIssueKeyFor(null)}
          onIssue={opts => handleIssueKey(issueKeyFor, opts)}
        />
      )}

      {showDocs && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 640 }}>
            <div className="modal-header">
              <h3>Developer API Documentation</h3>
              <button className="modal-close" onClick={() => setShowDocs(false)}>✕</button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
                Base URL: <code>/api/v1</code>. Every request needs <code>Authorization: Bearer &lt;api key&gt;</code>. Requests are rate-limited per key (default 60/min) and scoped to the calling developer's own clients and policies only.
              </p>
              <table className="table">
                <thead><tr><th>Method</th><th>Endpoint</th><th>Scope</th><th>Description</th></tr></thead>
                <tbody>
                  {ENDPOINTS.map(e => (
                    <tr key={e.path + e.method}>
                      <td className="mono" style={{ fontSize: 11 }}>{e.method}</td>
                      <td className="mono" style={{ fontSize: 11 }}>{e.path}</td>
                      <td style={{ fontSize: 11 }}>{e.scope}</td>
                      <td style={{ fontSize: 12 }}>{e.desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h4 style={{ margin: '16px 0 8px' }}>Security</h4>
              <ul style={{ fontSize: 12, color: 'var(--muted)', paddingLeft: 18, lineHeight: 1.7 }}>
                <li>HTTPS only. Keys must never be exposed in client-side code.</li>
                <li>A key is bound to one developer and can only ever see or modify that developer's own records.</li>
                <li>Exceeding the rate limit returns HTTP 429.</li>
                <li>Compromised keys should be revoked immediately from this page and reissued.</li>
              </ul>
            </div>
            <div className="modal-footer">
              <button className="btn btn-primary" onClick={() => setShowDocs(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {newKey && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 560 }}>
            <div className="modal-header">
              <h3>API Key Issued — <span style={{ textTransform: 'capitalize' }}>{newKey.environment}</span></h3>
              <button className="modal-close" onClick={() => setNewKey(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>Publishable Key <span style={{ fontWeight: 400, color: 'var(--muted)' }}>(safe to share, identifies the key)</span></label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input className="form-control mono" readOnly value={newKey.publishableKey} onFocus={e => e.target.select()} />
                  <button className="btn btn-ghost btn-sm" onClick={() => { navigator.clipboard?.writeText(newKey.publishableKey); showToast('success', 'Publishable key copied.') }}>Copy</button>
                </div>
              </div>
              <div className="info-banner info-banner-warning" style={{ margin: '14px 0' }}>
                ⚠ The secret key below is shown only once. Copy it now and hand it to the developer securely — it cannot be retrieved again.
              </div>
              <div className="form-group">
                <label>Secret Key</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input className="form-control mono" readOnly value={newKey.rawKey} onFocus={e => e.target.select()} />
                  <button className="btn btn-ghost btn-sm" onClick={() => { navigator.clipboard?.writeText(newKey.rawKey); showToast('success', 'Secret key copied.') }}>Copy</button>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setNewKey(null)}>Close</button>
              <button className="btn btn-primary" onClick={handleSendToPartner} disabled={sendingToPartner}>
                {sendingToPartner ? 'Sending…' : `✉ Send to Partner (${newKey.developer.contactEmail})`}
              </button>
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
  const [termsOpen, setTermsOpen] = useState(false)
  const [termsAccepted, setTermsAccepted] = useState(false)
  const [saving, setSaving] = useState(false)

  const canSave = companyName.trim() && contactEmail.trim() && termsAccepted

  const handleSave = async () => {
    if (!canSave) return
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
          {termsOpen && (
            <div className="form-group">
              <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: 12, fontSize: 11, whiteSpace: 'pre-wrap', color: 'var(--muted)', background: 'var(--surface)' }}>
                {API_TERMS_TEXT}
              </div>
            </div>
          )}
          <div className="form-group" style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <input type="checkbox" id="terms-accept" checked={termsAccepted} onChange={e => setTermsAccepted(e.target.checked)} style={{ marginTop: 3 }} />
            <label htmlFor="terms-accept" style={{ textTransform: 'none', fontSize: 12, fontWeight: 400, letterSpacing: 'normal' }}>
              This developer has read and agrees to the{' '}
              <button type="button" onClick={() => setTermsOpen(o => !o)} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--blue)', textDecoration: 'underline', cursor: 'pointer', fontSize: 12 }}>
                Developer API Terms of Use
              </button>.
            </label>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving || !canSave}>
            {saving ? 'Registering…' : 'Register Developer'}
          </button>
        </div>
      </div>
    </div>
  )
}

function IssueKeyModal({ developer, onClose, onIssue }: {
  developer: ApiDeveloper
  onClose: () => void
  onIssue: (opts: { scopes: string[]; rateLimitPerMin: number; environment: 'sandbox' | 'live' }) => Promise<void>
}) {
  const [scopes, setScopes] = useState<string[]>(ALL_SCOPES)
  const [rateLimitPerMin, setRateLimitPerMin] = useState(60)
  const [environment, setEnvironment] = useState<'sandbox' | 'live'>('live')
  const [issuing, setIssuing] = useState(false)

  const toggleScope = (scope: string) => {
    setScopes(prev => prev.includes(scope) ? prev.filter(s => s !== scope) : [...prev, scope])
  }

  const handleIssue = async () => {
    if (scopes.length === 0) return
    setIssuing(true)
    try {
      await onIssue({ scopes, rateLimitPerMin, environment })
    } finally {
      setIssuing(false)
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 480 }}>
        <div className="modal-header">
          <h3>Issue Key — {developer.companyName}</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label>Environment</label>
            <div className="bubble-toggle">
              <button type="button" className={`bubble-toggle-btn${environment === 'live' ? ' active' : ''}`} onClick={() => setEnvironment('live')}>Live</button>
              <button type="button" className={`bubble-toggle-btn${environment === 'sandbox' ? ' active' : ''}`} onClick={() => setEnvironment('sandbox')}>Sandbox</button>
            </div>
          </div>
          <div className="form-group">
            <label>Scopes (rights granted to this key)</label>
            {ALL_SCOPES.map(scope => (
              <div key={scope} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                <input type="checkbox" id={`scope-${scope}`} checked={scopes.includes(scope)} onChange={() => toggleScope(scope)} />
                <label htmlFor={`scope-${scope}`} style={{ textTransform: 'none', fontSize: 12, fontWeight: 400, letterSpacing: 'normal' }}>{scope}</label>
              </div>
            ))}
          </div>
          <div className="form-group">
            <label>Rate Limit (requests/min)</label>
            <input type="number" className="form-control" min={1} value={rateLimitPerMin} onChange={e => setRateLimitPerMin(Number(e.target.value))} />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleIssue} disabled={issuing || scopes.length === 0}>
            {issuing ? 'Issuing…' : 'Issue Key'}
          </button>
        </div>
      </div>
    </div>
  )
}
