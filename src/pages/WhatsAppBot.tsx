import { useEffect, useState, useCallback } from 'react'
import { waBot } from '../lib/whatsappAdmin'
import type { WaBotStatus, WaSessionRow } from '../lib/whatsappAdmin'
import type { ToastMessage } from '../types'
import type { ActivePanel } from '../App'

const BUSINESS_NUMBER = '+263 78 008 6176'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
  setActivePanel: (panel: ActivePanel) => void
}

const CHECK_LABELS: [keyof WaBotStatus['configured'], string][] = [
  ['accessToken', 'WHATSAPP_ACCESS_TOKEN'],
  ['phoneNumberId', 'WHATSAPP_PHONE_NUMBER_ID'],
  ['verifyToken', 'WHATSAPP_VERIFY_TOKEN'],
  ['appSecret', 'WHATSAPP_APP_SECRET'],
  ['paynow', 'PAYNOW_* (payment links)'],
  ['ecocash', 'EIP_* (EcoCash push)'],
]

const CODE_STYLE: React.CSSProperties = { fontSize: 12, overflowWrap: 'anywhere' }

export default function WhatsAppBot({ showToast }: Props) {
  const [status, setStatus] = useState<WaBotStatus | null>(null)
  const [sessions, setSessions] = useState<WaSessionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [testPhone, setTestPhone] = useState('')
  const [testText, setTestText] = useState('')
  const [sending, setSending] = useState(false)
  const [toggling, setToggling] = useState(false)

  const refresh = useCallback(async () => {
    const [s, sess] = await Promise.all([waBot.status(), waBot.sessions()])
    if (s.error) showToast('error', `WhatsApp Bot: ${s.error}`)
    else setStatus(s.data ?? null)
    if (!sess.error) setSessions(sess.data?.sessions ?? [])
    setLoading(false)
  }, [showToast])

  useEffect(() => { void refresh() }, [refresh])

  const toggle = async () => {
    if (!status) return
    setToggling(true)
    const r = await waBot.setEnabled(!status.enabled)
    if (r.error) showToast('error', `Could not change bot state: ${r.error}`)
    else showToast('success', r.data?.enabled ? 'Bot is live — it will answer the next message.' : 'Bot paused — inbound messages are acknowledged but not answered.')
    await refresh()
    setToggling(false)
  }

  const sendTest = async () => {
    if (!testPhone.trim()) { showToast('error', 'Enter a phone number (international format, e.g. 263775668334).'); return }
    setSending(true)
    const r = await waBot.sendTest(testPhone, testText)
    if (r.error) showToast('error', `Test send failed: ${r.error}`)
    else showToast('success', `Test message sent to ${testPhone}.`)
    setSending(false)
  }

  const endSession = async (id: string) => {
    const r = await waBot.endSession(id)
    if (r.error) showToast('error', `Could not end session: ${r.error}`)
    else showToast('success', 'Session ended — that number starts fresh on its next message.')
    await refresh()
  }

  const missing = CHECK_LABELS.filter(([k]) => status && !status.configured[k])

  return (
    <div className="panel">
      <div className="sh-page-header">
        <div className="sh-page-status">
          <div className="syshealth-dot lg" style={{ background: loading ? '#94A3B8' : status?.enabled ? '#059669' : '#DC2626' }} />
          <div>
            <h2 className="sh-page-title">WhatsApp Bot</h2>
            <p className="sh-page-sub">
              Business number <strong>{BUSINESS_NUMBER}</strong> (Econet)
            </p>
          </div>
        </div>
        <button className="btn btn-outline" onClick={() => void refresh()}>↻ Refresh</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))', gap: 16 }}>

        {/* Live state */}
        <div className="card">
          <div className="card-header"><span className="card-title">Bot status</span></div>
          {loading ? <p className="text-muted">Loading…</p> : !status ? (
            <p className="text-muted">Status unavailable — check Vercel env vars are set.</p>
          ) : (
            <>
              <p style={{ marginBottom: 10 }}>
                <span className={`pill ${status.enabled ? 'pill-success' : 'pill-danger'}`}>
                  {status.enabled ? '● LIVE' : '● PAUSED'}
                </span>
              </p>
              <p className="text-muted" style={{ fontSize: 13, marginBottom: 14 }}>
                {status.counts.openSessions} open session{status.counts.openSessions === 1 ? '' : 's'} ·{' '}
                {status.counts.sessions24h} in the last 24h · {status.counts.policiesViaBot} policies written via the bot
              </p>
              <button className={`btn ${status.enabled ? 'btn-danger' : 'btn-primary'}`} onClick={() => void toggle()} disabled={toggling}>
                {toggling ? 'Saving…' : status.enabled ? 'Pause bot' : 'Resume bot'}
              </button>
              <p className="text-muted" style={{ fontSize: 12, marginTop: 8 }}>
                Pausing stops the bot answering (Meta still delivers). Takes effect on the next inbound message — no redeploy.
              </p>
            </>
          )}
        </div>

        {/* Config checklist */}
        <div className="card">
          <div className="card-header"><span className="card-title">Server configuration</span></div>
          {loading || !status ? <p className="text-muted">Loading…</p> : (
            <>
              {CHECK_LABELS.map(([k, label]) => (
                <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                  <code style={CODE_STYLE}>{label}</code>
                  <span className={`pill ${status.configured[k] ? 'pill-success' : 'pill-danger'}`} style={{ flexShrink: 0 }}>
                    {status.configured[k] ? 'set' : 'missing'}
                  </span>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '6px 0' }}>
                <code style={CODE_STYLE}>Graph API version</code>
                <span style={{ fontSize: 12 }}>{status.configured.graphVersion}</span>
              </div>
              {missing.length > 0 && (
                <div className="info-banner info-banner-danger" style={{ marginTop: 10, borderRadius: 8, padding: '10px 13px', fontSize: 12 }}>
                  {missing.length} variable{missing.length === 1 ? '' : 's'} missing — set in Vercel → Settings → Environment Variables (Production), then redeploy. Values are never shown here.
                </div>
              )}
            </>
          )}
        </div>

        {/* Test send */}
        <div className="card">
          <div className="card-header"><span className="card-title">Send test message</span></div>
          <div className="form-group">
            <label>Phone (international format)</label>
            <input className="form-control" placeholder="e.g. 263775668334" inputMode="tel" value={testPhone} onChange={e => setTestPhone(e.target.value.replace(/[^\d+]/g, ''))} />
          </div>
          <div className="form-group" style={{ marginTop: 10 }}>
            <label>Message</label>
            <input className="form-control" placeholder="Motions WhatsApp Bot — test from the portal." value={testText} onChange={e => setTestText(e.target.value)} />
          </div>
          <button className="btn btn-primary" style={{ marginTop: 14 }} onClick={() => void sendTest()} disabled={sending}>
            {sending ? 'Sending…' : 'Send test'}
          </button>
          <p className="text-muted" style={{ fontSize: 12, marginTop: 8 }}>
            Replies from that number are normal inbound messages — they start bot sessions.
          </p>
        </div>
      </div>

      {/* Open sessions */}
      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-header">
          <span className="card-title">Open sessions <span className="pill pill-gray">{sessions.length}</span></span>
        </div>
        <p className="text-muted" style={{ fontSize: 13 }}>
          Conversations in progress (60-minute lifetime). Ending one makes that number start fresh.
        </p>
        {sessions.length === 0 ? (
          <div className="empty-state" style={{ padding: '20px 0' }}>No open sessions.</div>
        ) : (
          <div className="tbl-scroll">
            <table className="table">
              <thead>
                <tr><th>Phone</th><th>Audience</th><th>Step</th><th>Started</th><th>Details</th><th /></tr>
              </thead>
              <tbody>
                {sessions.map(s => (
                  <tr key={s.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{s.phone_number}</td>
                    <td><span className="pill pill-blue">{s.contact_type}</span></td>
                    <td><code style={CODE_STYLE}>{s.state}</code></td>
                    <td style={{ whiteSpace: 'nowrap' }}>{new Date(s.created_at).toLocaleString()}</td>
                    <td style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>
                      {s.note && Object.keys(s.note).length > 0 ? Object.keys(s.note).join(', ') : '—'}
                    </td>
                    <td><button className="btn btn-outline btn-sm" onClick={() => void endSession(s.id)}>End</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* How it works */}
      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-header"><span className="card-title">Reference</span></div>
        <ul style={{ fontSize: 13, lineHeight: 1.7, paddingLeft: 18, margin: 0 }}>
          <li>Menus: <strong>clients</strong> (pay, policies, renew, claims, dependants), <strong>agents</strong> (add client/dependant, book, commission, pay), <strong>unknown numbers</strong> (register).</li>
          <li>Type <code>exit</code> in any chat to reset to the main menu. Sessions auto-expire after 60 minutes.</li>
          <li>Clients/policies/payments created here are ordinary IMS rows — visible on Clients, Policies, Payments immediately.</li>
          <li>Setup &amp; troubleshooting guide: <code>docs/whatsapp-bot.md</code> in the repo.</li>
        </ul>
      </div>
    </div>
  )
}
