import { useState } from 'react'
import type { ToastMessage } from '../types'
import type { ActivePanel } from '../App'
import { getNotifSettings, saveNotifSettings, DEFAULT_NOTIF_SETTINGS, type SmsRecipient } from '../lib/mailService'
import type { NotifSettings } from '../lib/mailService'
import { db } from '../lib/db'
import { useAuth } from '../contexts/AuthContext'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
  setActivePanel: (panel: ActivePanel) => void
}

export default function NotificationSettings({ showToast }: Props) {
  const { user } = useAuth()
  const canEdit = user?.role === 'super_admin' || user?.role === 'admin'
  const [settings, setSettings] = useState<NotifSettings>(() => getNotifSettings())
  const [saving, setSaving] = useState(false)
  const [savingSms, setSavingSms] = useState(false)

  const update = (key: keyof NotifSettings, value: string | boolean | SmsRecipient[]) => {
    if (!canEdit) return
    setSettings(prev => ({ ...prev, [key]: value }))
  }

  const handleSave = async () => {
    if (!canEdit) return
    setSaving(true)
    const { error } = await db.settings.set('notif_settings', settings)
    setSaving(false)
    if (error) { showToast('error', `Failed to save: ${error}`); return }
    saveNotifSettings(settings)
    showToast('success', 'Notification settings saved, now shared with every staff member.')
  }

  const handleSaveSmsRecipients = async () => {
    if (!canEdit) return
    setSavingSms(true)
    const { error } = await db.settings.set('notif_settings', settings)
    setSavingSms(false)
    if (error) { showToast('error', `Failed to save SMS recipients: ${error}`); return }
    saveNotifSettings(settings)
    showToast('success', 'SMS recipients saved and now active for all notification events.')
  }

  const handleReset = async () => {
    if (!canEdit) return
    const confirmed = window.confirm('Reset all notification settings to defaults?')
    if (!confirmed) return
    setSettings({ ...DEFAULT_NOTIF_SETTINGS })
    const { error } = await db.settings.set('notif_settings', DEFAULT_NOTIF_SETTINGS)
    if (error) { showToast('error', `Failed to reset: ${error}`); return }
    saveNotifSettings({ ...DEFAULT_NOTIF_SETTINGS })
    showToast('info', 'Settings reset to defaults.')
  }

  return (
    <div>
      {!canEdit && (
        <div className="info-banner info-banner-warning" style={{ marginBottom: 14 }}>
          🔒 Read-only: only Super Admin or Admin accounts can change notification settings.
        </div>
      )}
      <div className="panel-toolbar">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" onClick={handleReset} disabled={!canEdit}>Reset to Defaults</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving || !canEdit}>
            {saving ? 'Saving…' : 'Save Settings'}
          </button>
        </div>
      </div>

      <fieldset className="notif-settings-layout" disabled={!canEdit} style={{ border: 'none', padding: 0, margin: 0 }}>
        {/* Insurer */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">🏢 Insurer Notifications</span>
          </div>
          <p className="notif-settings-desc">
            A single mailbox that gets copied on every new policy.
          </p>
          <div className="form-row">
            <div className="form-group">
              <label>Label</label>
              <input
                className="form-control"
                value={settings.insurerName}
                onChange={e => update('insurerName', e.target.value)}
                placeholder="e.g. Underwriting Desk"
              />
            </div>
            <div className="form-group">
              <label>Insurer Email</label>
              <input
                className="form-control"
                type="email"
                value={settings.insurerEmail}
                onChange={e => update('insurerEmail', e.target.value)}
                placeholder="claims@insurer.co.zw"
              />
            </div>
            <div className="form-group">
              <label>Insurer Phone (SMS)</label>
              <input
                className="form-control"
                value={settings.insurerPhone}
                onChange={e => update('insurerPhone', e.target.value)}
                placeholder="+263..."
              />
            </div>
          </div>
        </div>

        {/* NetOne Insurance (suspended) */}
        <div className="card" style={{ opacity: 0.6 }}>
          <div className="card-header">
            <span className="card-title">📡 NetOne Insurance</span>
            <span className="pill pill-lapsed">Suspended</span>
          </div>
          <p className="notif-settings-desc">
            The NetOne distribution partnership is suspended for now; these details are kept but no claim notifications are sent here while suspended.
          </p>
          <div className="form-row">
            <div className="form-group">
              <label>NetOne Email</label>
              <input
                className="form-control"
                type="email"
                value={settings.netoneEmail}
                onChange={e => update('netoneEmail', e.target.value)}
                placeholder="insurance@netone.co.zw"
                disabled
              />
            </div>
            <div className="form-group">
              <label>NetOne Phone (SMS)</label>
              <input
                className="form-control"
                value={settings.netonePhone}
                onChange={e => update('netonePhone', e.target.value)}
                placeholder="+263..."
                disabled
              />
            </div>
          </div>
        </div>

        {/* Company / document branding */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">🏢 Company Details (Policy Documents)</span>
          </div>
          <p className="notif-settings-desc">
            Shown in the header of the Policy Report/Certificate PDF. Left blank by default rather than guessed.
          </p>
          <div className="form-group">
            <label>Company Address</label>
            <input className="form-control" value={settings.companyAddress} onChange={e => update('companyAddress', e.target.value)} placeholder="Street address, city" disabled={!canEdit} />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Company Phone</label>
              <input className="form-control" value={settings.companyPhone} onChange={e => update('companyPhone', e.target.value)} placeholder="+263..." disabled={!canEdit} />
            </div>
            <div className="form-group">
              <label>Company Email</label>
              <input className="form-control" type="email" value={settings.companyEmail} onChange={e => update('companyEmail', e.target.value)} disabled={!canEdit} />
            </div>
          </div>
        </div>

        {/* SMS recipients by event type */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">📱 SMS Recipients</span>
            <button 
              className="btn btn-primary btn-sm" 
              onClick={handleSaveSmsRecipients} 
              disabled={savingSms || !canEdit}
              style={{ marginLeft: 'auto' }}
            >
              {savingSms ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
          <p className="notif-settings-desc">
            Add phone numbers and select which notification types they receive. Blank numbers are ignored.
          </p>
          <div style={{ marginBottom: 12 }}>
            <button className="btn btn-outline btn-sm" onClick={() => {
              const newRecipient: SmsRecipient = {
                id: Date.now().toString(),
                phone: '',
                events: []
              }
              update('smsRecipients', [...settings.smsRecipients, newRecipient])
            }}>
              + Add Recipient
            </button>
          </div>
          {settings.smsRecipients.map((recipient, index) => (
            <div key={recipient.id} style={{ 
              padding: '12px', 
              border: '1px solid var(--border)', 
              borderRadius: 8, 
              marginBottom: 8,
              background: index % 2 === 0 ? 'var(--bg-alt)' : 'transparent'
            }}>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: 12, marginBottom: 4, display: 'block' }}>Phone Number</label>
                  <input
                    className="form-control"
                    value={recipient.phone}
                    onChange={e => {
                      const updated = [...settings.smsRecipients]
                      updated[index] = { ...recipient, phone: e.target.value }
                      update('smsRecipients', updated)
                    }}
                    placeholder="+263..."
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                  <button 
                    className="btn btn-danger btn-sm"
                    onClick={() => {
                      const updated = settings.smsRecipients.filter((_, i) => i !== index)
                      update('smsRecipients', updated)
                    }}
                  >
                    Remove
                  </button>
                </div>
              </div>
              <div>
                <label style={{ fontSize: 12, marginBottom: 4, display: 'block' }}>Notification Types</label>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  {[
                    { key: 'registration', label: 'Registrations' },
                    { key: 'payment', label: 'Payments' },
                    { key: 'claim', label: 'Claims' },
                    { key: 'system', label: 'System Alerts' }
                  ].map(event => (
                    <label key={event.key} className="checkbox-label" style={{ fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={recipient.events.includes(event.key as any)}
                        onChange={e => {
                          const updated = [...settings.smsRecipients]
                          const events = e.target.checked
                            ? [...recipient.events, event.key as any]
                            : recipient.events.filter(e => e !== event.key)
                          updated[index] = { ...recipient, events }
                          update('smsRecipients', updated)
                        }}
                      />
                      {event.label}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          ))}
          {settings.smsRecipients.length === 0 && (
            <div className="empty-state" style={{ padding: '20px 0' }}>No SMS recipients configured.</div>
          )}
        </div>

        {/* Sender config */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">✉ Email Sender Configuration</span>
          </div>
          <p className="notif-settings-desc">
            The From address and display name used in all outgoing notification emails.
          </p>
          <div className="form-row">
            <div className="form-group">
              <label>From Address</label>
              <input
                className="form-control"
                type="email"
                value={settings.fromAddress}
                onChange={e => update('fromAddress', e.target.value)}
                placeholder="noreply@tariqify.com"
              />
            </div>
            <div className="form-group">
              <label>From Name</label>
              <input
                className="form-control"
                value={settings.fromName}
                onChange={e => update('fromName', e.target.value)}
                placeholder="Tariqify IMS"
              />
            </div>
          </div>
          <div className="form-group">
            <label>Reply-To Address</label>
            <input
              className="form-control"
              type="email"
              value={settings.replyTo}
              onChange={e => update('replyTo', e.target.value)}
              placeholder="admin@motions.co.zw"
            />
            <p className="notif-settings-desc" style={{ marginTop: 4 }}>
              The From address above is noreply; replies to any outgoing notification land here instead.
            </p>
          </div>
        </div>

        {/* SMS & Signature */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">⚙ Advanced Settings</span>
          </div>

          <div className="form-group" style={{ marginBottom: 16 }}>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={settings.smsEnabled}
                onChange={e => update('smsEnabled', e.target.checked)}
              />
              Enable SMS notifications (requires SMS gateway integration)
            </label>
            {settings.smsEnabled && (
              <div className="info-banner info-banner-warning" style={{ marginTop: 8, borderRadius: 7, padding: '8px 12px', fontSize: 12 }}>
                SMS gateway not yet configured. Emails will still be sent.
              </div>
            )}
          </div>

          <div className="form-group">
            <label>Email Signature</label>
            <textarea
              className="form-control"
              rows={4}
              value={settings.signature}
              onChange={e => update('signature', e.target.value)}
              placeholder="Regards,&#10;Tariqify Insurance Management System"
            />
          </div>
        </div>

        {/* Preview */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">👁 Notification Flow Preview</span>
          </div>
          <div className="notif-flow">
            <div className="notif-flow-step">
              <div className="notif-flow-icon" style={{ background: '#DCE4FB' }}>📋</div>
              <div>
                <div className="notif-flow-label">Claim Created / Updated</div>
                <div className="notif-flow-sub">Triggered automatically</div>
              </div>
            </div>
            <div className="notif-flow-arrow">↓</div>
            <div className="notif-flow-step">
              <div className="notif-flow-icon" style={{ background: '#D1FAE5' }}>✉</div>
              <div>
                <div className="notif-flow-label">2 Emails Sent Simultaneously</div>
                <div className="notif-flow-sub">Both parties CC'd on every message · NetOne suspended, not included</div>
              </div>
            </div>
            <div className="notif-flow-arrow">↓</div>
            <div className="notif-flow-recipients">
              <div className="notif-flow-recipient">
                <span className="notif-flow-recipient-name">🏢 {settings.insurerName}</span>
                <span className="notif-flow-recipient-email">{settings.insurerEmail || 'Not configured'}</span>
              </div>
              <div className="notif-flow-recipient">
                <span className="notif-flow-recipient-name">👤 Client</span>
                <span className="notif-flow-recipient-email">Loaded from client record</span>
              </div>
            </div>
          </div>
        </div>
      </fieldset>
    </div>
  )
}
