import { useState, useEffect } from 'react'
import type { ActivePanel } from '../App'
import type { ToastMessage, Policy, Claim, Payment, Lead, FraudCase } from '../types'
import { db } from '../lib/db'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
  setActivePanel: (panel: ActivePanel) => void
}

export default function Dashboard({ setActivePanel }: Props) {
  const [policies, setPolicies] = useState<Policy[]>([])
  const [claims, setClaims] = useState<Claim[]>([])
  const [payments, setPayments] = useState<Payment[]>([])
  const [leads, setLeads] = useState<Lead[]>([])
  const [fraudCases, setFraudCases] = useState<FraudCase[]>([])
  const [chartPeriod, setChartPeriod] = useState<'week' | 'month' | 'quarter'>('month')

  useEffect(() => {
    db.policies.list().then(({ data }) => { if (data) setPolicies(data) })
    db.claims.list().then(({ data }) => { if (data) setClaims(data) })
    db.payments.list().then(({ data }) => { if (data) setPayments(data) })
    db.leads.list().then(({ data }) => { if (data) setLeads(data) })
    db.fraudCases.list().then(({ data }) => { if (data) setFraudCases(data) })
  }, [])

  const activePolicies = policies.filter(p => p.status === 'active').length
  const pendingClaims = claims.filter(c => c.status === 'pending' || c.status === 'under_review').length
  const totalPremiums = payments.filter(p => p.status === 'completed').reduce((s, p) => s + p.amount, 0)
  const newLeads = leads.filter(l => l.status === 'new').length
  const fraudAlerts = fraudCases.filter(f => f.status === 'open').length

  const recentPolicies = [...policies].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5)

  const productBreakdown = [
    { name: 'Funeral Cover', count: policies.filter(p => p.productName.includes('Funeral')).length, cls: 'bar-fill-blue' },
    { name: 'Life Cover', count: policies.filter(p => p.productName.includes('Life')).length, cls: 'bar-fill-teal' },
    { name: 'Hospital Cash', count: policies.filter(p => p.productName.includes('Hospital')).length, cls: 'bar-fill-purple' },
    { name: 'Personal Accident', count: policies.filter(p => p.productName.includes('Accident')).length, cls: 'bar-fill-gold' },
  ]
  const maxCount = Math.max(...productBreakdown.map(p => p.count), 1)

  const lapseRate = policies.length
    ? (policies.filter(p => p.status === 'lapsed').length / policies.length * 100).toFixed(1)
    : '0.0'

  const lastPolicy = policies[policies.length - 1]
  const firstClaim = claims[0]
  const firstPayment = payments[0]
  const firstLead = leads[0]
  const firstFraud = fraudCases[0]

  const activity = [
    lastPolicy && { icon: '🛡', text: `New policy issued to ${lastPolicy.clientName}`, time: '2 hours ago', cls: 'activity-icon-blue' },
    firstClaim && { icon: '📋', text: `Claim ${firstClaim.claimNumber} submitted by ${firstClaim.clientName}`, time: '4 hours ago', cls: 'activity-icon-gold' },
    firstPayment && { icon: '💳', text: `Payment received from ${firstPayment.clientName} — $${firstPayment.amount}`, time: '5 hours ago', cls: 'activity-icon-teal' },
    firstLead && { icon: '🎯', text: `New lead: ${firstLead.name} via ${firstLead.source}`, time: '1 day ago', cls: 'activity-icon-purple' },
    firstFraud && { icon: '⚠', text: `Fraud alert on claim ${firstFraud.claimNumber} — Score ${firstFraud.fraudScore}%`, time: '2 days ago', cls: 'activity-icon-danger' },
  ].filter(Boolean) as { icon: string; text: string; time: string; cls: string }[]

  return (
    <div className="panel">
      <div className="stats-grid">
        <div className="stat-card stat-card-clickable" onClick={() => setActivePanel('policies')}>
          <div className="stat-icon stat-icon-blue">🛡</div>
          <div className="stat-body">
            <div className="stat-value">{activePolicies}</div>
            <div className="stat-label">Active Policies</div>
            <div className="stat-delta positive">+3 this week</div>
          </div>
        </div>
        <div className="stat-card stat-card-clickable" onClick={() => setActivePanel('claims')}>
          <div className="stat-icon stat-icon-gold">📋</div>
          <div className="stat-body">
            <div className="stat-value">{pendingClaims}</div>
            <div className="stat-label">Pending Claims</div>
            <div className="stat-delta negative">{pendingClaims > 0 ? 'Requires attention' : 'All clear'}</div>
          </div>
        </div>
        <div className="stat-card stat-card-clickable" onClick={() => setActivePanel('payments')}>
          <div className="stat-icon stat-icon-teal">💳</div>
          <div className="stat-body">
            <div className="stat-value">${totalPremiums.toFixed(0)}</div>
            <div className="stat-label">Premiums Collected</div>
            <div className="stat-delta positive">This month</div>
          </div>
        </div>
        <div className="stat-card stat-card-clickable" onClick={() => setActivePanel('leads')}>
          <div className="stat-icon stat-icon-purple">🎯</div>
          <div className="stat-body">
            <div className="stat-value">{newLeads}</div>
            <div className="stat-label">New Leads</div>
            <div className="stat-delta positive">+{newLeads} this week</div>
          </div>
        </div>
        <div className="stat-card stat-card-clickable" onClick={() => setActivePanel('fraud')}>
          <div className="stat-icon stat-icon-danger">⚠</div>
          <div className="stat-body">
            <div className="stat-value">{fraudAlerts}</div>
            <div className="stat-label">Fraud Alerts</div>
            <div className="stat-delta negative">{fraudAlerts > 0 ? 'Investigate now' : 'All clear'}</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon stat-icon-danger">📉</div>
          <div className="stat-body">
            <div className="stat-value">{lapseRate}%</div>
            <div className="stat-label">Lapse Rate</div>
            <div className="stat-delta negative">Monitor closely</div>
          </div>
        </div>
      </div>

      <div className="dashboard-grid">
        <div className="card dashboard-card-wide">
          <div className="card-header">
            <h3 className="card-title">Recent Policies</h3>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setActivePanel('policies')}>View All</button>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Policy No.</th>
                <th>Client</th>
                <th>Product</th>
                <th>Premium</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {recentPolicies.length === 0 ? (
                <tr><td colSpan={5} className="td-empty">No policies yet.</td></tr>
              ) : recentPolicies.map(p => (
                <tr key={p.id}>
                  <td><span className="mono">{p.policyNumber}</span></td>
                  <td>{p.clientName}</td>
                  <td>{p.productName}</td>
                  <td>${p.premium.toFixed(2)}/mo</td>
                  <td><span className={`pill pill-${p.status}`}>{p.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Portfolio Mix</h3>
            <div className="chart-tabs">
              {(['week', 'month', 'quarter'] as const).map(p => (
                <button
                  type="button"
                  key={p}
                  className={`chart-tab${chartPeriod === p ? ' active' : ''}`}
                  onClick={() => setChartPeriod(p)}
                >{p}</button>
              ))}
            </div>
          </div>
          <div className="bar-chart">
            {productBreakdown.map(pb => (
              <div key={pb.name} className="bar-item">
                <div className="bar-label">{pb.name}</div>
                <div className="bar-track">
                  <div
                    className={`bar-fill ${pb.cls}`}
                    style={{ width: `${(pb.count / maxCount) * 100}%` }}
                  />
                </div>
                <div className="bar-value">{pb.count}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Recent Activity</h3>
          </div>
          <div className="activity-list">
            {activity.map((a, i) => (
              <div key={i} className="activity-item">
                <div className={`activity-icon ${a.cls}`}>{a.icon}</div>
                <div className="activity-body">
                  <div className="activity-text">{a.text}</div>
                  <div className="activity-time">{a.time}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Quick Actions</h3>
          </div>
          <div className="quick-actions">
            <button type="button" className="btn btn-primary btn-full" onClick={() => setActivePanel('policies')}>
              🛡 New Policy
            </button>
            <button type="button" className="btn btn-secondary btn-full" onClick={() => setActivePanel('claims')}>
              📋 New Claim
            </button>
            <button type="button" className="btn btn-ghost btn-full" onClick={() => setActivePanel('clients')}>
              👥 Register Client
            </button>
            <button type="button" className="btn btn-ghost btn-full" onClick={() => setActivePanel('payments')}>
              💳 Record Payment
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
