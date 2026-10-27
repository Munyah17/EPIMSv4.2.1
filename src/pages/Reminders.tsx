import { useState, useEffect } from 'react'
import type { ToastMessage, Reminder, Policy } from '../types'
import type { ActivePanel } from '../App'
import { db } from '../lib/db'
import { formatDate } from '../lib/dateUtils'
import { sendSms, type SmsContext } from '../lib/smsService'
import { policyBillablePremium } from '../lib/premium'
import { premiumReminderSms, policyLapsedSms, smsDate } from '../lib/smsText'
import { supabase } from '../lib/supabase'
import { resolveSmsText, smsVarMoney } from '../lib/smsTemplates'
import { sendSystemEmail } from '../lib/mailService'
import { MAILBOXES } from '../lib/mailboxes'
import { COMPANY_NAME } from '../lib/company'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
  setActivePanel: (panel: ActivePanel) => void
}

const TYPE_ICON: Record<string, string> = {
  payment_due: '💳',
  policy_renewal: '🔄',
  claim_followup: '📋',
  birthday: '🎂',
  document_expiry: '📄',
}

interface ReminderSettings {
  paymentDays: number
  renewalDays: number
  channel: Reminder['channel']
  birthdayGreetings: boolean
}
const DEFAULT_SETTINGS: ReminderSettings = { paymentDays: 3, renewalDays: 30, channel: 'sms', birthdayGreetings: true }

