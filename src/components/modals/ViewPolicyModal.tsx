import type { Policy } from '../../types'
import { formatDate } from '../../lib/dateUtils'

interface Props {
  policy: Policy
  onClose: () => void
  onEdit: () => void
  /** Omitted when the policy's product isn't loaded yet or is a funeral
   *  package — printed reports aren't offered for those. */
  onPrint?: () => void
}

export default function ViewPolicyModal({ policy, onClose, onEdit, onPrint }: Props) {
  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-header">
          <h3>Policy — {policy.policyNumber}</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="detail-grid">
            <div className="detail-item"><span className="detail-label">Policy Number</span><span className="mono">{policy.policyNumber}</span></div>
            <div className="detail-item"><span className="detail-label">Status</span><span className={`pill pill-${policy.status}`}>{policy.status}</span></div>
            <div className="detail-item"><span className="detail-label">Client</span><span>{policy.clientName}</span></div>
            <div className="detail-item"><span className="detail-label">Product</span><span>{policy.productName}</span></div>
            <div className="detail-item"><span className="detail-label">Premium</span><span>${policy.premium.toFixed(2)}/mo</span></div>
            <div className="detail-item"><span className="detail-label">Cover Amount</span><span>${policy.coverAmount.toLocaleString()}</span></div>
            <div className="detail-item"><span className="detail-label">Start Date</span><span>{formatDate(policy.startDate)}</span></div>
            <div className="detail-item"><span className="detail-label">End Date</span><span>{formatDate(policy.endDate)}</span></div>
            <div className="detail-item"><span className="detail-label">Payment Method</span><span>{policy.paymentMethod}</span></div>
            <div className="detail-item"><span className="detail-label">Next Payment</span><span>{formatDate(policy.nextPaymentDate)}</span></div>
            <div className="detail-item"><span className="detail-label">Last Payment</span><span>{formatDate(policy.lastPaymentDate)}</span></div>
            <div className="detail-item"><span className="detail-label">Agent</span><span>{policy.agentName ?? '—'}</span></div>
          </div>

          {policy.dependants.length > 0 && (
            <div style={{ marginTop: '1.5rem' }}>
              <h4 style={{ marginBottom: '0.75rem' }}>Dependants</h4>
              <table className="table">
                <thead><tr><th>Name</th><th>Relationship</th><th>Date of Birth</th><th>ID Number</th><th>Plan</th></tr></thead>
                <tbody>
                  {policy.dependants.map((d, i) => (
                    <tr key={i}>
                      <td>{d.name}</td>
                      <td>{d.relationship}</td>
                      <td>{formatDate(d.dob)}</td>
                      <td>{d.nationalId}</td>
                      <td>{d.productName ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
          {onPrint && <button className="btn btn-ghost" onClick={onPrint}>Print Policy</button>}
          <button className="btn btn-primary" onClick={onEdit}>Edit Policy</button>
        </div>
      </div>
    </div>
  )
}
