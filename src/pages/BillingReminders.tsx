import { useState, useEffect } from 'react'
import type { ToastMessage } from '../types'
import type { ActivePanel } from '../App'
import { localStore } from '../lib/localStore'
import { cautionStore } from '../lib/cautionStore'
import { runReminderCheck, getLastCheckTime, lastDayOfMonth, firstDayOfMonth } from '../lib/reminderEngine'
import { getGatewaySettings, saveGatewaySettings, getPaymentLog } from '../lib/paymentGateways'
import { getSmsLog } from '../lib/smsService'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
  setActivePanel: (panel: ActivePanel) => void
}

export default function BillingReminders({ showToast }: Props) {
  const [tab, setTab] = useState<'overview' | 'cautions' | 'gw_settings' | 'payment_log'>('overview')
  const [cautions, setCautions] = useState(() => cautionStore.listActive())
  const [lastCheck, setLastCheck] = useState(getLastCheckTime())
  const [gwSettings, setGwSettings] = useState(() => getGatewaySettings())
  const [payLog, setPayLog] = useState(() => getPaymentLog())
  const [savingGw, setSavingGw] = useState(false)

  const today = new Date()
  const firstDay = firstDayOfMonth(today)
  const lastDay = lastDayOfMonth(today)
  const daysLeft = Math.max(0, Math.round((lastDay.getTime() - today.getTime()) / 86400000))
  const activePolicies = localStore.policies.list().filter(p => p.status === 'active')
  const overduePolicies = activePolicies.filter(p => cautionStore.get(p.id) && !cautionStore.get(p.id)?.cleared)

  const handleForceCheck = () => {
    runReminderCheck()
    setLastCheck(getLastCheckTime())
    setCautions(cautionStore.listActive())
    showToast('success', 'Reminder check completed. Check email and SMS logs for dispatches.')
  }

  const handleClearCaution = (policyId: string) => {
    cautionStore.clear(policyId)
    setCautions(cautionStore.listActive())
    showToast('success', 'Caution flag cleared.')
  }

  const saveGw = () => {
    setSavingGw(true)
    saveGatewaySettings(gwSettings)
    setTimeout(() => { setSavingGw(false); showToast('success', 'Gateway settings saved.') }, 350)
  }

  useEffect(() => { setPayLog(getPaymentLog()) }, [tab])

  return (
    <div className="panel">
      <div className="tabs">
        <button className={`tab${tab === 'overview' ? ' active' : ''}`} onClick={() => setTab('overview')}>Overview</button>
        <button className={`tab${tab === 'cautions' ? ' active' : ''}`} onClick={() => setTab('cautions')}>
          Caution Flags {cautions.length > 0 && <span className="nav-badge" style={{ marginLeft: 5 }}>{cautions.length}</span>}
        </button>
        <button className={`tab${tab === 'gw_settings' ? ' active' : ''}`} onClick={() => setTab('gw_settings')}>Gateway & SMTP</button>
        <button className={`tab${tab === 'payment_log' ? ' active' : ''}`} onClick={() => setTab('payment_log')}>Payment Log</button>
      </div>

      {/* ── OVERVIEW ── */}
      {tab === 'overview' && (
        <>
          <div className="stats-grid" style={{ marginBottom: 18 }}>
            <div className="stat-card">
              <div className="stat-icon" style={{ background: '#DBEAFE', color: '#2563EB' }}>📅</div>
              <div className="stat-body">
                <div className="stat-value">{firstDay.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}</div>
                <div className="stat-label">Billing Start</div>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-icon" style={{ background: '#FEF3C7', color: '#D97706' }}>📆</div>
              <div className="stat-body">
                <div className="stat-value">{lastDay.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}</div>
                <div className="stat-label">Premiums Due</div>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-icon" style={{ background: daysLeft <= 5 ? '#FEE2E2' : '#D1FAE5', color: daysLeft <= 5 ? '#DC2626' : '#059669' }}>⏳</div>
              <div className="stat-body">
                <div className="stat-value">{daysLeft}d</div>
                <div className="stat-label">Days Until Due</div>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-icon" style={{ background: cautions.length > 0 ? '#FEE2E2' : '#D1FAE5', color: cautions.length > 0 ? '#DC2626' : '#059669' }}>⚠</div>
              <div className="stat-body">
                <div className="stat-value">{cautions.length}</div>
                <div className="stat-label">Caution Flags</div>
              </div>
            </div>
          </div>

          <div className="grid-2col">
            <div className="card">
              <div className="card-header"><span className="card-title">Reminder Schedule</span></div>
              <div className="billing-schedule">
                {[
                  { label: 'R1 — Pre-due email', desc: '5 days before end of month', icon: '📧', days: lastDay.getDate() - 5 },
                  { label: 'R2 — Urgent email', desc: '1 day before due date', icon: '📧', days: lastDay.getDate() - 1 },
                  { label: 'R3 — Due day email + SMS', desc: 'On the last day of month', icon: '📱', days: lastDay.getDate() },
                  { label: 'R4 — Overdue + Caution flag', desc: '5 days after due date', icon: '⚠', days: 5 },
                ].map((item, i) => {
                  const isActive = i === 0 ? daysLeft === 5 : i === 1 ? daysLeft === 1 : i === 2 ? daysLeft === 0 : daysLeft < 0
                  return (
                    <div key={i} className={`billing-schedule-row${isActive ? ' active' : ''}`}>
                      <span className="billing-schedule-icon">{item.icon}</span>
                      <div className="billing-schedule-info">
                        <span className="billing-schedule-label">{item.label}</span>
                        <span className="billing-schedule-desc">{item.desc}</span>
                      </div>
                      {isActive && <span className="pill pill-active" style={{ fontSize: 10 }}>TODAY</span>}
                    </div>
                  )
                })}
              </div>
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                <p style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 10 }}>
                  Last check: {lastCheck ? new Date(lastCheck).toLocaleString('en-GB') : 'Never'}<br />
                  The engine checks hourly while the app is open. For guaranteed delivery, run <code style={{ fontSize: 10 }}>node scripts/reminder-cron.js</code>.
                </p>
                <button className="btn btn-primary btn-sm" onClick={handleForceCheck}>▶ Run Check Now</button>
              </div>
            </div>

            <div className="card">
              <div className="card-header"><span className="card-title">Active Policy Summary</span></div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div className="sh-info-row">
                  <span>Active policies</span>
                  <strong>{activePolicies.length}</strong>
                </div>
                <div className="sh-info-row">
                  <span>Policies with caution flags</span>
                  <strong style={{ color: overduePolicies.length > 0 ? 'var(--danger)' : 'inherit' }}>{overduePolicies.length}</strong>
                </div>
                <div className="sh-info-row">
                  <span>Total premiums due this month</span>
                  <strong>${activePolicies.reduce((s, p) => s + p.premium, 0).toLocaleString()}</strong>
                </div>
                <div className="sh-info-row">
                  <span>Days until due date</span>
                  <strong style={{ color: daysLeft <= 5 ? 'var(--danger)' : 'inherit' }}>{daysLeft} days</strong>
                </div>
                <div className="sh-info-row">
                  <span>SMS log entries</span>
                  <strong>{getSmsLog().length}</strong>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ── CAUTION FLAGS ── */}
      {tab === 'cautions' && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Active Caution Flags</span>
            <span className="text-muted" style={{ fontSize: 11 }}>Cleared automatically when payment is recorded</span>
          </div>
          {cautions.length === 0 ? (
            <div className="empty-state">No active caution flags. All clients are in good standing.</div>
          ) : (
            <table className="table">
              <thead>
                <tr><th>Policy</th><th>Client</th><th>Days Overdue</th><th>Flagged On</th><th>Months</th><th>Actions</th></tr>
              </thead>
              <tbody>
                {cautions.map(f => (
                  <tr key={f.policyId}>
                    <td><span className="mono">{f.policyNumber}</span></td>
                    <td>{f.clientName}</td>
                    <td><span className="pill pill-lapsed">{f.daysOverdue}+ days</span></td>
                    <td>{new Date(f.flaggedAt).toLocaleDateString('en-GB')}</td>
                    <td>{f.monthsDefaulted} month{f.monthsDefaulted !== 1 ? 's' : ''}</td>
                    <td>
                      <button className="btn btn-ghost btn-sm" style={{ color: 'var(--success)' }} onClick={() => handleClearCaution(f.policyId)}>
                        ✓ Clear Flag
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {cautions.length > 0 && (
            <div className="info-banner info-banner-warning" style={{ marginTop: 14, borderRadius: 8, padding: '10px 13px', fontSize: 12 }}>
              ⚠ Clients with caution flags may have claims subject to review. Flags clear automatically when payment is confirmed.
            </div>
          )}
        </div>
      )}

      {/* ── GATEWAY & SMTP ── */}
      {tab === 'gw_settings' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* EcoCash */}
          <div className="card">
            <div className="card-header"><span className="card-title">EcoCash Merchant API</span></div>
            <div className="form-row">
              <div className="form-group"><label>Merchant Code</label><input className="form-control" value={gwSettings.ecocashMerchantCode} onChange={e => setGwSettings(p => ({ ...p, ecocashMerchantCode: e.target.value }))} placeholder="EC12345" /></div>
              <div className="form-group"><label>Merchant PIN</label><input className="form-control" type="password" value={gwSettings.ecocashMerchantPin} onChange={e => setGwSettings(p => ({ ...p, ecocashMerchantPin: e.target.value }))} /></div>
              <div className="form-group"><label>Merchant Phone</label><input className="form-control" value={gwSettings.ecocashMerchantPhone} onChange={e => setGwSettings(p => ({ ...p, ecocashMerchantPhone: e.target.value }))} placeholder="0771234567" /></div>
              <div className="form-group"><label>API Base URL</label><input className="form-control" value={gwSettings.ecocashApiUrl} onChange={e => setGwSettings(p => ({ ...p, ecocashApiUrl: e.target.value }))} /></div>
            </div>
          </div>
          {/* Paynow */}
          <div className="card">
            <div className="card-header"><span className="card-title">Paynow Integration</span></div>
            <div className="form-row">
              <div className="form-group"><label>Integration ID</label><input className="form-control" value={gwSettings.paynowIntegrationId} onChange={e => setGwSettings(p => ({ ...p, paynowIntegrationId: e.target.value }))} placeholder="12345" /></div>
              <div className="form-group"><label>Integration Key</label><input className="form-control" type="password" value={gwSettings.paynowIntegrationKey} onChange={e => setGwSettings(p => ({ ...p, paynowIntegrationKey: e.target.value }))} /></div>
              <div className="form-group"><label>Return URL</label><input className="form-control" value={gwSettings.paynowReturnUrl} onChange={e => setGwSettings(p => ({ ...p, paynowReturnUrl: e.target.value }))} /></div>
              <div className="form-group"><label>Result URL (webhook)</label><input className="form-control" value={gwSettings.paynowResultUrl} onChange={e => setGwSettings(p => ({ ...p, paynowResultUrl: e.target.value }))} /></div>
            </div>
          </div>
          {/* Zipit */}
          <div className="card">
            <div className="card-header"><span className="card-title">Zipit / Bank Transfer Details</span></div>
            <div className="form-row">
              <div className="form-group"><label>Bank Name</label><input className="form-control" value={gwSettings.zipitBankName} onChange={e => setGwSettings(p => ({ ...p, zipitBankName: e.target.value }))} /></div>
              <div className="form-group"><label>Account Name</label><input className="form-control" value={gwSettings.zipitAccountName} onChange={e => setGwSettings(p => ({ ...p, zipitAccountName: e.target.value }))} /></div>
              <div className="form-group"><label>Account Number</label><input className="form-control" value={gwSettings.zipitAccountNumber} onChange={e => setGwSettings(p => ({ ...p, zipitAccountNumber: e.target.value }))} /></div>
              <div className="form-group"><label>Branch Code</label><input className="form-control" value={gwSettings.zipitBranchCode} onChange={e => setGwSettings(p => ({ ...p, zipitBranchCode: e.target.value }))} /></div>
            </div>
          </div>
          {/* SMTP */}
          <div className="card">
            <div className="card-header"><span className="card-title">SMTP Email Server</span></div>
            <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>Used by the Node.js cron script for actual email delivery. In-app emails are stored in the system. Run <code style={{ fontSize: 11 }}>node scripts/reminder-cron.js</code> for live dispatch.</p>
            <div className="form-row">
              <div className="form-group"><label>SMTP Host</label><input className="form-control" value={gwSettings.smtpHost} onChange={e => setGwSettings(p => ({ ...p, smtpHost: e.target.value }))} placeholder="smtp.gmail.com" /></div>
              <div className="form-group"><label>Port</label><input className="form-control" type="number" value={gwSettings.smtpPort} onChange={e => setGwSettings(p => ({ ...p, smtpPort: Number(e.target.value) }))} /></div>
              <div className="form-group"><label>Username</label><input className="form-control" value={gwSettings.smtpUser} onChange={e => setGwSettings(p => ({ ...p, smtpUser: e.target.value }))} /></div>
              <div className="form-group"><label>Password</label><input className="form-control" type="password" value={gwSettings.smtpPass} onChange={e => setGwSettings(p => ({ ...p, smtpPass: e.target.value }))} /></div>
              <div className="form-group"><label>From Address</label><input className="form-control" value={gwSettings.smtpFrom} onChange={e => setGwSettings(p => ({ ...p, smtpFrom: e.target.value }))} /></div>
              <div className="form-group"><label>From Name</label><input className="form-control" value={gwSettings.smtpFromName} onChange={e => setGwSettings(p => ({ ...p, smtpFromName: e.target.value }))} /></div>
            </div>
          </div>
          <div>
            <button className="btn btn-primary" onClick={saveGw} disabled={savingGw}>{savingGw ? 'Saving…' : 'Save All Settings'}</button>
          </div>
        </div>
      )}

      {/* ── PAYMENT LOG ── */}
      {tab === 'payment_log' && (
        <div className="card">
          <div className="card-header"><span className="card-title">Online Payment Attempts</span></div>
          {payLog.length === 0 ? (
            <div className="empty-state">No online payment records yet.</div>
          ) : (
            <table className="table">
              <thead><tr><th>Time</th><th>Policy</th><th>Gateway</th><th>Amount</th><th>Reference</th><th>Status</th></tr></thead>
              <tbody>
                {payLog.map(p => (
                  <tr key={p.id}>
                    <td className="mono" style={{ whiteSpace: 'nowrap', fontSize: 11 }}>{new Date(p.ts).toLocaleString('en-GB')}</td>
                    <td><span className="mono">{p.policyNumber}</span></td>
                    <td><span style={{ textTransform: 'capitalize' }}>{p.gateway}</span></td>
                    <td>${p.amount.toFixed(2)}</td>
                    <td className="mono" style={{ fontSize: 11 }}>{p.reference}</td>
                    <td><span className={`pill pill-${p.status === 'success' ? 'active' : p.status === 'failed' ? 'lapsed' : 'pending'}`}>{p.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}