export default function Reminders({ showToast }: Props) {
  const [reminders, setReminders] = useState<Reminder[]>([])
  const [policies, setPolicies] = useState<Policy[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'overdue' | 'renewals' | 'log' | 'settings'>('overdue')
  const [settings, setSettings] = useState<ReminderSettings>(DEFAULT_SETTINGS)
  const [savingSettings, setSavingSettings] = useState(false)
  const [sending, setSending] = useState(false)

  useEffect(() => {
    Promise.all([db.reminders.list(), db.policies.list()]).then(([remRes, polRes]) => {
      if (remRes.error) showToast('error', 'Failed to load reminders.')
      else if (remRes.data) setReminders(remRes.data)
      if (polRes.error) showToast('error', 'Failed to load policies — the renewals tab may be incomplete.')
      else if (polRes.data) setPolicies(polRes.data)
      setLoading(false)
    }).catch(() => { showToast('error', 'Failed to load reminders.'); setLoading(false) })
    db.settings.get<ReminderSettings>('reminder_settings').then(saved => {
      if (saved) setSettings({ ...DEFAULT_SETTINGS, ...saved })
    })
  }, [showToast])

  const overdue = reminders.filter(r => !r.sent && new Date(r.dueDate) <= new Date())
  const upcoming = reminders.filter(r => !r.sent && new Date(r.dueDate) > new Date())
  const sent = reminders.filter(r => r.sent)

  // Agriculture is excluded like both reminder engines do — a grower's
  // premium is a yearly stop order settled by the association, so a
  // "pay to keep cover"/"pay to reinstate" text lands on the wrong
  // payer. Farmers get registration and claim texts only.
  const isAgri = (p: Policy) => p.productCategory === 'agriculture'
  const lapsingPolicies = policies.filter(p => (p.status === 'lapsed' || p.status === 'defaulted') && !isAgri(p))
  const upcomingRenewals = policies.filter(p => {
    const diff = (new Date(p.endDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    return diff <= 30 && diff > 0 && p.status === 'active' && !isAgri(p)
  })

  /** A "Send" here is a real dispatch — the reminder actually goes out over
   *  SMS and/or email before the row is marked sent, and a delivery failure
   *  is reported rather than toasted away. Returns the channel that reached
   *  the client first, or null when nothing was delivered. */
  const dispatchToClient = async (clientId: string, clientName: string, subject: string, body: string, smsText?: string, ctx?: SmsContext): Promise<'sms' | 'email' | null> => {
    const { data: client } = await db.clients.get(clientId)
    if (!client || (!client.phone && !client.email)) {
      showToast('warning', `No phone or email on file for ${clientName} — reminder not sent.`)
      return null
    }
    if (client.phone) {
      // smsText is the verbatim SMS (an engine-sent reminder re-sends its
      // stored sms_body — the same message the client already received);
      // the email-style body doubles as SMS only when none exists.
      try { if ((await sendSms(client.phone, smsText ?? body, ctx)).success) return 'sms' } catch { /* fall through to email */ }
    }
    if (client.email) {
      const { delivered } = await sendSystemEmail({ from: MAILBOXES.noreply, to: client.email, subject, body })
      if (delivered) return 'email'
    }
    return null
  }

  /** system_payment_due messages already carry the real text (minus the
   *  internal [Rn]/[FNL] stage tag used for dedup); compose the rest. */
  const reminderMessage = (r: Reminder): string => {
    const tagless = r.message.replace(/^\[[^\]]+\]\s*/, '')
    switch (r.type) {
      case 'birthday':       return `Dear ${r.clientName}, happy birthday from the Motions team!`
      case 'policy_renewal': return `Dear ${r.clientName}, your policy ${r.policyNumber ?? ''} renews on ${formatDate(r.dueDate)}. Please contact us to continue your cover.`
      case 'payment_due':    return `Dear ${r.clientName}, your premium payment for ${r.policyNumber ?? 'your policy'} is due on ${formatDate(r.dueDate)}. Please pay to keep your cover active.`
      default:               return `Dear ${r.clientName}, ${tagless}`
    }
  }

  const dispatchReminder = async (r: Reminder): Promise<boolean> => {
    const channel = await dispatchToClient(r.clientId, r.clientName, `${COMPANY_NAME} — policy reminder`, reminderMessage(r), r.smsBody,
      { event: r.type === 'payment_due' ? 'payment' : r.type === 'policy_renewal' ? 'renewal' : 'system', ref: r.policyNumber ?? undefined })
    if (!channel) return false
    await db.reminders.markSent(r.id, reminderMessage(r))
    return true
  }

  const sendReminder = async (r: Reminder) => {
    if (sending) return
    setSending(true)
    try {
      if (await dispatchReminder(r)) {
        setReminders(prev => prev.map(x => x.id === r.id ? { ...x, sent: true } : x))
        showToast('success', `Reminder sent to ${r.clientName}.`)
      } else {
        showToast('error', `Reminder to ${r.clientName} could not be delivered — nothing was sent. Check the SMS gateway and email settings.`)
      }
    } finally { setSending(false) }
  }

  const sendAll = async () => {
    const unsent = [...overdue, ...upcoming]
    if (unsent.length === 0) { showToast('info', 'No pending reminders to send.'); return }
    if (sending) return
    setSending(true)
    try {
      const sentIds = new Set<string>()
      for (const r of unsent) { if (await dispatchReminder(r)) sentIds.add(r.id) }
      setReminders(prev => prev.map(x => sentIds.has(x.id) ? { ...x, sent: true } : x))
      if (sentIds.size === unsent.length) showToast('success', `${sentIds.size} reminders sent.`)
      else showToast('warning', `${sentIds.size} of ${unsent.length} reminders sent — the rest could not be delivered.`)
    } finally { setSending(false) }
  }

  const sendRenewalReminder = async (p: Policy) => {
    if (sending) return
    setSending(true)
    try {
      const body = p.status === 'lapsed' || p.status === 'defaulted'
        ? `Dear ${p.clientName}, your ${p.productName} policy ${p.policyNumber} has lapsed. Please contact us to reinstate your cover.`
        : `Dear ${p.clientName}, your ${p.productName} policy ${p.policyNumber} renews on ${formatDate(p.endDate)}. Please contact us to continue your cover.`
      const { data: c } = await db.clients.get(p.clientId)
      const smsInput = { clientName: p.clientName, policyNumber: p.policyNumber, amount: policyBillablePremium(p), dueDate: new Date(p.endDate), clientPhone: c?.phone }
      const lapsed = p.status === 'lapsed' || p.status === 'defaulted'
      const smsText = await resolveSmsText(supabase, lapsed ? 'policy_lapsed' : 'premium_reminder', {
        productId: p.productId,
        vars: {
          clientName: p.clientName,
          policyNumber: p.policyNumber,
          productName: p.productName,
          amount: smsVarMoney(smsInput.amount),
          dueDate: smsDate(smsInput.dueDate),
        },
        fallback: lapsed ? policyLapsedSms(smsInput) : premiumReminderSms(smsInput),
      })
      const channel = await dispatchToClient(p.clientId, p.clientName, `${COMPANY_NAME} — renewal reminder`, body, smsText,
        { event: 'renewal', ref: p.policyNumber })
      if (!channel) {
        showToast('error', `Renewal reminder for ${p.clientName} could not be delivered — nothing was sent.`)
        return
      }
      const { data } = await db.reminders.create({
        type: 'policy_renewal', clientId: p.clientId, clientName: p.clientName, policyId: p.id, policyNumber: p.policyNumber,
        dueDate: p.endDate, message: `[Manual] Renewal reminder sent to client: ${p.policyNumber} renews on ${formatDate(p.endDate)}`,
        smsBody: smsText,
        sent: true, channel,
      })
      if (data) setReminders(prev => [...prev, data])
      showToast('success', `Renewal reminder sent to ${p.clientName} via ${channel === 'sms' ? 'SMS' : 'email'}.`)
    } finally { setSending(false) }
  }

  const saveSettings = async () => {
    setSavingSettings(true)
    const { error } = await db.settings.set('reminder_settings', settings)
    setSavingSettings(false)
    if (error) showToast('error', `Could not save reminder settings: ${error}`)
    else showToast('success', 'Reminder settings saved.')
  }

  const channelPill = (ch: string) => (
    <span className="pill pill-active pill-xs">{ch}</span>
  )

  const tabs: [typeof activeTab, string][] = [
    ['overdue', `Overdue (${overdue.length})`],
    ['renewals', `Renewals (${upcomingRenewals.length})`],
    ['log', `Sent Log (${sent.length})`],
    ['settings', 'Settings'],
  ]

  return (
    <div className="panel">
      <div className="tabs">
        {tabs.map(([t, label]) => (
          <button type="button" key={t} className={`tab${activeTab === t ? ' active' : ''}`} onClick={() => setActiveTab(t)}>
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="empty-state">Loading reminders…</div>
      ) : activeTab === 'overdue' ? (
        <div>
          {overdue.length === 0 && upcoming.length === 0 ? (
            <div className="empty-state">No pending reminders.</div>
          ) : (
            <>
              <div className="panel-toolbar">
                <span className="text-muted">{overdue.length + upcoming.length} pending reminders</span>
                <button type="button" className="btn btn-primary btn-sm" disabled={sending} onClick={sendAll}>{sending ? 'Sending…' : 'Send All'}</button>
              </div>
              {[...overdue, ...upcoming].map(r => (
                <div key={r.id} className="reminder-card">
                  <div className="reminder-icon">{TYPE_ICON[r.type]}</div>
                  <div className="reminder-body">
                    <div className="reminder-title">{r.clientName} ({r.type.replace(/_/g, ' ')})</div>
                    <div className="reminder-msg">{r.message}</div>
                    <div className="reminder-meta">
                      Due: {formatDate(r.dueDate)} · {channelPill(r.channel)}
                      {r.policyNumber && <span className="mono reminder-policy">{r.policyNumber}</span>}
                    </div>
                  </div>
                  <button type="button" className="btn btn-primary btn-sm" disabled={sending} onClick={() => sendReminder(r)}>Send</button>
                </div>
              ))}
            </>
          )}
        </div>
      ) : activeTab === 'renewals' ? (
        <div>
          <div className="info-banner info-banner-warning">
            {lapsingPolicies.length > 0
              ? `⚠ ${lapsingPolicies.length} policies have lapsed. Send reinstatement offers.`
              : 'No lapsed policies.'
            }
          </div>
          <div className="card">
            <div className="tbl-scroll">
            <table className="table">
              <thead>
                <tr><th>Policy No.</th><th>Client</th><th>Product</th><th>End Date</th><th>Status</th><th>Action</th></tr>
              </thead>
              <tbody>
                {[...lapsingPolicies, ...upcomingRenewals].map(p => (
                  <tr key={p.id}>
                    <td><span className="mono">{p.policyNumber}</span></td>
                    <td>{p.clientName}</td>
                    <td>{p.productName}</td>
                    <td>{formatDate(p.endDate)}</td>
                    <td><span className={`pill pill-${p.status}`}>{p.status}</span></td>
                    <td>
                      <button type="button" className="btn btn-ghost btn-sm" disabled={sending} onClick={() => sendRenewalReminder(p)}>
                        Send Reminder
                      </button>
                    </td>
                  </tr>
                ))}
                {lapsingPolicies.length === 0 && upcomingRenewals.length === 0 && (
                  <tr><td colSpan={6} className="td-empty">No renewals in next 30 days.</td></tr>
                )}
              </tbody>
            </table>
            </div>
          </div>
        </div>
      ) : activeTab === 'log' ? (
        <div className="card">
          <div className="tbl-scroll">
          <table className="table">
            <thead>
              <tr><th>Client</th><th>Type</th><th>SMS Text</th><th>Channel</th><th>Status</th></tr>
            </thead>
            <tbody>
              {sent.length === 0 ? (
                <tr><td colSpan={5} className="td-empty">No sent reminders yet.</td></tr>
              ) : sent.map(r => (
                <tr key={r.id}>
                  <td>{r.clientName}</td>
                  <td>{TYPE_ICON[r.type]} {r.type.replace(/_/g, ' ')}</td>
                  {/* The verbatim text the client's phone received — stored
                      on the row from the moment of send; older rows (pre
                      sms_body) reconstruct it from the same template. */}
                  <td className="td-truncate" title={r.smsBody ?? reminderMessage(r)}>{r.smsBody ?? reminderMessage(r)}</td>
                  <td>{channelPill(r.channel)}</td>
                  <td><span className="pill pill-active">Sent</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      ) : (
        <div className="card settings-card">
          <h3 className="settings-title">Reminder Settings</h3>
          <div className="form-group">
            <label htmlFor="remind-payment">Payment Due Reminder (days before)</label>
            <input id="remind-payment" type="number" value={settings.paymentDays} min={1} max={14} className="form-control"
              onChange={e => setSettings(s => ({ ...s, paymentDays: Math.max(1, Math.min(14, Number(e.target.value) || 1)) }))} />
          </div>
          <div className="form-group">
            <label htmlFor="remind-renewal">Policy Renewal Reminder (days before)</label>
            <input id="remind-renewal" type="number" value={settings.renewalDays} min={7} max={60} className="form-control"
              onChange={e => setSettings(s => ({ ...s, renewalDays: Math.max(7, Math.min(60, Number(e.target.value) || 7)) }))} />
          </div>
          <div className="form-group">
            <label htmlFor="remind-channel">Default Reminder Channel</label>
            <select id="remind-channel" className="form-control" value={settings.channel}
              onChange={e => setSettings(s => ({ ...s, channel: e.target.value as Reminder['channel'] }))}>
              <option value="whatsapp">WhatsApp</option>
              <option value="sms">SMS</option>
              <option value="email">Email</option>
              <option value="ussd">USSD</option>
            </select>
          </div>
          <div className="form-group">
            <label className="checkbox-label">
              <input type="checkbox" checked={settings.birthdayGreetings}
                onChange={e => setSettings(s => ({ ...s, birthdayGreetings: e.target.checked }))} />
              Send birthday greetings to clients
            </label>
          </div>
          <button type="button" className="btn btn-primary" disabled={savingSettings} onClick={saveSettings}>
            {savingSettings ? 'Saving…' : 'Save Settings'}
          </button>
        </div>
      )}
    </div>
  )
}
