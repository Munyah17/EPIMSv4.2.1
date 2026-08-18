import { useState, useEffect } from 'react'
import type { Claim, Policy, Client, Product, AssessmentPhoto, ClaimAssessment } from '../../types'
import { db } from '../../lib/db'
import { scoreClaimFraud } from '../../lib/aiService'
import { getCurrentCoordinates } from '../../lib/geolocation'
import { fileToBase64 } from '../../lib/photoAnalysis'
import { useAuth } from '../../contexts/AuthContext'
import DateInput from '../ui/DateInput'
import PhotoCaptureField from '../ui/PhotoCaptureField'
import SignaturePad from '../ui/SignaturePad'
import FraudNoticeModal from './FraudNoticeModal'
import {
  LEAVES_PER_HECTARE, PLANTS_PER_HECTARE, LEAVES_PER_PLANT,
  expectedLeavesForHectares, leavesInBarn, assessLoss, calculateClaim,
  formatPercent, formatMoney,
} from '../../lib/agricultureClaim'

export interface PendingOfflinePhoto {
  label: string
  base64: string
  mediaType: string
  fileName: string
  exifDate?: string
  capturedAt: string
}

interface Props {
  onClose: () => void
  onSave: (
    claim: Claim & { fraudSignals?: string[] },
    assessment: Omit<ClaimAssessment, 'id' | 'claimId' | 'claimNumber' | 'assessorName' | 'createdAt'>,
    offlinePhotos: PendingOfflinePhoto[],
  ) => Promise<void>
  showToast?: (type: 'success' | 'error' | 'warning' | 'info', message: string) => void
  claimKind?: 'ordinary' | 'agriculture'
  onSwitchKind?: (kind: 'ordinary' | 'agriculture') => void
}

// Restricted to the perils actually covered by agriculture policies (see
// AGRICULTURE_COVER in exportUtils.ts) so a farmer can't file a claim
// against a peril their cover doesn't include.
const CLAIM_TYPES = ['Hail Storm', 'Barn Fire', 'Wind Storm', 'Other']

const THREE_DAYS_MS = 3 * 24 * 3600 * 1000
function isPhotoStale(p: AssessmentPhoto): boolean {
  const dateStr = p.exifDate || p.visibleDateStamp
  if (!dateStr) return false
  const ts = new Date(dateStr).getTime()
  return Number.isFinite(ts) && Date.now() - ts > THREE_DAYS_MS
}

// At least 6 clearly-labeled damage photos, matching what a real assessment
// needs to hold up — "+ Add Another" appends more beyond these.
const REQUIRED_PHOTO_SLOTS = [
  'Damage (Wide Shot 1)', 'Damage (Wide Shot 2)',
  'Damage (Close-up 1)', 'Damage (Close-up 2)',
  'Field/Barn Overview', 'Additional Evidence',
]
const MAX_PHOTOS = 20

