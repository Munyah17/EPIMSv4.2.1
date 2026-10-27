import { useState, useEffect } from 'react'
import type { ToastMessage, Client, Policy } from '../types'
import type { ActivePanel } from '../App'
import { db } from '../lib/db'
import { formatDate } from '../lib/dateUtils'
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
 * Clients on the register holding NO policy of any status — the same
 * uncovered set the dashboard card counts and the reconciliation sweep
 * flags as orphaned. A policy assigned from here goes through the exact
 * registration/notification path as Clients → Assign Policy, and the row
 * leaves this list the moment cover exists.
 */
export default function ClientsNoPolicy({ showToast, setActivePanel }: Props) {
  const [clients, setClients] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [assignPolicyClient, setAssignPolicyClient] = useState<Client | null>(null)

  useEffect(() => {
    db.clients.list().then(({ data, error }) => {
      if (error) showToast('error', 'Failed to load clients.')
      else if (data) setClients(data.filter(c => (c.policyCount ?? 0) === 0))
      setLoading(false)
    }).catch(() => { showToast('error', 'Failed to load clients.'); setLoading(false) })
  }, [showToast])

  const filtered = clients.filter(c =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    c.phone.includes(search) ||
    (c.nationalId ?? '').includes(search) ||
    c.email.toLowerCase().includes(search.toLowerCase())
  )

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
        These clients are registered but hold no policy of any status — no cover exists under their names.
        Assign a policy to each, or have a Super Admin remove registrations that should not be on the register.
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
                <th>Captured By</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={8} className="td-empty">
                  {clients.length === 0 ? 'Every client holds at least one policy.' : 'No clients match that search.'}
                </td></tr>
              ) : filtered.map(c => (
                <tr key={c.id}>
                  <td><strong>{c.name}</strong></td>
                  <td>{c.phone}</td>
                  <td><span className="mono">{c.nationalId}</span></td>
                  <td>{c.email}</td>
                  <td>{formatDate(c.createdAt)}</td>
                  <td>{c.capturedByName ?? '—'}</td>
                  <td><span className={`pill ${c.status === 'active' ? 'pill-active' : 'pill-lapsed'}`}>{c.status}</span></td>
                  <td>
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => setAssignPolicyClient(c)}>
                      Assign Policy
                    </button>
                  </td>
                </tr>
              ))}
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
