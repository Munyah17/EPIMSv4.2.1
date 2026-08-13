import { useState, useEffect } from 'react'
import type { ToastMessage, Policy, PolicyStatus, CautionFlag } from '../types'
import type { ActivePanel } from '../App'
import { db } from '../lib/db'
import { formatDate } from '../lib/dateUtils'
import { exportPolicyReport, getPolicyReportPdfBase64 } from '../lib/exportUtils'
import { sendSystemEmail } from '../lib/mailService'
import { MAILBOXES } from '../lib/mailboxes'
import { useAuth } from '../contexts/AuthContext'
import NewPolicyModal from '../components/modals/NewPolicyModal'
import ViewPolicyModal from '../components/modals/ViewPolicyModal'
import EditPolicyModal from '../components/modals/EditPolicyModal'
import OnlinePaymentModal from '../components/modals/OnlinePaymentModal'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
  setActivePanel: (panel: ActivePanel) => void
}

export default function Policies({ showToast }: Props) {
  const { hasPermission } = useAuth()
  const [policies, setPolicies] = useState<Policy[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<PolicyStatus | 'all'>('all')
  const [productFilter, setProductFilter] = useState('all')
  const [showNew, setShowNew] = useState(false)
  const [viewPolicy, setViewPolicy] = useState<Policy | null>(null)
  const [editPolicy, setEditPolicy] = useState<Policy | null>(null)
  const [payPolicy, setPayPolicy] = useState<Policy | null>(null)
  const [cautionFlags, setCautionFlags] = useState<CautionFlag[]>([])

  useEffect(() => {
    db.policies.list().then(({ data, error }) => {
      if (error) showToast('error', 'Failed to load policies.')
      else if (data) setPolicies(data)
      setLoading(false)
    })
    db.cautionFlags.listActive().then(({ data }) => setCautionFlags(data))
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

  // Shared by auto-send-on-creation and the manual Print action — funeral
  // packages use a different document elsewhere in the flow, so both skip
  // the report for those.
  const getReportContext = async (policy: Policy) => {
    const [{ data: client }, { data: allProducts }] = await Promise.all([
      db.clients.get(policy.clientId),
      db.products.list(),
    ])
    const category = allProducts?.find(pr => pr.id === policy.productId)?.category
    return { client, category: category ?? '' }
  }

  const handleAdd = async (policy: Policy) => {
    const { data, error } = await db.policies.create(policy)
    if (error || !data) { showToast('error', 'Failed to create policy.'); return }
    setPolicies(prev => [data, ...prev])
    showToast('success', `Policy ${data.policyNumber} created successfully.`)
    setShowNew(false)

    // Best-effort — a failed report email shouldn't block policy creation
    // (already succeeded above), just show a heads-up if it doesn't go out.
    const { client, category } = await getReportContext(data)
    if (category !== 'funeral' && client?.email) {
      try {
        const attachmentBase64 = await getPolicyReportPdfBase64(data, client, category)
        const result = await sendSystemEmail({
          from: MAILBOXES.noreply,
          to: client.email,
          subject: `Your Policy ${data.policyNumber} — Documents Enclosed`,
          body: `Dear ${client.name},\n\nThank you for choosing us. Your policy ${data.policyNumber} (${data.productName}) is now active. Your policy report is attached for your records.\n\nRegards,\nTariqify IMS`,
          linkedTo: data.id,
          attachmentBase64,
          attachmentFilename: `${data.policyNumber}-Policy-Report.pdf`,
        })
        if (!result.delivered) showToast('warning', 'Policy created, but the document email could not be sent — check Settings → Notifications.')
      } catch {
        showToast('warning', 'Policy created, but the document email could not be sent.')
      }
    }
    // WhatsApp delivery of this document isn't wired up yet — it needs a
    // WhatsApp Business API integration (Twilio or Meta Cloud API) with its
    // own account/credentials, which don't exist in this project yet.
  }

  const handleEdit = async (updated: Policy) => {
    const { data, error } = await db.policies.update(updated.id, updated)
    if (error || !data) { showToast('error', 'Failed to update policy.'); return }
    setPolicies(prev => prev.map(p => p.id === data.id ? data : p))
    showToast('success', `Policy ${data.policyNumber} updated.`)
    setEditPolicy(null)
  }

  const handleApprove = async (policy: Policy) => {
    const { data, error } = await db.policies.update(policy.id, { status: 'active' })
    if (error || !data) { showToast('error', 'Failed to approve policy.'); return }
    setPolicies(prev => prev.map(p => p.id === data.id ? data : p))
    showToast('success', `Policy ${data.policyNumber} approved.`)
  }

  const handleReject = async (policy: Policy) => {
    const { data, error } = await db.policies.update(policy.id, { status: 'cancelled' })
    if (error || !data) { showToast('error', 'Failed to reject policy.'); return }
    setPolicies(prev => prev.map(p => p.id === data.id ? data : p))
    showToast('success', `Policy ${data.policyNumber} rejected.`)
  }

  const handleDelete = async (policy: Policy) => {
    if (!window.confirm(`Permanently delete policy ${policy.policyNumber}? This cannot be undone.`)) return
    const { error } = await db.policies.remove(policy.id)
    if (error) { showToast('error', error); return }
    setPolicies(prev => prev.filter(p => p.id !== policy.id))
    showToast('success', `Policy ${policy.policyNumber} deleted.`)
  }

  const handlePrint = async (policy: Policy) => {
    const { client, category } = await getReportContext(policy)
    if (category === 'funeral') {
      showToast('warning', 'Printed policy reports are not available for funeral packages.')
      return
    }
    if (!client) { showToast('error', 'Could not load client details for this policy.'); return }
    await exportPolicyReport(policy, client, category)
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
        {hasPermission('policies.create') && (
          <button type="button" className="btn btn-primary" onClick={() => setShowNew(true)}>+ New Policy</button>
        )}
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
                <th>Grower No.</th>
                <th>Insurer</th>
                <th>Start Date</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={9} className="td-empty">No policies found.</td></tr>
              ) : filtered.map(p => (
                <tr key={p.id}>
                  <td><span className="mono">{p.policyNumber}</span></td>
                  <td>{p.clientName}</td>
                  <td>{p.productName}</td>
                  <td>${p.coverAmount.toLocaleString()}</td>
                  <td>{p.growerNumber ?? '—'}</td>
                  <td>{p.insurer ?? '—'}</td>
                  <td>{formatDate(p.startDate)}</td>
                  <td>
                    <span className={`pill pill-${p.status}`}>{p.status}</span>
                    {cautionFlags.some(f => f.policyId === p.id) && (
                      <span className="pill pill-caution" title="Payment overdue — caution flag active">⚠ OVERDUE</span>
                    )}
                  </td>
                  <td>
                    <div className="action-btns">
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setViewPolicy(p)}>View</button>
                      {hasPermission('policies.edit') && (
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditPolicy(p)}>Edit</button>
                      )}
                      {p.status === 'pending' && hasPermission('policies.approve') && (
                        <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--success)' }} onClick={() => handleApprove(p)}>Approve</button>
                      )}
                      {p.status === 'pending' && hasPermission('policies.reject') && (
                        <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} onClick={() => handleReject(p)}>Reject</button>
                      )}
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => setPayPolicy(p)}>Pay Online</button>
                      {hasPermission('policies.delete') && (
                        <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} onClick={() => handleDelete(p)}>Delete</button>
                      )}
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
          onPrint={() => handlePrint(viewPolicy)}
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
            db.cautionFlags.listActive().then(({ data }) => setCautionFlags(data))
          }}
          showToast={showToast}
        />
      )}
    </div>
  )
}
