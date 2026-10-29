import { useState, useEffect, Fragment } from 'react'
import type { ToastMessage, Client, Policy, Lead } from '../types'
import type { ActivePanel } from '../App'
import { db } from '../lib/db'
import type { CheckoutSessionRow, PendingPolicyRow } from '../lib/db'
import { formatDate, formatDateTime } from '../lib/dateUtils'
import { notifyPolicyRegistered, notifyRegistrationFailed } from '../lib/signupNotifications'
import { serverReachable } from '../lib/notify'
import { sendSystemEmail } from '../lib/mailService'
import { getPolicyReportPdfBase64 } from '../lib/exportUtils'
import { MAILBOXES } from '../lib/mailboxes'
import NewPolicyModal from '../components/modals/NewPolicyModal'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
  setActivePanel: (panel: ActivePanel) => void
}

/**
 * Abandoned signups — clients on the register holding NO policy of any
 * status. Most arrived through the website/agent signup flow where the
 * payer never finished checkout: the client row stayed (for retry), the
 * pending policy was swept by the cleanup cron, and no money was ever
 * taken — payments can only exist against a policy. The same uncovered
 * set the dashboard card counts and the reconciliation sweep flags.
 * A policy assigned from here goes through the exact
 * registration/notification path as Clients → Assign Policy, and the row
 * leaves this list the moment cover exists.
 */
