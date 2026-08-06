import { useState, useEffect } from 'react'
import type { ToastMessage } from '../types'
import type { ActivePanel } from '../App'
import { db } from '../lib/db'
import { exportToCsv, exportToExcel, exportToPdf } from '../lib/exportUtils'
import type { Policy, Claim, Payment, Client } from '../types'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
  setActivePanel: (panel: ActivePanel) => void
}

export default function Reports({ showToast }: Props) {
  const [period, setPeriod] = useState<'month' | 'quarter' | 'year' | 'custom'>('month')
  const [activeTab, setActiveTab] = useState<'overview' | 'claims' | 'ipec'>('overview')
  const [policies, setPolicies] = useState<Policy[]>([])
  const [claims, setClaims] = useState<Claim[]>([])
  const [payments, setPayments] = useState<Payment[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      db.policies.list(),
      db.claims.list(),
      db.payments.list(),
      db.clients.list(),
    ]).then(([policiesRes, claimsRes, paymentsRes, clientsRes]) => {
      if (policiesRes.data) setPolicies(policiesRes.data)
      if (claimsRes.data) setClaims(claimsRes.data)
      if (paymentsRes.data) setPayments(paymentsRes.data)
      if (clientsRes.data) setClients(clientsRes.data)
      setLoading(false)
    })
  }, [])

  if (loading) return <div className="panel">Loading reports…</div>

  const totalPolicies = policies.length
  const activePolicies = policies.filter(p => p.status === 'active').length
  const lapseRate = totalPolicies > 0 ? ((policies.filter(p => p.status === 'lapsed').length / totalPolicies) * 100).toFixed(1) : '0'
  const totalPremiums = payments.filter(p => p.status === 'completed').reduce((s, p) => s + p.amount, 0)
  const totalClaims = claims.length
  const paidClaims = claims.filter(c => c.status === 'paid')
  const totalPaid = paidClaims.reduce((s, c) => s + c.amount, 0)
  const claimsRatio = totalPremiums > 0 ? ((totalPaid / totalPremiums) * 100).toFixed(1) : '0'

  const productBreakdown = Object.values(
    policies.reduce<Record<string, { name: string; policies: number; revenue: number }>>((acc, p) => {
      const key = p.productName || 'Unknown'
      if (!acc[key]) acc[key] = { name: key, policies: 0, revenue: 0 }
      acc[key].policies += 1
      acc[key].revenue += p.premium
      return acc
    }, {}),
  ).sort((a, b) => b.policies - a.policies)

  const dateStamp = new Date().toISOString().split('T')[0]

  const handleExport = async (format: 'PDF' | 'Excel' | 'CSV' | 'IPEC PDF') => {
    if (format === 'IPEC PDF') {
      await exportToPdf(
        `ipec-return-${dateStamp}.pdf`, 'IPEC Quarterly Return', ['Field', 'Value'],
        [
          ['Intermediary Name', 'Enpassent Multiple Agents (Pvt) Ltd'],
          ['IPEC Reg. Number', 'IPEC/IB/2020/001'],
          ['Total Policies Issued', totalPolicies],
          ['Active Policies', activePolicies],
          ['Gross Premiums Written', `$${totalPremiums.toFixed(2)}`],
          ['Claims Incurred', `$${totalPaid.toFixed(2)}`],
          ['Claims Ratio', `${claimsRatio}%`],
          ['Lapse Rate', `${lapseRate}%`],
          ['Total Clients', clients.length],
        ],
        `Generated ${new Date().toLocaleDateString('en-GB')}`,
      )
      showToast('success', 'IPEC return downloaded.')
      return
    }

    let headers: string[]
    let rows: (string | number)[][]
    let title: string
    let baseName: string

    if (activeTab === 'claims') {
      title = 'Claims Analysis'
      baseName = 'claims-analysis'
      headers = ['Claim No.', 'Client', 'Amount', 'Type', 'Fraud Score', 'Status']
      rows = claims.map(c => [c.claimNumber, c.clientName, c.amount, c.claimType, `${c.fraudScore}%`, c.status])
    } else if (activeTab === 'ipec') {
      title = 'IPEC Quarterly Return'
      baseName = 'ipec-return'
      headers = ['Field', 'Value']
      rows = [
        ['Intermediary Name', 'Enpassent Multiple Agents (Pvt) Ltd'],
        ['IPEC Reg. Number', 'IPEC/IB/2020/001'],
        ['Total Policies Issued', totalPolicies],
        ['Active Policies', activePolicies],
        ['Gross Premiums Written', `$${totalPremiums.toFixed(2)}`],
        ['Claims Incurred', `$${totalPaid.toFixed(2)}`],
        ['Claims Ratio', `${claimsRatio}%`],
        ['Lapse Rate', `${lapseRate}%`],
        ['Total Clients', clients.length],
      ]
    } else {
      title = 'Policy Report — Overview'
      baseName = 'policies-report'
      headers = ['Policy No.', 'Client', 'Product', 'Premium', 'Status', 'Start Date']
      rows = policies.map(p => [p.policyNumber, p.clientName, p.productName, `$${p.premium.toFixed(2)}/mo`, p.status, p.startDate])
    }

    if (format === 'CSV') exportToCsv(`${baseName}-${dateStamp}.csv`, headers, rows)
    else if (format === 'Excel') await exportToExcel(`${baseName}-${dateStamp}.xlsx`, title, headers, rows)
    else await exportToPdf(`${baseName}-${dateStamp}.pdf`, title, headers, rows, `Generated ${new Date().toLocaleDateString('en-GB')}`)

    showToast('success', `${title} exported as ${format}.`)
  }

  return (
    <div className="panel">
      <div className="panel-toolbar">
        <div className="tabs" style={{ marginBottom: 0 }}>
          {([['overview', 'Overview'], ['claims', 'Claims Analysis'], ['ipec', 'IPEC Report']] as [typeof activeTab, string][]).map(([t, label]) => (
            <button key={t} className={`tab${activeTab === t ? ' active' : ''}`} onClick={() => setActiveTab(t)}>{label}</button>
          ))}
        </div>
        <div className="filter-row">
          <select className="filter-select" value={period} onChange={e => setPeriod(e.target.value as typeof period)}>
            <option value="month">This Month</option>
            <option value="quarter">This Quarter</option>
            <option value="year">This Year</option>
            <option value="custom">Custom Range</option>
          </select>
          <button className="btn btn-ghost btn-sm" onClick={() => handleExport('PDF')}>↓ PDF</button>
          <button className="btn btn-ghost btn-sm" onClick={() => handleExport('Excel')}>↓ Excel</button>
          <button className="btn btn-ghost btn-sm" onClick={() => handleExport('CSV')}>↓ CSV</button>
        </div>
      </div>

      {activeTab === 'overview' && (
        <>
          <div className="stats-grid">
            <div className="stat-card">
              <div className="stat-icon" style={{ background: 'rgba(91,127,232,0.15)', color: 'var(--blue)' }}>🛡</div>
              <div className="stat-body">
                <div className="stat-value">{totalPolicies}</div>
                <div className="stat-label">Total Policies</div>
                <div className="stat-delta positive">{activePolicies} active</div>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-icon" style={{ background: 'rgba(16,185,129,0.15)', color: 'var(--teal)' }}>💰</div>
              <div className="stat-body">
                <div className="stat-value">${totalPremiums.toFixed(0)}</div>
                <div className="stat-label">Total Premiums</div>
                <div className="stat-delta positive">Collected</div>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-icon" style={{ background: 'rgba(245,158,11,0.15)', color: 'var(--gold)' }}>📋</div>
              <div className="stat-body">
                <div className="stat-value">{totalClaims}</div>
                <div className="stat-label">Total Claims</div>
                <div className="stat-delta">{paidClaims.length} paid</div>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-icon" style={{ background: 'rgba(139,92,246,0.15)', color: 'var(--purple)' }}>📊</div>
              <div className="stat-body">
                <div className="stat-value">{claimsRatio}%</div>
                <div className="stat-label">Claims Ratio</div>
                <div className="stat-delta">Paid / Premiums</div>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-icon" style={{ background: 'rgba(239,68,68,0.15)', color: 'var(--danger)' }}>📉</div>
              <div className="stat-body">
                <div className="stat-value">{lapseRate}%</div>
                <div className="stat-label">Lapse Rate</div>
                <div className="stat-delta negative">Monitor</div>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-icon" style={{ background: 'rgba(91,127,232,0.15)', color: 'var(--blue)' }}>👥</div>
              <div className="stat-body">
                <div className="stat-value">{clients.length}</div>
                <div className="stat-label">Total Clients</div>
                <div className="stat-delta positive">{clients.filter(c => c.status === 'active').length} active</div>
              </div>
            </div>
          </div>

          <div className="card" style={{ marginTop: '1.5rem' }}>
            <div className="card-header"><h3 className="card-title">Product Performance</h3></div>
            <table className="table">
              <thead>
                <tr><th>Product</th><th>Policies</th><th>Monthly Revenue ($)</th><th>Share</th></tr>
              </thead>
              <tbody>
                {productBreakdown.map(p => (
                  <tr key={p.name}>
                    <td>{p.name}</td>
                    <td>{p.policies}</td>
                    <td>${p.revenue.toFixed(2)}</td>
                    <td>
                      <div className="bar-track" style={{ height: 8, width: 120, display: 'inline-block' }}>
                        <div className="bar-fill" style={{ width: `${(p.policies / totalPolicies) * 100}%`, background: 'var(--blue)', height: '100%', borderRadius: 4 }} />
                      </div>
                      <span style={{ marginLeft: 8, fontSize: '0.75rem', color: 'var(--muted)' }}>
                        {((p.policies / totalPolicies) * 100).toFixed(0)}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {activeTab === 'claims' && (
        <div className="card">
          <h3 style={{ marginBottom: '1rem' }}>Claims Analysis</h3>
          <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: '1.5rem' }}>
            {['pending', 'under_review', 'approved', 'rejected', 'paid'].map(s => (
              <div key={s} className="stat-card">
                <div className="stat-body">
                  <div className="stat-value">{claims.filter(c => c.status === s).length}</div>
                  <div className="stat-label" style={{ textTransform: 'capitalize' }}>{s.replace('_', ' ')}</div>
                </div>
              </div>
            ))}
          </div>
          <table className="table">
            <thead>
              <tr><th>Claim No.</th><th>Client</th><th>Amount</th><th>Type</th><th>Fraud Score</th><th>Status</th></tr>
            </thead>
            <tbody>
              {claims.map(c => (
                <tr key={c.id}>
                  <td><span className="mono">{c.claimNumber}</span></td>
                  <td>{c.clientName}</td>
                  <td>${c.amount.toLocaleString()}</td>
                  <td>{c.claimType}</td>
                  <td><span style={{ color: c.fraudScore >= 70 ? 'var(--danger)' : c.fraudScore >= 40 ? 'var(--gold)' : 'var(--teal)' }}>{c.fraudScore}%</span></td>
                  <td><span className={`pill pill-${c.status.replace('_', '-')}`}>{c.status.replace('_', ' ')}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === 'ipec' && (
        <div className="card" style={{ maxWidth: 700 }}>
          <div className="info-banner info-banner-info" style={{ marginBottom: '1.5rem' }}>
            ℹ IPEC Quarterly Return — Submit before the 15th of the month following quarter end.
          </div>
          <h3 style={{ marginBottom: '1.5rem' }}>IPEC Quarterly Return — Q2 2026</h3>
          <table className="table">
            <tbody>
              <tr><td><strong>Intermediary Name</strong></td><td>Enpassent Multiple Agents (Pvt) Ltd</td></tr>
              <tr><td><strong>IPEC Reg. Number</strong></td><td>IPEC/IB/2020/001</td></tr>
              <tr><td><strong>Reporting Period</strong></td><td>01 April – 30 June 2026</td></tr>
              <tr><td><strong>Total Policies Issued</strong></td><td>{totalPolicies}</td></tr>
              <tr><td><strong>Active Policies</strong></td><td>{activePolicies}</td></tr>
              <tr><td><strong>Gross Premiums Written</strong></td><td>${totalPremiums.toFixed(2)}</td></tr>
              <tr><td><strong>Claims Incurred</strong></td><td>${totalPaid.toFixed(2)}</td></tr>
              <tr><td><strong>Claims Ratio</strong></td><td>{claimsRatio}%</td></tr>
              <tr><td><strong>Lapse Rate</strong></td><td>{lapseRate}%</td></tr>
              <tr><td><strong>Total Clients</strong></td><td>{clients.length}</td></tr>
            </tbody>
          </table>
          <div style={{ marginTop: '1.5rem' }}>
            <button className="btn btn-primary" onClick={() => handleExport('IPEC PDF')}>↓ Download IPEC Return</button>
            <p style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)' }}>
              IPEC does not provide a public electronic-submission API — download the return above and submit it through IPEC's own portal or email.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
