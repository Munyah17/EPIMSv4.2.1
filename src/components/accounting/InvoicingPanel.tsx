import { useState, useEffect } from 'react'
import type { ToastMessage, Invoice, FdmsReceipt } from '../../types'
import { db } from '../../lib/db'
import { lastDayOfMonth } from '../../lib/reminderEngine'
import { formatDate } from '../../lib/dateUtils'
import { notifyPhone } from '../../lib/notify'
import { invoiceIssuedSms, smsDate } from '../../lib/smsText'
import { supabase } from '../../lib/supabase'
import { resolveSmsText, smsVarMoney } from '../../lib/smsTemplates'
import { useAuth } from '../../contexts/AuthContext'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
}

/** Group-policy invoicing — the same list/actions Billing Reminders showed,
 *  shared with the Accounting module so both stay on one code path. A paid
 *  invoice can also be fiscalised: POST /api/fdms submits it to ZIMRA and
 *  the result lands in fdms_receipts (FDMS tab). */
export default function InvoicingPanel({ showToast }: Props) {
  const { user } = useAuth()
  const [invoiceList, setInvoiceList] = useState<Invoice[]>([])
  const [receipts, setReceipts] = useState<FdmsReceipt[]>([])
  const [invoicesLoading, setInvoicesLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [fiscalisingId, setFiscalisingId] = useState<string | null>(null)

  const loadInvoices = () => {
    setInvoicesLoading(true)
    Promise.all([db.invoices.list(), db.fdmsReceipts.list()])
      .then(([inv, rec]) => {
        if (inv.error) showToast('error', inv.error)
        setInvoiceList(inv.data)
        setReceipts(rec.data)
      })
      .finally(() => setInvoicesLoading(false))
  }
  useEffect(loadInvoices, []) // eslint-disable-line react-hooks/exhaustive-deps

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
          const invDue = data.dueDate ? new Date(data.dueDate) : lastDayOfMonth()
          const msg = await resolveSmsText(supabase, 'invoice_issued', {
            productId: p.productId,
            vars: {
              orgName: p.groupName ?? p.clientName,
              policyNumber: p.policyNumber,
              invoiceNumber: data.invoiceNumber,
              amount: smsVarMoney(data.amount),
              heads: data.heads,
              billingPeriod: period,
              dueDate: smsDate(invDue),
            },
            fallback: invoiceIssuedSms({
              orgName: p.groupName ?? p.clientName, policyNumber: p.policyNumber,
              invoiceNumber: data.invoiceNumber, amount: data.amount, heads: data.heads,
              period, dueDate: invDue, clientPhone: client?.phone,
            }),
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

  /** Submit a paid invoice to ZIMRA FDMS. The server endpoint signs and
   *  sends the fiscal receipt; the outcome is written to fdms_receipts. */
  const handleFiscalise = async (inv: Invoice) => {
    setFiscalisingId(inv.id)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { showToast('error', 'Not signed in.'); return }
      const res = await fetch('/api/fdms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
        body: JSON.stringify({ invoiceId: inv.id }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { showToast('error', body.error ?? 'Fiscalisation failed.'); return }
      showToast('success', `${inv.invoiceNumber} fiscalised — receipt #${body.receipt?.receiptNumber ?? inv.invoiceNumber}.`)
      const { data: rec } = await db.fdmsReceipts.list()
      setReceipts(rec)
    } finally {
      setFiscalisingId(null)
    }
  }

  const receiptFor = (invoiceId: string) => receipts.find(r => r.invoiceId === invoiceId && r.status === 'fiscalised')
  const failedFor = (invoiceId: string) => receipts.find(r => r.invoiceId === invoiceId && r.status === 'failed')

  return (
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
                <td>
                  <span className={`pill ${inv.status === 'paid' ? 'pill-active' : inv.status === 'cancelled' ? 'pill-cancelled' : 'pill-pending'}`}>{inv.status}</span>
                  {receiptFor(inv.id) && <span className="pill pill-active" style={{ marginLeft: 6 }}>fiscalised</span>}
                  {failedFor(inv.id) && <span className="pill pill-cancelled" style={{ marginLeft: 6 }} title={failedFor(inv.id)?.error}>fdms failed</span>}
                </td>
                <td>
                  <div className="action-btns">
                    {inv.status === 'issued' && (
                      <>
                        <button className="btn btn-ghost btn-sm" style={{ color: 'var(--success)' }} onClick={() => handleInvoicePaid(inv)}>Mark Paid</button>
                        <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} onClick={() => handleInvoiceCancel(inv)}>Cancel</button>
                      </>
                    )}
                    {inv.status === 'paid' && !receiptFor(inv.id) && (
                      <button className="btn btn-ghost btn-sm" style={{ color: 'var(--accent)' }}
                        onClick={() => handleFiscalise(inv)} disabled={fiscalisingId === inv.id}>
                        {fiscalisingId === inv.id ? 'Submitting…' : 'Fiscalise'}
                      </button>
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
  )
}
