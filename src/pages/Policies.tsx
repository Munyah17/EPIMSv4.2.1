import { useState, useEffect } from 'react'
import type { ToastMessage, Policy, PolicyStatus } from '../types'
import type { ActivePanel } from '../App'
import { db } from '../lib/db'
import { cautionStore } from '../lib/cautionStore'
import NewPolicyModal from '../components/modals/NewPolicyModal'
import ViewPolicyModal from '../components/modals/ViewPolicyModal'
import EditPolicyModal from '../components/modals/EditPolicyModal'
import OnlinePaymentModal from '../components/modals/OnlinePaymentModal'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
  setActivePanel: (panel: ActivePanel) => void
}

export default function Policies({ showToast }: Props) {
  const [policies, setPolicies] = useState<Policy[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<PolicyStatus | 'all'>('all')
  const [productFilter, setProductFilter] = useState('all')
  const [showNew, setShowNew] = useState(false)
  const [viewPolicy, setViewPolicy] = useState<Policy | null>(null)
  const [editPolicy, setEditPolicy] = useState<Policy | null>(null)
  const [payPolicy, setPayPolicy] = useState<Policy | null>(null)
  const cautionFlags = cautionStore.listActive()

  useEffect(() => {
    db.policies.list().then(({ data, error }) => {
      if (error) showToast('error', 'Failed to load policies.')
      else if (data) setPolicies(data)
      setLoading(false)
    })
  }, [showToast])

  const products = [...new Set(policies.map(p => p.productName))]

  const filtered = policies.filter(p => {
    const matchSearch = p.policyNumber.toLowerCase().includes(search.toLowerCase()) ||
      p.clientName.toLowerCase().includes(search.toLowerCase())
    const matchStatus = statusFilter === 'all' || p.status === statusFilter
    const matchProduct = productFilter === 'all' || p.productName === productFilter
    return matchSearch && matchStatus && matchProduct
  })

  const statusCounts = {
    all: policies.length,
    active: policies.filter(p => p.status === 'active').length,
    lapsed: policies.filter(p => p.status === 'lapsed').length,
    pending: policies.filter(p => p.status === 'pending').length,
    cancelled: policies.filter(p => p.status === 'cancelled').length,
    expired: policies.filter(p => p.status === 'expired').length,
  }

  const handleAdd = async (policy: Policy) => {
    const { data, error } = await db.policies.create(policy)
    if (error || !data) { showToast('error', 'Failed to create policy.'); return }
    setPolicies(prev => [data, ...prev])
    showToast('success', `Policy ${data.policyNumber} created successfully.`)
    setShowNew(false)
  }

  const handleEdit = async (updated: Policy) => {
    const { data, error } = await db.policies.update(updated.id, updated)
    if (error || !data) { showToast('error', 'Failed to update policy.'); return }
    setPolicies(prev => prev.map(p => p.id === data.id ? data : p))
    showToast('success', `Policy ${data.policyNumber} updated.`)
    setEditPolicy(null)
  }

  return (
    <div className="panel">
      <div className="panel-toolbar">
        <div className="filter-row">
          <input
            className="search-input"
            placeholder="Search policy number or client…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <select className="filter-select" value={statusFilter} onChange={e => setStatusFilter(e.target.value as PolicyStatus | 'all')}>
            <option value="all">All Status ({statusCounts.all})</option>
            <option value="active">Active ({statusCounts.active})</option>
            <option value="lapsed">Lapsed ({statusCounts.lapsed})</option>
            <option value="pending">Pending ({statusCounts.pending})</option>
            <option value="cancelled">Cancelled ({statusCounts.cancelled})</option>
            <option value="expired">Expired ({statusCounts.expired})</option>
          </select>
          <select className="filter-select" value={productFilter} onChange={e => setProductFilter(e.target.value)}>
            <option value="all">All Products</option>
            {products.map(pr => <option key={pr} value={pr}>{pr}</option>)}
          </select>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setShowNew(true)}>+ New Policy</button>
      </div>

      <div className="card">
        {loading ? (
          <div className="empty-state">Loading policies…</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Policy No.</th>
                <th>Client</th>
                <th>Product</th>
                <th>Cover</th>
                <th>Insurer</th>
                <th>Start Date</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={8} className="td-empty">No policies found.</td></tr>
              ) : filtered.map(p => (
                <tr key={p.id}>
                  <td><span className="mono">{p.policyNumber}</span></td>
                  <td>{p.clientName}</td>
                  <td>{p.productName}</td>
                  <td>${p.coverAmount.toLocaleString()}</td>
                  <td>{p.insurer ?? '—'}</td>
                  <td>{p.startDate}</td>
                  <td>
                    <span className={`pill pill-${p.status}`}>{p.status}</span>
                    {cautionFlags.some(f => f.policyId === p.id) && (
                      <span className="pill pill-caution" title="Payment overdue — caution flag active">⚠ OVERDUE</span>
                    )}
                  </td>
                  <td>
                    <div className="action-btns">
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setViewPolicy(p)}>View</button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditPolicy(p)}>Edit</button>
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => setPayPolicy(p)}>Pay Online</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showNew && (
        <NewPolicyModal
          onClose={() => setShowNew(false)}
          onSave={handleAdd}
          showToast={showToast}
        />
      )}
      {viewPolicy && (
        <ViewPolicyModal
          policy={viewPolicy}
          onClose={() => setViewPolicy(null)}
          onEdit={() => { setEditPolicy(viewPolicy); setViewPolicy(null) }}
        />
      )}
      {editPolicy && (
        <EditPolicyModal
          policy={editPolicy}
          onClose={() => setEditPolicy(null)}
          onSave={handleEdit}
        />
      )}
      {payPolicy && (
        <OnlinePaymentModal
          policy={payPolicy}
          onClose={() => setPayPolicy(null)}
          onSuccess={() => {
            showToast('success', `Payment confirmed for ${payPolicy.policyNumber}.`)
            setPayPolicy(null)
          }}
          showToast={showToast}
        />
      )}
    </div>
  )
}
