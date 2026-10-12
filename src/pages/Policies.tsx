import { useState, useEffect } from 'react'
import type { ToastMessage, Policy, PolicyStatus, CautionFlag, Client } from '../types'
import type { ActivePanel } from '../App'
import { db } from '../lib/db'
import { formatDate } from '../lib/dateUtils'
import { exportPolicyReport, getPolicyReportPdfBase64, exportToExcel, exportToCsv, exportReportToPdf } from '../lib/exportUtils'
import { treatyRows, TREATY_HEADERS } from '../lib/treatyReport'
import { toIsoDate } from '../lib/dateUtils'
import { notifyPolicyRegistered, notifyRegistrationFailed, ADMIN_ALERT_NUMBERS } from '../lib/signupNotifications'
import { notifyPhone } from '../lib/notify'
import { COMPANY_NAME } from '../lib/company'
import { recordActivity } from '../lib/activityLog'
import { sendSystemEmail } from '../lib/mailService'
import { MAILBOXES } from '../lib/mailboxes'
import { useAuth } from '../contexts/AuthContext'
import { paymentCurrencyStatus, PAYMENT_CURRENCY_LABEL, PAYMENT_CURRENCY_CLASS } from '../lib/policyLifecycle'
import NewPolicyModal from '../components/modals/NewPolicyModal'
import ViewPolicyModal from '../components/modals/ViewPolicyModal'
import EditPolicyModal from '../components/modals/EditPolicyModal'
import OnlinePaymentModal from '../components/modals/OnlinePaymentModal'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
  setActivePanel: (panel: ActivePanel) => void
  /** Product category to narrow to on open, set when another page sends the
   *  user here for a specific book (e.g. Agriculture Insurance). */
  initialCategory?: string
}

// No .pill-waiting_period class exists — the bare .pill has no background,
// so a waiting-period policy rendered as an invisible tag. Amber "pending"
// is the closest honest state (same mapping as policyholder/MyPolicies.tsx).
const STATUS_PILL: Partial<Record<PolicyStatus, string>> = {
  waiting_period: 'pill-pending',
}