export default function ClientsNoPolicy({ showToast, setActivePanel }: Props) {
  const [clients, setClients] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [assignPolicyClient, setAssignPolicyClient] = useState<Client | null>(null)
  // Evidence for WHY each record stalled — loaded alongside the clients.
  // Failures are swallowed per-source: a reason that can't be proven is
  // shown as "no payment attempt on record", never as a broken page.
  const [checkouts, setCheckouts] = useState<CheckoutSessionRow[]>([])
  const [pendingPolicies, setPendingPolicies] = useState<PendingPolicyRow[]>([])
  const [leadRows, setLeadRows] = useState<Lead[]>([])
  const [productNames, setProductNames] = useState<Map<string, string>>(new Map())
  const [expandedId, setExpandedId] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([
      db.clients.list(),
      db.signupEvidence.checkouts(),
      db.signupEvidence.pendingPolicies(),
      db.leads.list(),
      db.products.list(),
    ]).then(([clientsRes, checkoutsRes, pendingRes, leadsRes, productsRes]) => {
      if (clientsRes.error) showToast('error', 'Failed to load clients.')
      else if (clientsRes.data) setClients(clientsRes.data.filter(c => (c.policyCount ?? 0) === 0))
      setCheckouts(checkoutsRes)
      setPendingPolicies(pendingRes)
      setLeadRows(leadsRes.data ?? [])
      setProductNames(new Map((productsRes.data ?? []).map(p => [p.id, p.name])))
      setLoading(false)
    }).catch(() => { showToast('error', 'Failed to load clients.'); setLoading(false) })
  }, [showToast])

  const filtered = clients.filter(c =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    c.phone.includes(search) ||
    (c.nationalId ?? '').includes(search) ||
    c.email.toLowerCase().includes(search.toLowerCase())
  )

  // Everything recorded about one abandoned signup — the payer's checkout
  // attempts (matched by national ID, the same key dedup uses), any
  // pre-payment pending policy, and the mirrored sales lead.
  const evidenceFor = (c: Client) => ({
    checkouts: checkouts.filter(s =>
      (c.nationalId && s.client_national_id === c.nationalId) ||
      (!!c.email && !!s.client_email && s.client_email.toLowerCase() === c.email.toLowerCase()) ||
      (!!s.client_phone && s.client_phone === c.phone)),
    pending: pendingPolicies.filter(p => p.client_id === c.id),
    lead: leadRows.find(l =>
      (!!c.email && !!l.email && l.email.toLowerCase() === c.email.toLowerCase()) ||
      l.phone === c.phone),
  })

  // Most recent evidence wins — a payer who tried twice and gave up shows
  // the LAST attempt's fate, not the first.
  const reasonFor = (c: Client): { label: string; pill: string } => {
    const ev = evidenceFor(c)
    const latest = ev.checkouts[0] // checkouts arrive newest-first
    if (latest?.status === 'paid') return { label: 'PAID but no policy issued — needs attention', pill: 'pill-danger' }
    if (latest?.status === 'failed') return { label: 'Payment failed / declined at checkout', pill: 'pill-danger' }
    if (latest?.status === 'cancelled') return { label: 'Cancelled during checkout', pill: 'pill-warning' }
    if (latest?.status === 'pending') return { label: 'Reached checkout — never finished paying', pill: 'pill-warning' }
    if (ev.pending.length > 0) return { label: 'Signed up — awaiting first payment', pill: 'pill-pending' }
    if (ev.lead) return { label: `Self-signup never completed${ev.lead.source ? ` (${ev.lead.source})` : ''}`, pill: 'pill-caution' }
    if (c.capturedByName) return { label: 'Registered by staff — policy never issued', pill: 'pill-gray' }
    if (c.agentName) return { label: 'Referred by agent — never converted', pill: 'pill-gray' }
    return { label: 'No payment attempt on record', pill: 'pill-gray' }
  }

  /** Identical to Clients → Assign Policy: a policy captured here must
   *  text the client the same confirmation and alert the same office
   *  lines — the capture screen must not change who hears what. */
  const handleAssignPolicy = async (policy: Policy): Promise<Policy | null> => {
    if (!(await serverReachable())) {
      showToast('error', 'The server is unreachable right now — nothing was registered. Try again in a moment.')
      return null
    }
    const { data, error } = await db.policies.create(policy)
    if (error || !data) {
      showToast('error', error ?? 'Failed to create policy.')
      void notifyRegistrationFailed('Policy signup', `${policy.clientName} / ${policy.productName} — ${error ?? 'unknown error'}`)
      return null
    }
    // Cover now exists — the client leaves this list immediately.
    setClients(prev => prev.filter(c => c.id !== data.clientId))
    showToast('success', `Policy ${data.policyNumber} assigned to ${data.clientName}.`)
    setAssignPolicyClient(null)

    const { data: client } = await db.clients.get(data.clientId)
    void notifyPolicyRegistered(data, client ?? null)

    // Same policy-document email the Clients path sends (skipped for
    // funeral packages, which draw a different document).
    const { data: allProducts } = await db.products.list()
    const category = allProducts?.find(pr => pr.id === data.productId)?.category ?? ''
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
    return data
  }

  return (
    <div className="panel">
      <div className="panel-toolbar">
        <div className="filter-row">
          <input
            className="search-input"
            placeholder="Search name, phone, ID, or email…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <button type="button" className="btn btn-ghost" onClick={() => setActivePanel('clients')}>← Clients Management</button>
      </div>

      <div className="info-banner info-banner-warning" style={{ marginBottom: 14 }}>
        <strong>Two different problems live on this page.</strong>{' '}
        <strong>Self-signups</strong> (Referred By shows an agent, or blank) are abandoned
        website/bot signups — no payment was taken, and they're mirrored under
        Leads &amp; Marketing for follow-up. <strong>Back-office</strong> rows (Referred By
        shows a staff member) are clients staff registered but whose policy was never
        issued — e.g. tobacco farmers whose Stop Order cover should activate instantly.
        Those need a policy assigned <em>now</em>, not a sales call.
      </div>

      <div className="card">
        {loading ? (
          <div className="empty-state">Loading clients…</div>
        ) : (
          <div className="tbl-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Phone</th>
                <th>National ID</th>
                <th>Email</th>
                <th>Joined</th>
                <th>Referred By</th>
                <th>Why Abandoned</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={9} className="td-empty">
                  {clients.length === 0 ? 'No abandoned signups — every client holds at least one policy.' : 'No clients match that search.'}
                </td></tr>
              ) : filtered.map(c => {
                const reason = reasonFor(c)
                const expanded = expandedId === c.id
                const ev = expanded ? evidenceFor(c) : null
                return (
                <Fragment key={c.id}>
                <tr>
                  <td><strong>{c.name}</strong></td>
                  <td>{c.phone}</td>
                  <td><span className="mono">{c.nationalId}</span></td>
                  <td>{c.email}</td>
                  <td>{formatDate(c.createdAt)}</td>
                  <td>{c.agentName ?? c.capturedByName ?? '—'}</td>
                  <td>
                    <span className={`pill ${reason.pill}`}>{reason.label}</span>{' '}
                    <button type="button" className="btn btn-ghost btn-sm" style={{ padding: '2px 6px' }} onClick={() => setExpandedId(expanded ? null : c.id)}>
                      {expanded ? '▲' : '▼'}
                    </button>
                  </td>
                  <td><span className={`pill ${c.status === 'active' ? 'pill-active' : 'pill-lapsed'}`}>{c.status}</span></td>
                  <td>
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => setAssignPolicyClient(c)}>
                      Assign Policy
                    </button>
                  </td>
                </tr>
                {expanded && ev && (
                  <tr>
                    <td colSpan={9} style={{ background: 'var(--surface-2, rgba(0,0,0,0.02))' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14, padding: '4px 8px', fontSize: '0.83rem' }}>
                        <div>
                          <div className="detail-label" style={{ marginBottom: 4 }}>Client record</div>
                          <div>{c.address || '—'}</div>
                          <div style={{ color: 'var(--muted)' }}>
                            {c.occupation || '—'}{c.dob ? ` · born ${formatDate(c.dob)}` : ''}
                          </div>
                          <div style={{ color: 'var(--muted)' }}>
                            Captured by {c.capturedByName ?? 'self-service'} · Joined {formatDateTime(c.createdAt)}
                          </div>
                        </div>
                        <div>
                          <div className="detail-label" style={{ marginBottom: 4 }}>Checkout attempts ({ev.checkouts.length})</div>
                          {ev.checkouts.length === 0 ? (
                            <div style={{ color: 'var(--muted)' }}>None — never reached the payment step.</div>
                          ) : ev.checkouts.map(s => (
                            <div key={s.reference} style={{ marginBottom: 6 }}>
                              <div>
                                <span className={`pill pill-${s.status === 'paid' ? 'paid' : s.status === 'failed' ? 'danger' : s.status === 'cancelled' ? 'cancelled' : 'pending'}`}>{s.status}</span>{' '}
                                <strong>${s.amount.toFixed(2)}</strong> · {productNames.get(s.product_id) ?? 'Product'}
                              </div>
                              <div style={{ color: 'var(--muted)' }}>
                                {formatDateTime(s.created_at)} · {s.gateway}{s.payment_method ? ` · ${s.payment_method}` : ''} · ref {s.reference}
                              </div>
                            </div>
                          ))}
                        </div>
                        <div>
                          <div className="detail-label" style={{ marginBottom: 4 }}>Pending policies ({ev.pending.length})</div>
                          {ev.pending.length === 0 ? (
                            <div style={{ color: 'var(--muted)' }}>None — pending rows are swept 24h after signup.</div>
                          ) : ev.pending.map(p => (
                            <div key={p.policy_number} style={{ marginBottom: 6 }}>
                              <div className="mono">{p.policy_number}</div>
                              <div style={{ color: 'var(--muted)' }}>
                                {productNames.get(p.product_id) ?? 'Product'} · ${p.premium.toFixed(2)} via {p.payment_method} · {p.source} · {formatDateTime(p.created_at)}
                              </div>
                            </div>
                          ))}
                          <div className="detail-label" style={{ margin: '8px 0 4px' }}>Sales lead</div>
                          {ev.lead ? (
                            <div style={{ color: 'var(--muted)' }}>
                              {ev.lead.source || 'unknown source'} · status {ev.lead.status}
                              {ev.lead.productInterest ? ` · interested in ${ev.lead.productInterest}` : ''}
                              {ev.lead.lastContact ? ` · last contact ${formatDate(ev.lead.lastContact)}` : ''}
                              {ev.lead.notes ? <div>{ev.lead.notes}</div> : null}
                            </div>
                          ) : (
                            <div style={{ color: 'var(--muted)' }}>No lead record.</div>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
                </Fragment>
                )
              })}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {assignPolicyClient && (
        <NewPolicyModal
          initialClient={assignPolicyClient}
          onClose={() => setAssignPolicyClient(null)}
          onSave={handleAssignPolicy}
          showToast={showToast}
        />
      )}
    </div>
  )
}