export default function NewAgricultureClaimModal({ onClose, onSave, showToast, claimKind, onSwitchKind }: Props) {
  const { user } = useAuth()
  const [policies, setPolicies] = useState<Policy[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [allClaims, setAllClaims] = useState<Claim[]>([])
  const [loading, setLoading] = useState(true)
  const [policyNumberInput, setPolicyNumberInput] = useState('')
  const [claimType, setClaimType] = useState(CLAIM_TYPES[0])
  const [amount, setAmount] = useState('')
  const [dateOfEvent, setDateOfEvent] = useState('')
  const [description, setDescription] = useState('')
  const [client, setClient] = useState<Client | null>(null)
  const [saving, setSaving] = useState(false)

  // Assessment fields — same shape as AgricultureAssessmentModal, captured
  // here at intake instead of as a separate later step.
  const [descriptionOfLoss, setDescriptionOfLoss] = useState('')
  const [photos, setPhotos] = useState<Record<string, AssessmentPhoto | undefined>>({})
  const [extraPhotoLabels, setExtraPhotoLabels] = useState<string[]>([])
  const [assessorComments, setAssessorComments] = useState('')
  const [farmerStatement, setFarmerStatement] = useState('')
  const [gpsLat, setGpsLat] = useState<number | undefined>(undefined)
  const [gpsLng, setGpsLng] = useState<number | undefined>(undefined)
  const [gpsBusy, setGpsBusy] = useState(false)
  const [cropPopulation, setCropPopulation] = useState('')
  const [baselineCropPopulation, setBaselineCropPopulation] = useState<string | undefined>()
  // Loss assessment inputs. Which of these apply depends on the peril:
  // field counts for hail/windstorm, barn counts for a barn fire.
  const [hectares, setHectares] = useState('')
  const [damagedLeaves, setDamagedLeaves] = useState('')
  const [totalLeavesAtTopping, setTotalLeavesAtTopping] = useState('')
  const [barnStrings, setBarnStrings] = useState('')
  const [leavesPerString, setLeavesPerString] = useState('')
  const [leavesLost, setLeavesLost] = useState('')
  const [cropStage, setCropStage] = useState('')
  const [barnCapacity, setBarnCapacity] = useState('')
  const [farmerSignature, setFarmerSignature] = useState<string | undefined>()
  const [assessorSignature, setAssessorSignature] = useState<string | undefined>()
  const [farmerSelfie, setFarmerSelfie] = useState<AssessmentPhoto | undefined>()
  const [offlinePending, setOfflinePending] = useState<{ label: string; file: File; exifDate?: string }[]>([])
  const [showFraudNotice, setShowFraudNotice] = useState(false)

  // Stable draft id so uploaded photos land in one folder before the claim's
  // real id exists — same pattern as NewClaimModal.
  const [draftId] = useState(() => `cl${Date.now()}`)

  useEffect(() => {
    Promise.all([db.policies.list(), db.claims.list(), db.products.list()]).then(([polRes, claimRes, prodRes]) => {
      if (polRes.data) setPolicies(polRes.data)
      if (claimRes.data) setAllClaims(claimRes.data)
      if (prodRes.data) setProducts(prodRes.data)
      setLoading(false)
    })
  }, [])

  const agriculturePolicies = policies.filter(p => products.find(pr => pr.id === p.productId)?.category === 'agriculture')
  const policy = agriculturePolicies.find(p => p.policyNumber.toLowerCase() === policyNumberInput.trim().toLowerCase())
  const policyId = policy?.id ?? ''

  useEffect(() => {
    if (policy) {
      setAmount(policy.coverAmount.toString())
      db.clients.get(policy.clientId).then(({ data }) => setClient(data))
    } else {
      setAmount('')
      setClient(null)
      setBaselineCropPopulation(undefined)
    }
  }, [policy])

  // Crop population is established at pre-loss and carried forward, so the
  // assessor is comparing against the recorded baseline rather than
  // re-estimating it from scratch at claim time. Still editable: if what's
  // in the field genuinely differs, that difference is itself evidence.
  useEffect(() => {
    if (!policyId) return
    let cancelled = false
    db.policyAssessments.listForPolicy(policyId).then(({ data }) => {
      if (cancelled) return
      const baseline = data.find(a => (a.cropPopulation ?? '').trim())?.cropPopulation?.trim()
      setBaselineCropPopulation(baseline || undefined)
      if (baseline) setCropPopulation(prev => prev.trim() ? prev : baseline)
    })
    return () => { cancelled = true }
  }, [policyId])

  const allSlots = [...REQUIRED_PHOTO_SLOTS, ...extraPhotoLabels]
  const isSlotCovered = (slot: string) => !!photos[slot] || offlinePending.some(p => p.label === slot)
  const requiredPhotoCount = REQUIRED_PHOTO_SLOTS.filter(isSlotCovered).length
  const photosComplete = requiredPhotoCount >= REQUIRED_PHOTO_SLOTS.length
  const farmerPhotoCovered = !!farmerSelfie || offlinePending.some(p => p.label === 'Farmer Photo')

  const captureGps = async () => {
    setGpsBusy(true)
    const coords = await getCurrentCoordinates()
    setGpsBusy(false)
    if (!coords) { showToast?.('warning', 'Could not get a GPS fix — check location permission and try again (this can take longer with a weak signal).'); return }
    setGpsLat(coords.lat)
    setGpsLng(coords.lng)
  }

  const addExtraSlot = () => {
    setExtraPhotoLabels(prev => (REQUIRED_PHOTO_SLOTS.length + prev.length >= MAX_PHOTOS ? prev : [...prev, `Additional Photo ${prev.length + 1}`]))
  }

  const removeExtraSlot = (label: string) => {
    setExtraPhotoLabels(prev => prev.filter(l => l !== label))
    setPhotos(prev => { const next = { ...prev }; delete next[label]; return next })
  }

  const handleOfflineCapture = (file: File, label: string, exif?: { exifDate?: string }) => {
    setOfflinePending(prev => [...prev, { label, file, exifDate: exif?.exifDate }])
    showToast?.('warning', `No connection: "${label}" saved on this device and will upload automatically once you're back online.`)
  }

  const canSave = !!policyId && !!amount && !!dateOfEvent && !!description.trim()
    && photosComplete && farmerPhotoCovered && !!farmerSignature && !!assessorSignature
    && descriptionOfLoss.trim().length > 0 && gpsLat !== undefined && gpsLng !== undefined && !saving

  const handleSave = async () => {
    if (!canSave || !policy || !user) return
    setSaving(true)
    const dateSubmitted = new Date().toISOString().split('T')[0]
    const priorClaimsOnPolicy = allClaims.filter(c => c.policyId === policyId).length
    let fraudScore = 20
    let signals: string[] = []
    try {
      const result = await scoreClaimFraud({
        claimType, amount: Number(amount), coverAmount: policy.coverAmount,
        dateOfEvent, policyStartDate: policy.startDate, dateSubmitted, description, priorClaimsOnPolicy,
      })
      fraudScore = result.score
      signals = result.signals

      // Agriculture-specific signals the generic text-based scorer above has
      // no visibility into — these come from the physical evidence actually
      // captured in this modal, so they're folded in here rather than
      // bolted on after the claim (and its fraudScore) already exist.
      const allCapturedPhotos = [...Object.values(photos).filter((p): p is AssessmentPhoto => !!p), ...(farmerSelfie ? [farmerSelfie] : [])]
      const flaggedCount = allCapturedPhotos.filter(p => p.aiFlagged).length
      const staleCount = allCapturedPhotos.filter(isPhotoStale).length
      if (flaggedCount > 0) {
        fraudScore = Math.min(100, fraudScore + flaggedCount * 15)
        signals.push(`${flaggedCount} submitted photo${flaggedCount !== 1 ? 's' : ''} flagged by AI review.`)
      }
      if (staleCount > 0) {
        fraudScore = Math.min(100, fraudScore + staleCount * 10)
        signals.push(`${staleCount} submitted photo${staleCount !== 1 ? 's are' : ' is'} more than 3 days old.`)
      }
      const { data: priorAssessments } = await db.policyAssessments.listForPolicy(policyId)
      if (priorAssessments.length === 0) {
        fraudScore = Math.min(100, fraudScore + 10)
        signals.push('No pre-loss assessment on record for this policy; crop/farm baseline unverified.')
      }

      // Duplicate/reused photo check — draftId can't match anything real yet
      // (the claim doesn't exist until db.claims.create below), so this is
      // purely a lookup against every OTHER claim/policy's photos. The hash
      // itself gets recorded post-creation, once the real claim id exists —
      // see handleAddAgriculture in Claims.tsx.
      const duplicateMatches: { photoLabel: string; reference: string; sourceType: string }[] = []
      for (const p of allCapturedPhotos) {
        if (!p.phash) continue
        const matches = await db.photoHashes.findMatches(p.phash, draftId)
        for (const m of matches) duplicateMatches.push({ photoLabel: p.label, reference: m.reference, sourceType: m.sourceType })
      }
      if (duplicateMatches.length > 0) {
        fraudScore = Math.min(100, fraudScore + duplicateMatches.length * 20)
        const examples = duplicateMatches.slice(0, 3).map(m => `"${m.photoLabel}" matches a photo on ${m.sourceType} ${m.reference}`).join('; ')
        signals.push(`${duplicateMatches.length} submitted photo${duplicateMatches.length !== 1 ? 's appear' : ' appears'} to be reused from elsewhere: ${examples}.`)
      }
    } finally {
      const claimNumber = `CLM${new Date().getFullYear()}${String(Date.now()).slice(-3)}`
      const claim: Claim & { fraudSignals?: string[] } = {
        id: draftId,
        claimNumber,
        policyId,
        policyNumber: policy.policyNumber,
        clientId: policy.clientId,
        clientName: policy.clientName,
        productName: policy.productName,
        claimType,
        amount: Number(amount),
        status: 'pending',
        stage: 'intake',
        category: 'agriculture',
        agentId: policy.agentId,
        agentName: policy.agentName,
        dateOfEvent,
        dateSubmitted,
        description,
        fraudScore,
        documents: [],
        fraudSignals: signals,
      }

      const uploadedPhotos = Object.values(photos).filter((p): p is AssessmentPhoto => !!p)
      if (farmerSelfie) uploadedPhotos.push(farmerSelfie)

      const offlinePhotos: PendingOfflinePhoto[] = await Promise.all(offlinePending.map(async ({ label, file, exifDate }) => ({
        label, base64: await fileToBase64(file), mediaType: file.type, fileName: file.name, exifDate, capturedAt: new Date().toISOString(),
      })))

      await onSave(claim, {
        assessorId: user.id,
        descriptionOfLoss,
        photos: uploadedPhotos,
        assessorComments,
        farmerStatement,
        gpsLat, gpsLng, cropPopulation, cropStage, barnCapacity,
        farmerSignature, assessorSignature, farmerSelfie: farmerSelfie?.path,
        submittedAt: new Date().toISOString(),
        syncStatus: 'synced',
      }, offlinePhotos)
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 760 }}>
        <div className="modal-header">
          <h3>New Agriculture Claim</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {onSwitchKind && (
            <div className="form-group">
              <div className="bubble-toggle">
                <button type="button" className={`bubble-toggle-btn${claimKind === 'ordinary' ? ' active' : ''}`} onClick={() => onSwitchKind('ordinary')}>Ordinary Claims</button>
                <button type="button" className={`bubble-toggle-btn${claimKind === 'agriculture' ? ' active' : ''}`} onClick={() => onSwitchKind('agriculture')}>Agriculture Claims</button>
              </div>
            </div>
          )}

          <div className="info-banner info-banner-warning" style={{ marginBottom: '1rem' }}>
            Agriculture claims capture the full physical assessment now: at least 6 damage photos, GPS, and both signatures are required before this can be submitted. Photos must be no more than 3 days old, checked automatically from each photo's date metadata.
          </div>

          <div className="form-group">
            <label>Policy Number *</label>
            <input
              className="form-control"
              list="ag-claim-policy-numbers"
              placeholder={loading ? 'Loading policies…' : 'Enter or select an agriculture policy number'}
              value={policyNumberInput}
              onChange={e => setPolicyNumberInput(e.target.value)}
              disabled={loading}
            />
            <datalist id="ag-claim-policy-numbers">
              {agriculturePolicies.map(p => <option key={p.id} value={p.policyNumber} />)}
            </datalist>
          </div>
          {policyNumberInput.trim() && !policy && !loading && (
            <div className="info-banner info-banner-warning" style={{ marginBottom: '1rem' }}>
              No agriculture policy found with that number.
            </div>
          )}
          {policy && (
            <>
              <div className="form-row">
                <div className="form-group">
                  <label>Client Name</label>
                  <input className="form-control" value={policy.clientName} disabled style={{ opacity: 0.6 }} />
                </div>
                <div className="form-group">
                  <label>National ID</label>
                  <input className="form-control" value={client?.nationalId ?? '—'} disabled style={{ opacity: 0.6 }} />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Product / Package</label>
                  <input className="form-control" value={policy.productName} disabled style={{ opacity: 0.6 }} />
                </div>
                <div className="form-group">
                  <label>Max Cover</label>
                  <input className="form-control" value={`$${policy.coverAmount.toLocaleString()}`} disabled style={{ opacity: 0.6 }} />
                </div>
              </div>
            </>
          )}

          <div className="form-row">
            <div className="form-group">
              <label>Claim Type *</label>
              <select className="form-control" value={claimType} onChange={e => setClaimType(e.target.value)}>
                {CLAIM_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>Claim Amount ($) *</label>
              <input type="number" className="form-control" min={0} value={amount} onChange={e => setAmount(e.target.value)} disabled={!!policy} style={policy ? { opacity: 0.6 } : undefined} />
            </div>
          </div>
          <div className="form-group">
            <label>Date of Event *</label>
            <DateInput value={dateOfEvent} onChange={setDateOfEvent} />
          </div>
          <div className="form-group">
            <label>Description *</label>
            <textarea className="form-control" rows={3} value={description} onChange={e => setDescription(e.target.value)} placeholder="Describe the incident…" />
          </div>
          <div className="form-group">
            <label>Status</label>
            <input className="form-control" value="Pending" disabled style={{ opacity: 0.6 }} />
          </div>

          <hr style={{ margin: '1.25rem 0', border: 'none', borderTop: '1px solid var(--border)' }} />
          <h4 style={{ marginBottom: 10 }}>Physical Assessment</h4>

          <div className="form-group">
            <label>Description of Loss *</label>
            <textarea className="form-control" rows={3} value={descriptionOfLoss} onChange={e => setDescriptionOfLoss(e.target.value)} placeholder="What the assessor observed on site…" />
          </div>

          <div className="form-group">
            <label>Farmer's Statement</label>
            <textarea className="form-control" rows={3} value={farmerStatement} onChange={e => setFarmerStatement(e.target.value)} placeholder="Summarize, in your own words, what the farmer told you on site, kept separate from your own remarks below." />
          </div>

          <label style={{ display: 'block', margin: '1rem 0 6px', fontSize: 13, fontWeight: 600 }}>
            Damage / Loss Photos ({requiredPhotoCount}/{REQUIRED_PHOTO_SLOTS.length} required)
          </label>
          {allSlots.map(slot => (
            <div key={slot} style={{ position: 'relative' }}>
              <PhotoCaptureField
                label={slot}
                folder="claims"
                recordId={draftId}
                claimDescription={description}
                value={photos[slot]}
                onChange={p => setPhotos(prev => ({ ...prev, [slot]: p }))}
                onOfflineCapture={handleOfflineCapture}
              />
              {offlinePending.some(p => p.label === slot) && (
                <div style={{ fontSize: 11, color: 'var(--gold)', margin: '-8px 0 8px' }}>📴 Saved offline, will upload once you're back online.</div>
              )}
              {extraPhotoLabels.includes(slot) && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ position: 'absolute', top: 0, right: 0, color: 'var(--danger)' }}
                  onClick={() => removeExtraSlot(slot)}
                >
                  Remove
                </button>
              )}
            </div>
          ))}
          <button type="button" className="btn btn-ghost btn-sm" disabled={allSlots.length >= MAX_PHOTOS} onClick={addExtraSlot}>
            + Add More Images (up to {MAX_PHOTOS})
          </button>

          <div className="form-group" style={{ marginTop: '1rem' }}>
            <label>Assessor's Report / Comments</label>
            <textarea className="form-control" rows={3} value={assessorComments} onChange={e => setAssessorComments(e.target.value)} placeholder="Your analysis of the damage and evidence…" />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label>Crop Population</label>
              <input className="form-control" value={cropPopulation} onChange={e => setCropPopulation(e.target.value)} placeholder="e.g. 15000 plants/ha" />
              {baselineCropPopulation ? (
                <span style={{ fontSize: 11, color: cropPopulation.trim() === baselineCropPopulation ? 'var(--muted)' : 'var(--gold)', marginTop: 4, display: 'block' }}>
                  {cropPopulation.trim() === baselineCropPopulation
                    ? `Carried over from the pre-loss assessment (${baselineCropPopulation}).`
                    : `Differs from the pre-loss baseline of ${baselineCropPopulation}; explain the change in your comments.`}
                </span>
              ) : policyId ? (
                <span style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, display: 'block' }}>
                  No crop population recorded at pre-loss for this policy.
                </span>
              ) : null}
            </div>
            <div className="form-group">
              <label>Crop Stage</label>
              <input className="form-control" value={cropStage} onChange={e => setCropStage(e.target.value)} placeholder="e.g. Tobacco, leaf stage" />
            </div>
          </div>
          <div className="form-group">
            <label>Barn Capacity</label>
            <input className="form-control" value={barnCapacity} onChange={e => setBarnCapacity(e.target.value)} placeholder="e.g. 12 tonnes" />
          </div>

          <div className="form-group">
            <label>GPS Coordinates *</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button type="button" className="btn btn-outline btn-sm" disabled={gpsBusy} onClick={captureGps}>📍 {gpsBusy ? 'Getting location…' : 'Use Current Location'}</button>
              {gpsLat !== undefined && gpsLng !== undefined && (
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>{gpsLat.toFixed(6)}, {gpsLng.toFixed(6)}</span>
              )}
            </div>
          </div>

          <div className="form-group">
            <label>Farmer Photo *</label>
            <PhotoCaptureField label="Farmer Photo" folder="claims" recordId={draftId} value={farmerSelfie} onChange={setFarmerSelfie} onOfflineCapture={handleOfflineCapture} />
            {offlinePending.some(p => p.label === 'Farmer Photo') && (
              <div style={{ fontSize: 11, color: 'var(--gold)', marginTop: 4 }}>📴 Saved offline, will upload once you're back online.</div>
            )}
          </div>

          <div className="form-row" style={{ marginTop: '1rem' }}>
            <SignaturePad label="Farmer Signature *" onChange={setFarmerSignature} />
            <SignaturePad label="Assessor Signature *" onChange={setAssessorSignature} />
          </div>
          <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>Assessor: {user?.name}</p>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => setShowFraudNotice(true)} disabled={!canSave}>
            {saving ? 'Analysing & Submitting…' : 'Submit Agriculture Claim'}
          </button>
        </div>
      </div>
      {showFraudNotice && (
        <FraudNoticeModal
          confirming={saving}
          onCancel={() => setShowFraudNotice(false)}
          onConfirm={() => { setShowFraudNotice(false); void handleSave() }}
        />
      )}
    </div>
  )
}
