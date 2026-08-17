import { useState, useEffect } from 'react'
import type { ToastMessage, PolicyAssessment, Policy } from '../types'
import type { ActivePanel } from '../App'
import { db } from '../lib/db'
import { formatDate } from '../lib/dateUtils'
import { exportPolicyAssessmentReport } from '../lib/exportUtils'
import { useAuth } from '../contexts/AuthContext'
import PolicyAssessmentModal from '../components/modals/PolicyAssessmentModal'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
  setActivePanel: (panel: ActivePanel) => void
}

export default function PreLossAssessments({ showToast }: Props) {
  const { hasPermission } = useAuth()
  const [assessments, setAssessments] = useState<PolicyAssessment[]>([])
  const [policies, setPolicies] = useState<Policy[]>([])
  const [products, setProducts] = useState<{ id: string; category: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [detail, setDetail] = useState<PolicyAssessment | null>(null)
  const [pickingPolicy, setPickingPolicy] = useState(false)
  const [policySearch, setPolicySearch] = useState('')
  const [recordFor, setRecordFor] = useState<Policy | null>(null)

  const load = () => {
    Promise.all([db.policyAssessments.listAll(), db.policies.list(), db.products.list()]).then(([aRes, pRes, prodRes]) => {
      setAssessments(aRes.data)
      if (pRes.data) setPolicies(pRes.data)
      if (prodRes.data) setProducts(prodRes.data)
      setLoading(false)
    })
  }

  useEffect(load, [])

  const policySubjectType = (p: Policy): 'agriculture' | 'vehicle' | null => {
    const category = products.find(pr => pr.id === p.productId)?.category
    if (category === 'agriculture') return 'agriculture'
    if (category === 'motor') return 'vehicle'
    return null
  }
  const eligiblePolicies = policies.filter(p => policySubjectType(p) !== null)

  const filtered = assessments.filter(a =>
    a.policyNumber.toLowerCase().includes(search.toLowerCase()) ||
    (a.clientName ?? '').toLowerCase().includes(search.toLowerCase()) ||
    (a.cropType ?? '').toLowerCase().includes(search.toLowerCase()) ||
    (a.registrationNumber ?? '').toLowerCase().includes(search.toLowerCase())
  )

  const policyResults = policySearch.trim().length < 2 ? [] : eligiblePolicies.filter(p =>
    p.policyNumber.toLowerCase().includes(policySearch.toLowerCase()) ||
    p.clientName.toLowerCase().includes(policySearch.toLowerCase())
  ).slice(0, 8)

  const handlePrint = (a: PolicyAssessment) => {
    void exportPolicyAssessmentReport(a, a.policyNumber, a.clientName ?? '')
  }

  const canRecord = hasPermission('claims.physical_assessment')

  return (
    <div className="panel">
      <div className="panel-toolbar">
        <input
          className="search-input"
          placeholder="Search policy number, client, crop, registration…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        {canRecord && (
          <button type="button" className="btn btn-primary" onClick={() => setPickingPolicy(true)}>+ Record Pre-Loss Assessment</button>
        )}
      </div>

      <div className="info-banner info-banner-info" style={{ marginBottom: '1rem' }}>
        📷 Establishes what's actually there before any claim exists — crop planted on a farm, or a vehicle's existing condition — so a later claim can be checked against a real record. Every record here is available to compare against later claims.
      </div>

      <div className="card">
        {loading ? (
          <div className="empty-state">Loading assessments…</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">No pre-loss assessments recorded yet.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Policy</th>
                <th>Client</th>
                <th>Type</th>
                <th>Crop / Vehicle</th>
                <th>GPS</th>
                <th>Photos</th>
                <th>Assessor</th>
                <th>Recorded</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(a => (
                <tr key={a.id}>
                  <td><span className="mono">{a.policyNumber}</span></td>
                  <td>{a.clientName ?? '—'}</td>
                  <td>{a.subjectType === 'vehicle' ? '🚗 Vehicle' : '🌾 Agriculture'}</td>
                  <td>{a.subjectType === 'vehicle' ? (a.registrationNumber || '—') : (a.cropType || '—')}</td>
                  <td>{a.gpsLat !== undefined ? <span className="pill pill-active">✓ Captured</span> : <span className="pill pill-lapsed">Missing</span>}</td>
                  <td>{a.photos.length}</td>
                  <td>{a.assessorName || '—'}</td>
                  <td>{formatDate(a.createdAt)}</td>
                  <td>
                    <div className="action-btns">
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDetail(a)}>View</button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => handlePrint(a)}>🖨 Print</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {pickingPolicy && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 480 }}>
            <div className="modal-header">
              <h3>Select Policy</h3>
              <button className="modal-close" onClick={() => { setPickingPolicy(false); setPolicySearch('') }}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>Policy Number or Client Name</label>
                <input className="form-control" value={policySearch} onChange={e => setPolicySearch(e.target.value)} placeholder="Start typing…" autoFocus />
              </div>
              {policySearch.trim().length >= 2 && (
                policyResults.length === 0 ? (
                  <div className="empty-state" style={{ padding: '12px 0' }}>No matching agriculture or vehicle policy found.</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {policyResults.map(p => (
                      <button
                        key={p.id}
                        type="button"
                        className="btn btn-ghost"
                        style={{ justifyContent: 'flex-start', textAlign: 'left' }}
                        onClick={() => { setPickingPolicy(false); setPolicySearch(''); setRecordFor(p) }}
                      >
                        {policySubjectType(p) === 'vehicle' ? '🚗' : '🌾'} <strong style={{ marginLeft: 4 }}>{p.policyNumber}</strong>&nbsp;· {p.clientName}
                      </button>
                    ))}
                  </div>
                )
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => { setPickingPolicy(false); setPolicySearch('') }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {recordFor && (
        <PolicyAssessmentModal
          policyId={recordFor.id}
          policyNumber={recordFor.policyNumber}
          subjectType={policySubjectType(recordFor) ?? 'agriculture'}
          onClose={() => setRecordFor(null)}
          onSubmitted={() => { setRecordFor(null); load(); showToast('success', 'Pre-loss assessment recorded.') }}
          showToast={showToast}
        />
      )}

      {detail && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 640 }}>
            <div className="modal-header">
              <h3>Pre-Loss Assessment — {detail.policyNumber}</h3>
              <button className="modal-close" onClick={() => setDetail(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-row">
                <div className="form-group">
                  <label>Client</label>
                  <input className="form-control" value={detail.clientName ?? '—'} disabled style={{ opacity: 0.6 }} />
                </div>
                <div className="form-group">
                  <label>Assessor</label>
                  <input className="form-control" value={detail.assessorName || '—'} disabled style={{ opacity: 0.6 }} />
                </div>
              </div>
              {detail.subjectType === 'vehicle' ? (
                <>
                  <div className="form-row">
                    <div className="form-group">
                      <label>Registration Number</label>
                      <input className="form-control" value={detail.registrationNumber || '—'} disabled style={{ opacity: 0.6 }} />
                    </div>
                    <div className="form-group">
                      <label>Odometer Reading</label>
                      <input className="form-control" value={detail.odometerReading || '—'} disabled style={{ opacity: 0.6 }} />
                    </div>
                  </div>
                  <div className="form-row">
                    <div className="form-group">
                      <label>Make / Model</label>
                      <input className="form-control" value={[detail.vehicleMake, detail.vehicleModel].filter(Boolean).join(' ') || '—'} disabled style={{ opacity: 0.6 }} />
                    </div>
                    <div className="form-group">
                      <label>GPS Coordinates</label>
                      <input className="form-control" value={detail.gpsLat !== undefined ? `${detail.gpsLat.toFixed(6)}, ${detail.gpsLng?.toFixed(6)}` : 'Not captured'} disabled style={{ opacity: 0.6 }} />
                    </div>
                  </div>
                  <div className="form-group">
                    <label>Existing Damage</label>
                    <textarea className="form-control" rows={2} value={detail.existingDamage || '—'} disabled style={{ opacity: 0.6 }} />
                  </div>
                </>
              ) : (
                <>
                  <div className="form-row">
                    <div className="form-group">
                      <label>Crop Type</label>
                      <input className="form-control" value={detail.cropType || '—'} disabled style={{ opacity: 0.6 }} />
                    </div>
                    <div className="form-group">
                      <label>Crop Population</label>
                      <input className="form-control" value={detail.cropPopulation || '—'} disabled style={{ opacity: 0.6 }} />
                    </div>
                  </div>
                  <div className="form-row">
                    <div className="form-group">
                      <label>Plant Date</label>
                      <input className="form-control" value={detail.plantDate ? formatDate(detail.plantDate) : '—'} disabled style={{ opacity: 0.6 }} />
                    </div>
                    <div className="form-group">
                      <label>GPS Coordinates</label>
                      <input className="form-control" value={detail.gpsLat !== undefined ? `${detail.gpsLat.toFixed(6)}, ${detail.gpsLng?.toFixed(6)}` : 'Not captured'} disabled style={{ opacity: 0.6 }} />
                    </div>
                  </div>
                </>
              )}
              <div className="form-group">
                <label>Notes</label>
                <textarea className="form-control" rows={3} value={detail.notes || '—'} disabled style={{ opacity: 0.6 }} />
              </div>
              {detail.photos.length > 0 && (
                <div className="form-group">
                  <label>Photos</label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {detail.photos.map((p, i) => (
                      <div key={i} style={{ fontSize: 11, color: 'var(--muted)' }}>{p.label}{p.exifDate ? ` · ${new Date(p.exifDate).toLocaleDateString()}` : ''}</div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setDetail(null)}>Close</button>
              <button className="btn btn-primary" onClick={() => handlePrint(detail)}>🖨 Print Report</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