export default function Policies({ showToast, initialCategory }: Props) {
  const { hasPermission, user } = useAuth()
  const [policies, setPolicies] = useState<Policy[]>([])
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<PolicyStatus | 'all'>('all')
  const [productFilter, setProductFilter] = useState('all')
  // Individual vs group/corporate — the two books are kept on separate
  // tabs: different billing (monthly client debit vs org invoice),
  // different people to phone, different rows to reconcile.
  const [scopeFilter, setScopeFilter] = useState<'all' | 'individual' | 'group'>('all')
  const categoryFilter = initialCategory && !initialCategory.startsWith('__') ? initialCategory : undefined
  const [showNew, setShowNew] = useState(false)
  const [viewPolicy, setViewPolicy] = useState<Policy | null>(null)
  const [editPolicy, setEditPolicy] = useState<Policy | null>(null)
  const [payPolicy, setPayPolicy] = useState<Policy | null>(null)
  const [cautionFlags, setCautionFlags] = useState<CautionFlag[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [suggestOpen, setSuggestOpen] = useState(false)

  // Sidebar "Add New Policy" arrives as initialCategory '__new' — open the
  // modal straight onto the page instead of just navigating to the list.
  // '__individual'/'__group' land on the matching scope tab.
  useEffect(() => {
    if (initialCategory === '__new') setShowNew(true)
    if (initialCategory === '__individual') setScopeFilter('individual')
    else if (initialCategory === '__group') setScopeFilter('group')
  }, [initialCategory])

  useEffect(() => {
    db.policies.list().then(({ data, error }) => {
      if (error) showToast('error', 'Failed to load policies.')
      else if (data) setPolicies(data)
      setLoading(false)
    })
    // Secondary loads feed the caution-flag badges and the search's
    // phone/ID matching — a silent failure would show a clean list that
    // isn't clean, so errors are surfaced rather than swallowed.
    db.cautionFlags.listActive().then(({ data, error }) => {
      if (error) showToast('error', 'Failed to load caution flags — overdue badges may be missing.')
      else setCautionFlags(data)
    })
    db.clients.list().then(({ data, error }) => {
      if (error) showToast('error', 'Failed to load client contact details — searching by phone or ID will miss matches.')
      else if (data) setClients(data)
    })
  }, [showToast])

  const products = [...new Set(policies.map(p => p.productName))]
  const clientById = new Map(clients.map(c => [c.id, c]))

  // Search matches policy number, client name, grower number, product name,
  // and the client's phone/national ID — grower number is ranked first
  // since it's the field agriculture staff look up by most.
  const q = search.trim().toLowerCase()
  const matchScore = (p: Policy): number => {
    if (!q) return 0
    const client = clientById.get(p.clientId)
    const grower = (p.growerNumber ?? '').toLowerCase()
    if (grower.startsWith(q)) return 0
    if (grower.includes(q)) return 1
    const fields = [p.policyNumber, p.clientName, p.groupName, p.productName, client?.phone, client?.nationalId]
      .filter(Boolean).map(v => String(v).toLowerCase())
    if (fields.some(f => f.startsWith(q))) return 2
    if (fields.some(f => f.includes(q))) return 3
    return -1
  }

  const isGroupPolicy = (p: Policy) => !!p.coverScope && p.coverScope !== 'individual'

  const filtered = policies.filter(p => {
    const matchSearch = matchScore(p) >= 0
    const matchStatus = statusFilter === 'all' || p.status === statusFilter
    const matchProduct = productFilter === 'all' || p.productName === productFilter
    const matchCategory = !categoryFilter || p.productCategory === categoryFilter
    const matchScope = scopeFilter === 'all' || (scopeFilter === 'group') === isGroupPolicy(p)
    return matchSearch && matchStatus && matchProduct && matchCategory && matchScope
  })

  const suggestions = q.length < 2 ? [] : [...policies]
    .map(p => ({ p, score: matchScore(p) }))
    .filter(r => r.score >= 0)
    .sort((a, b) => a.score - b.score)
    .slice(0, 6)

  const statusCounts = {
    all: policies.length,
    active: policies.filter(p => p.status === 'active').length,
    waiting_period: policies.filter(p => p.status === 'waiting_period').length,
    lapsed: policies.filter(p => p.status === 'lapsed').length,
    defaulted: policies.filter(p => p.status === 'defaulted').length,
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

  const handleTreatyExport = async (format: 'xlsx' | 'csv' | 'pdf') => {
    setExporting(true)
    try {
      // The holder's ID/DOB/gender live on the client row — fetched on
      // demand so a page that never exports never pays for the join.
      const { data: clients } = await db.clients.list()
      const byId = new Map((clients ?? []).map(c => [c.id, c]))
      const rows = treatyRows(filtered, byId)
      const base = `policy-report-${toIsoDate(new Date())}`
      if (format === 'xlsx') {
        await exportToExcel(`${base}.xlsx`, 'Policy Report', TREATY_HEADERS, rows)
      } else if (format === 'csv') {
        exportToCsv(`${base}.csv`, TREATY_HEADERS, rows.map(r => r.map(String)))
      } else {
        // The PDF carries the book's totals so a reinsurer reads the
        // bottom line before the rows.
        const stats = [
          { label: 'Policies', value: String(filtered.length) },
          { label: 'Insured Heads', value: String(rows.length) },
          { label: 'Total Sum Assured', value: `$${rows.reduce((s, r) => s + Number(r[10] || 0), 0).toLocaleString()}` },
          { label: 'Total Premium', value: `$${rows.reduce((s, r) => s + Number(r[12] || 0), 0).toFixed(2)}` },
        ]
        await exportReportToPdf(`${base}.pdf`, 'Policy Report',
          `Generated ${formatDate(new Date())} by Motions IMS`, stats, TREATY_HEADERS, rows)
      }
      showToast('success', `Policy report exported — ${filtered.length} policies.`)
    } catch {
      showToast('error', 'Failed to export the policy report.')
    }
    setExporting(false)
  }

  const handleAdd = async (policy: Policy) => {
    const { data, error } = await db.policies.create(policy)
    // Show the real reason: "failed to create" tells a user nothing when the
    // refusal is a duplicate they can actually do something about.
    if (error || !data) {
      showToast('error', error ?? 'Failed to create policy.')
      void notifyRegistrationFailed('Policy registration', `${policy.clientName} / ${policy.productName} — ${error ?? 'unknown error'}`)
      return
    }
    setPolicies(prev => [data, ...prev])
    showToast('success', `Policy ${data.policyNumber} created successfully.`)
    setShowNew(false)

    // Best-effort — a failed report email shouldn't block policy creation
    // (already succeeded above), just show a heads-up if it doesn't go out.
    const { client, category } = await getReportContext(data)

    // Tell the new client they're covered, and the office that a policy
    // landed. Never awaited: the policy already exists either way.
    if (client) void notifyPolicyRegistered(data, client)
    if (category !== 'funeral' && client?.email) {
      try {
        const attachmentBase64 = await getPolicyReportPdfBase64(data, client, category)
        const result = await sendSystemEmail({
          from: MAILBOXES.noreply,
          to: client.email,
          subject: `Your Policy ${data.policyNumber}: Documents Enclosed`,
          body: `Dear ${client.name},\n\nThank you for choosing us. Your policy ${data.policyNumber} (${data.productName}) is now active. Your policy report is attached for your records.\n\nRegards,\nTariqify IMS`,
          linkedTo: data.id,
          attachmentBase64,
          attachmentFilename: `${data.policyNumber}-Policy-Report.pdf`,
        })
        if (!result.delivered) showToast('warning', 'Policy created, but the document email could not be sent; check Settings → Notifications.')
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
    // Agriculture has no waiting period at all — approval activates it
    // instantly, same as a staff-created agriculture policy.
    const { category } = await getReportContext(policy)
    const nextStatus = category === 'agriculture' ? 'active' : 'waiting_period'
    const { data, error } = await db.policies.update(policy.id, { status: nextStatus })
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

  /** A defaulted policy is paused, not dead — Admin/Super Admin can put it
   *  back into waiting_period, where it resumes the normal billing cycle. */
  const handleReenable = async (policy: Policy) => {
    const { data, error } = await db.policies.update(policy.id, { status: 'waiting_period' })
    if (error || !data) { showToast('error', 'Failed to re-enable policy.'); return }
    setPolicies(prev => prev.map(p => p.id === data.id ? data : p))
    showToast('success', `Policy ${data.policyNumber} re-enabled (waiting period).`)
  }

  /** Manual monthly invoice for a group-cover policy — the same row the
   *  cron writes automatically on the first of the month; the unique
   *  (policy, period) key means generating twice just returns the first
   *  invoice, never a duplicate. */
  const handleInvoice = async (policy: Policy) => {
    const now = new Date()
    const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const { data, error, created } = await db.invoices.create(policy, period, user?.name ?? 'staff')
    if (error) { showToast('error', error); return }
    if (!data) { showToast('error', 'Failed to create invoice.'); return }
    if (!created) {
      showToast('info', `Invoice ${data.invoiceNumber} already exists for ${period} — nothing new issued.`)
      return
    }
    showToast('success', `Invoice ${data.invoiceNumber} issued — $${data.amount.toFixed(2)} for ${data.heads} member(s), due ${data.dueDate}.`)

    // The client hears about their bill on the phone the moment it exists —
    // same auto-SMS rule every billing event follows.
    const { data: client } = await db.clients.get(policy.clientId)
    const org = policy.groupName ?? policy.clientName
    const msg = `${COMPANY_NAME}: Invoice ${data.invoiceNumber} issued for ${org} (${policy.policyNumber}) — $${data.amount.toFixed(2)} for ${data.heads} member(s), period ${period}, due ${data.dueDate}.`
    if (client?.phone) notifyPhone(client.phone, msg, 'payment', data.invoiceNumber)
    // The organisation's named contact person gets the reminder on their
    // own line — usually a different person from the account holder.
    if (policy.groupId) {
      const { data: group } = await db.groups.get(policy.groupId)
      if (group?.contactPhone && group.contactPhone.replace(/\D/g, '').slice(-9) !== (client?.phone ?? '').replace(/\D/g, '').slice(-9)) {
        notifyPhone(group.contactPhone, msg, 'payment', data.invoiceNumber)
      }
    }
    void recordActivity({ action: 'policy.updated', actor: { id: user?.id, name: user?.name ?? 'Staff', role: user?.role ?? '' }, entityType: 'policy', entityId: policy.id, entityLabel: `${data.invoiceNumber} for ${policy.policyNumber}`, detail: `Invoice issued — $${data.amount.toFixed(2)}, ${data.heads} heads, period ${period}` })
  }

  const handleDelete = async (policy: Policy) => {
    // Checked up front so the confirmation can say exactly what will be
    // destroyed, instead of failing afterwards with a generic refusal.
    const { claims, payments, checkouts } = await db.policies.deletionBlockers(policy.id)
    const attached = [
      claims > 0 && `${claims} claim${claims === 1 ? '' : 's'}`,
      payments > 0 && `${payments} payment${payments === 1 ? '' : 's'}`,
      checkouts > 0 && `${checkouts} online checkout record${checkouts === 1 ? '' : 's'}`,
    ].filter(Boolean).join(', ')

    if (!attached) {
      if (!window.confirm(`Permanently delete policy ${policy.policyNumber}? This cannot be undone.`)) return
      const { error } = await db.policies.remove(policy.id)
      if (error) { showToast('error', error); return }
      setPolicies(prev => prev.filter(p => p.id !== policy.id))
      void recordActivity({
        action: 'policy.deleted', actor: { id: user?.id, name: user?.name ?? 'Unknown', role: user?.role ?? 'unknown' },
        entityType: 'policy', entityId: policy.id, entityLabel: policy.policyNumber,
        detail: `${policy.clientName}, ${policy.productName}`, severity: 'warning',
      })
      showToast('success', `Policy ${policy.policyNumber} deleted.`)
      for (const number of ADMIN_ALERT_NUMBERS) {
        notifyPhone(number, `${COMPANY_NAME}: Policy ${policy.policyNumber} (${policy.clientName}) was DELETED by ${user?.name ?? 'a staff member'}.`, 'system', policy.policyNumber)
      }
      return
    }

    const reason = window.prompt(
      `Policy ${policy.policyNumber} has ${attached} recorded against it.\n\n`
      + `Deleting it will also permanently remove ${attached}. Financial records are not recoverable once removed.\n\n`
      + 'If you are sure, enter a reason for the record:',
    )
    if (reason === null) return
    if (!reason.trim()) { showToast('warning', 'A reason is required to delete a policy with attached records.'); return }

    // Logged before the delete, while the detail still exists to record.
    await recordActivity({
      action: 'policy.deleted', actor: { id: user?.id, name: user?.name ?? 'Unknown', role: user?.role ?? 'unknown' },
      entityType: 'policy', entityId: policy.id, entityLabel: policy.policyNumber,
      detail: `${policy.clientName}, ${policy.productName}. Also removed ${attached}. Reason: ${reason.trim()}`,
      severity: 'warning',
    })

    const { error } = await db.policies.remove(policy.id, { force: true })
    if (error) { showToast('error', error); return }
    setPolicies(prev => prev.filter(p => p.id !== policy.id))
    showToast('success', `Policy ${policy.policyNumber} and its ${attached} deleted. Recorded in the activity log.`)
    for (const number of ADMIN_ALERT_NUMBERS) {
      notifyPhone(number, `${COMPANY_NAME}: Policy ${policy.policyNumber} (${policy.clientName}) was DELETED by ${user?.name ?? 'a staff member'}, along with ${attached}.`, 'system', policy.policyNumber)
    }
  }

  const handlePrint = async (policy: Policy) => {
    const { client, category } = await getReportContext(policy)
    if (!client) { showToast('error', 'Could not load client details for this policy.'); return }
    await exportPolicyReport(policy, client, category)
  }

  return (
    <div className="panel">
      <div className="panel-toolbar">
        <div className="filter-row">
          <div style={{ position: 'relative', flex: 1, minWidth: 220 }}>
            <input
              className="search-input"
              placeholder="Search policy no., client, phone, ID, grower no., insurer, product…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              onFocus={() => setSuggestOpen(true)}
              onBlur={() => setTimeout(() => setSuggestOpen(false), 150)}
              style={{ width: '100%' }}
            />
            {suggestOpen && suggestions.length > 0 && (
              <div className="phone-input-dropdown" style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, width: 'auto', maxWidth: 'none', zIndex: 20 }}>
                {suggestions.map(({ p }) => (
                  <button
                    key={p.id}
                    type="button"
                    className="phone-input-option"
                    style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', width: '100%', textAlign: 'left' }}
                    onMouseDown={() => { setViewPolicy(p); setSuggestOpen(false) }}
                  >
                    <span><strong className="mono">{p.policyNumber}</strong>&nbsp;· {p.clientName}</span>
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                      {p.growerNumber ? `Grower No. ${p.growerNumber} · ` : ''}{p.productName} · {p.status.replace('_', ' ')}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <select className="filter-select" value={statusFilter} onChange={e => setStatusFilter(e.target.value as PolicyStatus | 'all')}>
            <option value="all">All Status ({statusCounts.all})</option>
            <option value="active">Active ({statusCounts.active})</option>
            <option value="waiting_period">Waiting Period ({statusCounts.waiting_period})</option>
            <option value="lapsed">Lapsed ({statusCounts.lapsed})</option>
            <option value="defaulted">Paused / Defaulted ({statusCounts.defaulted})</option>
            <option value="pending">Pending ({statusCounts.pending})</option>
            <option value="cancelled">Cancelled ({statusCounts.cancelled})</option>
            <option value="expired">Expired ({statusCounts.expired})</option>
          </select>
          <select className="filter-select" value={productFilter} onChange={e => setProductFilter(e.target.value)}>
            <option value="all">All Products</option>
            {products.map(pr => <option key={pr} value={pr}>{pr}</option>)}
          </select>
        </div>
        {/* The reinsurer's treaty layout — one row per insured head,
            fixed formats (d-MMM-yyyy dates, canonical IDs) so month-to-
            month submissions diff cleanly. */}
        <div className="action-menu" style={{ position: 'relative' }}>
          <button type="button" className="btn btn-ghost" disabled={exporting} onClick={() => setExportOpen(o => !o)}>
            {exporting ? 'Exporting…' : 'Export Policy Report ▾'}
          </button>
          {exportOpen && (
            <>
              <div className="dropdown-backdrop" onClick={() => setExportOpen(false)} />
              <div className="profile-dropdown" style={{ minWidth: 170 }}>
                {([['xlsx', 'Excel (.xlsx)'], ['csv', 'CSV (.csv)'], ['pdf', 'PDF (.pdf)']] as const).map(([f, label]) => (
                  <button key={f} type="button" className="dropdown-item" style={{ width: '100%', border: 'none', background: 'none', cursor: 'pointer' }}
                    onClick={() => { setExportOpen(false); void handleTreatyExport(f) }}>
                    {label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        {hasPermission('policies.create') && (
          <button type="button" className="btn btn-primary" onClick={() => setShowNew(true)}>+ New Policy</button>
        )}
      </div>

      {/* Individual and group books separated — the tabs carry counts so
          an empty group book is visible, not just absent. */}
      <div className="tab-row">
        {([
          ['all', 'All Policies', policies.length],
          ['individual', 'Individual', policies.filter(p => !isGroupPolicy(p)).length],
          ['group', 'Group & Corporate', policies.filter(isGroupPolicy).length],
        ] as const).map(([key, label, count]) => (
          <button key={key} type="button" className={`tab-item${scopeFilter === key ? ' active' : ''}`} onClick={() => setScopeFilter(key)}>
            {label} ({count})
          </button>
        ))}
      </div>

      <div className="card">
        {loading ? (
          <div className="empty-state">Loading policies…</div>
        ) : (
          <div className="tbl-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Policy No.</th>
                <th>Client</th>
                <th>Product</th>
                <th>Cover</th>
                <th>Grower No.</th>
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
                  <td>
                    {p.clientName}
                    {p.groupName && (
                      <div style={{ fontSize: 11, marginTop: 2 }}>
                        <span className={`pill ${p.coverScope === 'corporate' ? 'pill-blue' : p.coverScope === 'team' ? 'pill-success' : 'pill-purple'}`}>
                          {p.coverScope === 'corporate' ? 'Corporate' : p.coverScope === 'team' ? 'Team' : 'Group'} · {p.groupName}
                        </span>
                      </div>
                    )}
                  </td>
                  <td>{p.productName}</td>
                  <td>${p.coverAmount.toLocaleString()}</td>
                  <td>{p.growerNumber ?? '—'}</td>
                  <td>{formatDate(p.startDate)}</td>
                  <td>
                    <div className="status-pills">
                      <span className={`pill ${STATUS_PILL[p.status] ?? `pill-${p.status}`}`}>{p.status.replace('_', ' ')}</span>
                      <span className={`pill pill-inline ${PAYMENT_CURRENCY_CLASS[paymentCurrencyStatus(p)]}`}>{PAYMENT_CURRENCY_LABEL[paymentCurrencyStatus(p)]}</span>
                      {cautionFlags.some(f => f.policyId === p.id) && (
                        <span className="pill pill-caution" title="Payment overdue, caution flag active">⚠ OVERDUE</span>
                      )}
                    </div>
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
                      {p.status === 'defaulted' && (user?.role === 'admin' || user?.role === 'super_admin') && (
                        <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--success)' }} onClick={() => handleReenable(p)}>Re-enable</button>
                      )}
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => setPayPolicy(p)}>Pay Online</button>
                      {p.groupId && hasPermission('payments.create') && (
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => handleInvoice(p)}>Invoice</button>
                      )}
                      {hasPermission('policies.delete') && (
                        <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} onClick={() => handleDelete(p)}>Delete</button>
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
          showToast={showToast}
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
            db.cautionFlags.listActive().then(({ data, error }) => { if (!error) setCautionFlags(data) })
          }}
          showToast={showToast}
        />
      )}
    </div>
  )
}
