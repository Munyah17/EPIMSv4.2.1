import { useState } from 'react'
import type { ToastMessage } from '../types'
import type { ActivePanel } from '../App'
import { getNotifSettings, saveNotifSettings, DEFAULT_NOTIF_SETTINGS } from '../lib/mailService'
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

  const update = (key: keyof NotifSettings, value: string | boolean) => {
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
    showToast('success', 'Notification settings saved — now shared with every staff member.')
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
    <div className="panel">
      {!canEdit && (
        <div className="info-banner info-banner-warning" style={{ marginBottom: 14 }}>
          🔒 Read-only — only Super Admin or Admin accounts can change notification settings.
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
            <span className="card-title">🏢 Insurer — Motions Microinsurance</span>
          </div>
          <p className="notif-settings-desc">
            Receives all claim notifications. This is the primary underwriter for all policies.
          </p>
          <div className="form-row">
            <div className="form-group">
              <label>Insurer Name</label>
              <input
                className="form-control"
                value={settings.insurerName}
                onChange={e => update('insurerName', e.target.value)}
                placeholder="e.g. Motions Microinsurance"
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

        {/* NetOne Insurance */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">📡 NetOne Insurance</span>
          </div>
          <p className="notif-settings-desc">
            Distribution partner. Receives claim notifications for all policies distributed via NetOne USSD.
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
              />
            </div>
            <div className="form-group">
              <label>NetOne Phone (SMS)</label>
              <input
                className="form-control"
                value={settings.netonePhone}
                onChange={e => update('netonePhone', e.target.value)}
                placeholder="+263..."
              />
            </div>
          </div>
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
                <div className="notif-flow-label">3 Emails Sent Simultaneously</div>
                <div className="notif-flow-sub">All 3 parties CC'd on every message</div>
              </div>
            </div>
            <div className="notif-flow-arrow">↓</div>
            <div className="notif-flow-recipients">
              <div className="notif-flow-recipient">
                <span className="notif-flow-recipient-name">🏢 {settings.insurerName}</span>
                <span className="notif-flow-recipient-email">{settings.insurerEmail || 'Not configured'}</span>
              </div>
              <div className="notif-flow-recipient">
                <span className="notif-flow-recipient-name">📡 NetOne Insurance</span>
                <span className="notif-flow-recipient-email">{settings.netoneEmail || 'Not configured'}</span>
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
