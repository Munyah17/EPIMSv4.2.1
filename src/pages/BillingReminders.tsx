import { useState, useEffect } from 'react'
import type { ToastMessage, Policy, CautionFlag, Invoice } from '../types'
import type { ActivePanel } from '../App'
import { db } from '../lib/db'
import { runReminderCheck, getLastCheckTime, lastDayOfMonth, firstDayOfMonth } from '../lib/reminderEngine'
import { getGatewaySettings, saveGatewaySettings, getPaymentLog } from '../lib/paymentGateways'
import { getSmsLog } from '../lib/smsService'
import { policyBillablePremium } from '../lib/premium'
import { formatDate, formatDateTime } from '../lib/dateUtils'
import { notifyPhone } from '../lib/notify'
import { invoiceIssuedSms } from '../lib/smsText'
import { useAuth } from '../contexts/AuthContext'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
  setActivePanel: (panel: ActivePanel) => void
}

export default function BillingReminders({ showToast }: Props) {
  const [tab, setTab] = useState<'overview' | 'cautions' | 'gw_settings' | 'payment_log' | 'invoices'>('overview')
  const { user } = useAuth()
  const [invoiceList, setInvoiceList] = useState<Invoice[]>([])
  const [invoicesLoading, setInvoicesLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [cautions, setCautions] = useState<CautionFlag[]>([])
  const [lastCheck, setLastCheck] = useState(getLastCheckTime())
  const [gwSettings, setGwSettings] = useState(() => getGatewaySettings())
  const [payLog, setPayLog] = useState(() => getPaymentLog())
  const [savingGw, setSavingGw] = useState(false)
  const [checking, setChecking] = useState(false)
  const [activePolicies, setActivePolicies] = useState<Policy[]>([])

  const today = new Date()
  const firstDay = firstDayOfMonth(today)
  const lastDay = lastDayOfMonth(today)
  // Premiums fall due on the 1st of next month — "days until due" counts
  // to that, not the month end.
  const daysLeft = Math.max(0, Math.round((new Date(today.getFullYear(), today.getMonth() + 1, 1).getTime() - today.getTime()) / 86400000))
  const overduePolicyIds = new Set(cautions.map(f => f.policyId))
  const overduePolicies = activePolicies.filter(p => overduePolicyIds.has(p.id))

  useEffect(() => {
    db.policies.list().then(({ data, error }) => {
      if (error) showToast('error', 'Failed to load policies.')
      setActivePolicies((data ?? []).filter(p => p.status === 'active'))
    })
    db.cautionFlags.listActive().then(({ data, error }) => {
      if (error) showToast('error', 'Failed to load caution flags.')
      else setCautions(data)
    })
  }, [showToast])

  const handleForceCheck = async () => {
    setChecking(true)
    try {
      await runReminderCheck()
      setLastCheck(getLastCheckTime())
      const { data, error } = await db.cautionFlags.listActive()
      if (!error) setCautions(data)
      showToast('success', 'Reminder check completed. Check email and SMS logs for dispatches.')
    } finally {
      setChecking(false)
    }
  }

  const handleClearCaution = async (policyId: string) => {
    const { error } = await db.cautionFlags.clear(policyId)
    if (error) { showToast('error', `Caution flag not cleared: ${error}`); return }
    const { data } = await db.cautionFlags.listActive()
    setCautions(data)
    showToast('success', 'Caution flag cleared.')
  }

  const saveGw = () => {
    setSavingGw(true)
    saveGatewaySettings(gwSettings)
    setTimeout(() => { setSavingGw(false); showToast('success', 'Gateway settings saved.') }, 350)
  }

  useEffect(() => { setPayLog(getPaymentLog()) }, [tab])

  const loadInvoices = () => {
    setInvoicesLoading(true)
    db.invoices.list().then(({ data, error }) => {
      if (error) showToast('error', error)
      setInvoiceList(data)
    }).finally(() => setInvoicesLoading(false))
  }
  useEffect(() => { if (tab === 'invoices') loadInvoices() }, [tab]) // eslint-disable-line react-hooks/exhaustive-deps

  const currentPeriod = () => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  }

  /** One click issues the month for every group-cover policy — the same
   *  rows the cron writes on the 1st; anything already issued is skipped
   *  by the (policy, period) dedupe, so the button is safe to press twice. */
  const handleGenerateAll = async () => {
    setGenerating(true)
    try {
      const { data: allPolicies } = await db.policies.list()
      const groupPolicies = (allPolicies ?? []).filter(p => p.groupId && (p.status === 'active' || p.status === 'waiting_period'))
      if (groupPolicies.length === 0) { showToast('info', 'No live group-cover policies to invoice.'); return }
      const period = currentPeriod()
      let issued = 0, skipped = 0, failed = 0
      for (const p of groupPolicies) {
        const { data, error, created } = await db.invoices.create(p, period, user?.name ?? 'staff')
        if (error) failed++
        else if (created && data) {
          issued++
          const { data: client } = await db.clients.get(p.clientId)
          const msg = invoiceIssuedSms({
            orgName: p.groupName ?? p.clientName, policyNumber: p.policyNumber,
            invoiceNumber: data.invoiceNumber, amount: data.amount, heads: data.heads,
            period, dueDate: data.dueDate ? new Date(data.dueDate) : lastDayOfMonth(), clientPhone: client?.phone,
          })
          if (client?.phone) notifyPhone(client.phone, msg, 'payment', data.invoiceNumber)
          // The group's named contact person gets the reminder too — the
          // account holder and the person who pays are often different.
          if (p.groupId) {
            const { data: group } = await db.groups.get(p.groupId)
            if (group?.contactPhone && group.contactPhone.replace(/\D/g, '').slice(-9) !== (client?.phone ?? '').replace(/\D/g, '').slice(-9)) {
              notifyPhone(group.contactPhone, msg, 'payment', data.invoiceNumber)
            }
          }
        } else skipped++
      }
      showToast(failed > 0 ? 'warning' : 'success',
        `Invoices for ${period}: ${issued} issued, ${skipped} already existed${failed ? `, ${failed} failed` : ''}.`)
      loadInvoices()
    } finally {
      setGenerating(false)
    }
  }

  const handleInvoicePaid = async (inv: Invoice) => {
    const { data, error } = await db.invoices.markPaid(inv.id)
    if (error || !data) { showToast('error', error ?? 'Failed to mark paid.'); return }
    setInvoiceList(prev => prev.map(i => i.id === data.id ? data : i))
    showToast('success', `${inv.invoiceNumber} marked paid.`)
  }

  const handleInvoiceCancel = async (inv: Invoice) => {
    if (!window.confirm(`Cancel invoice ${inv.invoiceNumber}? The month can be re-issued afterwards.`)) return
    const { error } = await db.invoices.cancel(inv.id)
    if (error) { showToast('error', error); return }
    setInvoiceList(prev => prev.map(i => i.id === inv.id ? { ...i, status: 'cancelled' as const } : i))
    showToast('success', `${inv.invoiceNumber} cancelled.`)
  }

  return (
    <div className="panel">
      <div className="tabs">
        <button className={`tab${tab === 'overview' ? ' active' : ''}`} onClick={() => setTab('overview')}>Overview</button>
        <button className={`tab${tab === 'cautions' ? ' active' : ''}`} onClick={() => setTab('cautions')}>
          Caution Flags {cautions.length > 0 && <span className="nav-badge" style={{ marginLeft: 5 }}>{cautions.length}</span>}
        </button>
        <button className={`tab${tab === 'invoices' ? ' active' : ''}`} onClick={() => setTab('invoices')}>Invoices</button>
        <button className={`tab${tab === 'gw_settings' ? ' active' : ''}`} onClick={() => setTab('gw_settings')}>Gateway & SMTP</button>
        <button className={`tab${tab === 'payment_log' ? ' active' : ''}`} onClick={() => setTab('payment_log')}>Payment Log</button>
      </div>

      {/* ── OVERVIEW ── */}
      {tab === 'overview' && (
        <>
          <div className="stats-grid" style={{ marginBottom: 18 }}>
            <div className="stat-card">
              <div className="stat-icon" style={{ background: '#DCE4FB', color: '#2563EB' }}>📅</div>
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
                  { label: 'R1: 1st reminder', desc: '20th of the month, 08:00–16:00', icon: '📧', day: 20 },
                  { label: 'R2: 2nd reminder', desc: '25th of the month, same message', icon: '📧', day: 25 },
                  { label: 'R3: 3rd reminder', desc: '1st of the next month, same message', icon: '📱', day: 1 },
                  { label: 'Lapse notice', desc: '10th — unpaid policies lapse', icon: '⚠', day: 10 },
                ].map((item, i) => {
                  const isActive = today.getDate() === item.day
                  return (
                    <div key={i} className={`billing-schedule-row${isActive ? ' active' : ''}`}>
                      <span className="billing-schedule-icon">{item.icon}</span>
                      <div className="billing-schedule-info">
                        <span className="billing-schedule-label">{item.label}</span>
                        <span className="billing-schedule-desc">{item.desc}</span>
                      </div>
                      {isActive ? (
                        <span className="pill pill-active" style={{ fontSize: 10 }}>TODAY</span>
                      ) : (
                        <span className="billing-schedule-desc" style={{ fontSize: 10, whiteSpace: 'nowrap' }}>Day {item.day}</span>
                      )}
                    </div>
                  )
                })}
              </div>
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                <p style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 10 }}>
                  Last check: {lastCheck ? formatDateTime(lastCheck) : 'Never'}<br />
                  Reminders run on the server once a day, whether or not anyone is signed in. The app also checks hourly while it's open, and both dedupe through the database, so nothing is ever sent twice.
                </p>
                <button className="btn btn-primary btn-sm" onClick={handleForceCheck} disabled={checking}>{checking ? 'Checking…' : '▶ Run Check Now'}</button>
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
                  {/* Per head: what is actually invoiced, not the sum of
                      policyholders' own shares. */}
                  <strong>${activePolicies.reduce((s, p) => s + policyBillablePremium(p), 0).toLocaleString()}</strong>
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
            <div className="tbl-scroll">
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
                    <td>{formatDate(f.flaggedAt)}</td>
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
            </div>
          )}
          {cautions.length > 0 && (
            <div className="info-banner info-banner-warning" style={{ marginTop: 14, borderRadius: 8, padding: '10px 13px', fontSize: 12 }}>
              ⚠ Clients with caution flags may have claims subject to review. Flags clear automatically when payment is confirmed.
            </div>
          )}
        </div>
      )}

      {/* ── INVOICES ── */}
      {tab === 'invoices' && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Group Policy Invoices</span>
            <button className="btn btn-primary btn-sm" onClick={handleGenerateAll} disabled={generating}>
              {generating ? 'Issuing…' : `＋ Issue ${currentPeriod()} for all group policies`}
            </button>
          </div>
          <p style={{ fontSize: 11, color: 'var(--muted)', margin: '0 0 12px' }}>
            One invoice per group policy per month — the cron writes them automatically on the 1st; this button and the per-policy
            Invoice action on Policies do the same job by hand. The organisation gets the SMS the moment the invoice exists.
          </p>
          {invoicesLoading ? (
            <div className="empty-state">Loading invoices…</div>
          ) : invoiceList.length === 0 ? (
            <div className="empty-state">No invoices issued yet.</div>
          ) : (
            <div className="tbl-scroll">
            <table className="table">
              <thead>
                <tr><th>Invoice</th><th>Policy</th><th>Organisation</th><th>Period</th><th>Heads</th><th>Amount</th><th>Due</th><th>Status</th><th>Actions</th></tr>
              </thead>
              <tbody>
                {invoiceList.map(inv => (
                  <tr key={inv.id}>
                    <td><span className="mono">{inv.invoiceNumber}</span></td>
                    <td><span className="mono">{inv.policyNumber}</span></td>
                    <td>{inv.groupName ?? inv.clientName}</td>
                    <td>{inv.period}</td>
                    <td>{inv.heads}</td>
                    <td>${inv.amount.toFixed(2)}</td>
                    <td>{formatDate(inv.dueDate)}</td>
                    <td><span className={`pill ${inv.status === 'paid' ? 'pill-active' : inv.status === 'cancelled' ? 'pill-cancelled' : 'pill-pending'}`}>{inv.status}</span></td>
                    <td>
                      <div className="action-btns">
                        {inv.status === 'issued' && (
                          <>
                            <button className="btn btn-ghost btn-sm" style={{ color: 'var(--success)' }} onClick={() => handleInvoicePaid(inv)}>Mark Paid</button>
                            <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} onClick={() => handleInvoiceCancel(inv)}>Cancel</button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
            <p style={{ fontSize: 12, color: 'var(--muted)' }}>
              The Paynow integration ID and key are held in the server environment as <b>PAYNOW_INTEGRATION_ID</b> and <b>PAYNOW_INTEGRATION_KEY</b>, and are set in the hosting dashboard. They used to be editable here, but nothing read them: the transaction is built and signed by Paynow's SDK on the server, so a key typed into this page had no effect on payments. Keeping them out of the browser also keeps them out of the page source.
            </p>
            <div className="form-row">
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
          {/* Email delivery */}
          <div className="card">
            <div className="card-header"><span className="card-title">Email Delivery</span></div>
            <p style={{ fontSize: 12, color: 'var(--muted)' }}>
              Outgoing email (reminders, claim notices, tickets) is delivered live through Resend. The sender name and address are set on the <b>Notification Settings</b> page, not here.
            </p>
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
            <div className="tbl-scroll">
            <table className="table">
              <thead><tr><th>Time</th><th>Policy</th><th>Gateway</th><th>Amount</th><th>Reference</th><th>Status</th></tr></thead>
              <tbody>
                {payLog.map(p => (
                  <tr key={p.id}>
                    <td className="mono" style={{ whiteSpace: 'nowrap', fontSize: 11 }}>{formatDateTime(p.ts)}</td>
                    <td><span className="mono">{p.policyNumber}</span></td>
                    <td><span style={{ textTransform: 'capitalize' }}>{p.gateway}</span></td>
                    <td>${p.amount.toFixed(2)}</td>
                    <td className="mono" style={{ fontSize: 11 }}>{p.reference}</td>
                    <td><span className={`pill pill-${p.status === 'success' ? 'active' : p.status === 'failed' ? 'lapsed' : 'pending'}`}>{p.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
