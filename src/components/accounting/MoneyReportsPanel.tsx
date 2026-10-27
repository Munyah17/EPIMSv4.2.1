import { useState, useEffect } from 'react'
import type { ToastMessage, Payment, Invoice, Claim, PettyCashEntry, Requisition } from '../../types'
import { db } from '../../lib/db'
import { exportToCsv } from '../../lib/exportUtils'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
}

type RangeKey = 'mtd' | 'last3' | 'ytd' | 'all'

function rangeStart(key: RangeKey): Date | null {
  const now = new Date()
  if (key === 'mtd') return new Date(now.getFullYear(), now.getMonth(), 1)
  if (key === 'last3') return new Date(now.getFullYear(), now.getMonth() - 2, 1)
  if (key === 'ytd') return new Date(now.getFullYear(), 0, 1)
  return null
}

const inRange = (iso: string | undefined, start: Date | null) => !start || (!!iso && new Date(iso) >= start)
const monthKey = (iso: string) => iso.slice(0, 7)

/** The money view: what came in (premium payments), what's owed (issued
 *  invoices), what went out (claims paid, requisitions, petty cash), and
 *  the collections trend by month and payment method. */
export default function MoneyReportsPanel({ showToast }: Props) {
  const [range, setRange] = useState<RangeKey>('ytd')
  const [loading, setLoading] = useState(true)
  const [payments, setPayments] = useState<Payment[]>([])
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [claims, setClaims] = useState<Claim[]>([])
  const [petty, setPetty] = useState<PettyCashEntry[]>([])
  const [reqs, setReqs] = useState<Requisition[]>([])

  useEffect(() => {
    setLoading(true)
    Promise.all([db.payments.list(), db.invoices.list(), db.claims.list(), db.pettyCashEntries.list(), db.requisitions.list()])
      .then(([p, i, c, pc, r]) => {
        if (p.error) showToast('error', p.error)
        if (i.error) showToast('error', i.error)
        if (pc.error) showToast('error', pc.error)
        setPayments(p.data ?? [])
        setInvoices(i.data ?? [])
        setClaims(c.data ?? [])
        setPetty(pc.data)
        setReqs(r.data)
      })
      .finally(() => setLoading(false))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const start = rangeStart(range)
  const paidPayments = payments.filter(p => p.status === 'completed' && inRange(p.recordedAt ?? p.date, start))
  const issuedInvoices = invoices.filter(i => i.status !== 'cancelled' && inRange(i.issuedAt, start))
  const outstandingInvoices = invoices.filter(i => i.status === 'issued')
  const paidClaims = claims.filter(c => c.status === 'paid' && inRange(c.dateSubmitted, start))
  const pettySpent = petty.filter(e => e.type === 'expense' && inRange(e.createdAt, start))
  const reqsPaid = reqs.filter(r => r.status === 'paid' && inRange(r.paidAt ?? r.createdAt, start))

  const collected = paidPayments.reduce((s, p) => s + p.amount, 0)
  const billed = issuedInvoices.reduce((s, i) => s + i.amount, 0)
  const outstanding = outstandingInvoices.reduce((s, i) => s + i.amount, 0)
  const claimsPaid = paidClaims.reduce((s, c) => s + c.amount, 0)
  const pettyTotal = pettySpent.reduce((s, e) => s + e.amount, 0)
  const reqsTotal = reqsPaid.reduce((s, r) => s + r.amount, 0)
  const net = collected - claimsPaid - pettyTotal - reqsTotal

  /** Monthly collections trend. */
  const byMonth = new Map<string, { collected: number; count: number; billed: number }>()
  for (const p of paidPayments) {
    const m = byMonth.get(monthKey(p.recordedAt ?? p.date)) ?? { collected: 0, count: 0, billed: 0 }
    m.collected += p.amount; m.count++
    byMonth.set(monthKey(p.recordedAt ?? p.date), m)
  }
  for (const i of issuedInvoices) {
    const m = byMonth.get(i.period) ?? { collected: 0, count: 0, billed: 0 }
    m.billed += i.amount
    byMonth.set(i.period, m)
  }
  const monthRows = [...byMonth.entries()].sort((a, b) => b[0].localeCompare(a[0]))

  /** Collections by payment method. */
  const byMethod = new Map<string, { amount: number; count: number }>()
  for (const p of paidPayments) {
    const m = byMethod.get(p.method) ?? { amount: 0, count: 0 }
    m.amount += p.amount; m.count++
    byMethod.set(p.method, m)
  }

  const exportReport = () => {
    exportToCsv(
      `money-report-${range}-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Type', 'Reference', 'Party', 'Amount', 'Status', 'Date'],
      [
        ...paidPayments.map(p => ['collection', p.reference, p.clientName, p.amount.toFixed(2), p.status, (p.recordedAt ?? p.date).slice(0, 10)]),
        ...issuedInvoices.map(i => ['invoice', i.invoiceNumber, i.groupName ?? i.clientName, i.amount.toFixed(2), i.status, i.issuedAt.slice(0, 10)]),
        ...paidClaims.map(c => ['claim_paid', c.claimNumber, c.clientName, c.amount.toFixed(2), c.status, c.dateSubmitted.slice(0, 10)]),
        ...reqsPaid.map(r => ['requisition', r.requisitionNumber, r.payee, r.amount.toFixed(2), r.status, (r.paidAt ?? r.createdAt).slice(0, 10)]),
        ...pettySpent.map(e => ['petty_cash', e.receiptRef ?? e.category, e.payee ?? e.description, e.amount.toFixed(2), 'spent', e.createdAt.slice(0, 10)]),
      ],
    )
    showToast('success', 'Money report exported.')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="card">
        <div className="card-header">
          <span className="card-title">Money In & Out</span>
          <div className="action-btns">
            {(['mtd', 'last3', 'ytd', 'all'] as RangeKey[]).map(k => (
              <button key={k} className={`btn btn-sm ${range === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setRange(k)}>
                {k === 'mtd' ? 'This Month' : k === 'last3' ? 'Last 3 Months' : k === 'ytd' ? 'Year to Date' : 'All Time'}
              </button>
            ))}
            <button className="btn btn-ghost btn-sm" onClick={exportReport} disabled={loading}>Export CSV</button>
          </div>
        </div>

        <div className="stats-grid">
          <div className="stat-card"><div className="stat-value">${collected.toFixed(2)}</div><div className="stat-label">Collected (Payments)</div></div>
          <div className="stat-card"><div className="stat-value">${billed.toFixed(2)}</div><div className="stat-label">Invoiced</div></div>
          <div className="stat-card"><div className="stat-value" style={{ color: outstanding > 0 ? 'var(--warning)' : undefined }}>${outstanding.toFixed(2)}</div><div className="stat-label">Unpaid Invoices (All)</div></div>
          <div className="stat-card"><div className="stat-value" style={{ color: claimsPaid > 0 ? 'var(--danger)' : undefined }}>${claimsPaid.toFixed(2)}</div><div className="stat-label">Claims Paid</div></div>
          <div className="stat-card"><div className="stat-value">${reqsTotal.toFixed(2)}</div><div className="stat-label">Requisitions Paid</div></div>
          <div className="stat-card"><div className="stat-value">${pettyTotal.toFixed(2)}</div><div className="stat-label">Petty Cash Spent</div></div>
        </div>
        <div className="stats-grid" style={{ marginTop: 8 }}>
          <div className="stat-card">
            <div className="stat-value" style={{ color: net >= 0 ? 'var(--success)' : 'var(--danger)' }}>${net.toFixed(2)}</div>
            <div className="stat-label">Net Cash Position (collected − outflows)</div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header"><span className="card-title">Collections by Month</span></div>
        {loading ? <div className="empty-state">Loading…</div> : monthRows.length === 0 ? (
          <div className="empty-state">No activity in this range.</div>
        ) : (
          <div className="tbl-scroll">
          <table className="table">
            <thead><tr><th>Month</th><th>Payments</th><th>Collected</th><th>Invoiced</th><th>Collection Rate</th></tr></thead>
            <tbody>
              {monthRows.map(([m, v]) => (
                <tr key={m}>
                  <td><span className="mono">{m}</span></td>
                  <td>{v.count}</td>
                  <td>${v.collected.toFixed(2)}</td>
                  <td>${v.billed.toFixed(2)}</td>
                  <td>{v.billed > 0 ? `${Math.round((v.collected / v.billed) * 100)}%` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-header"><span className="card-title">Collections by Method</span></div>
        {loading ? <div className="empty-state">Loading…</div> : byMethod.size === 0 ? (
          <div className="empty-state">No payments in this range.</div>
        ) : (
          <div className="tbl-scroll">
          <table className="table">
            <thead><tr><th>Method</th><th>Count</th><th>Amount</th><th>Share</th></tr></thead>
            <tbody>
              {[...byMethod.entries()].sort((a, b) => b[1].amount - a[1].amount).map(([method, v]) => (
                <tr key={method}>
                  <td>{method}</td>
                  <td>{v.count}</td>
                  <td>${v.amount.toFixed(2)}</td>
                  <td>{collected > 0 ? `${Math.round((v.amount / collected) * 100)}%` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  )
}
