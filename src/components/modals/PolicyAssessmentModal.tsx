import { useState } from 'react'
import type { AssessmentPhoto } from '../../types'
import { useAuth } from '../../contexts/AuthContext'
import { db } from '../../lib/db'
import { getCurrentCoordinates } from '../../lib/geolocation'
import { queueAssessment } from '../../lib/offlineQueue'
import { fileToBase64 } from '../../lib/photoAnalysis'
import { checkAndRecordPhotoDuplicates } from '../../lib/duplicatePhotoCheck'
import PhotoCaptureField from '../ui/PhotoCaptureField'

interface Props {
  policyId: string
  policyNumber: string
  onClose: () => void
  onSubmitted: () => void
  showToast: (type: 'success' | 'error' | 'warning' | 'info', message: string) => void
}

/** Pre-loss baseline for an agriculture policy — establishes what's
 *  actually planted before any claim exists, so a later claim can be
 *  checked against a real record instead of taken purely on faith. */
export default function PolicyAssessmentModal({ policyId, policyNumber, onClose, onSubmitted, showToast }: Props) {
  const { user } = useAuth()
  const [cropType, setCropType] = useState('')
  const [cropPopulation, setCropPopulation] = useState('')
  const [plantDate, setPlantDate] = useState('')
  const [notes, setNotes] = useState('')
  const [gpsLat, setGpsLat] = useState<number | undefined>(undefined)
  const [gpsLng, setGpsLng] = useState<number | undefined>(undefined)
  const [gpsBusy, setGpsBusy] = useState(false)
  const [photo, setPhoto] = useState<AssessmentPhoto | undefined>()
  const [offlinePending, setOfflinePending] = useState<{ label: string; file: File }[]>([])
  const [submitting, setSubmitting] = useState(false)

  const canSubmit = cropType.trim().length > 0 && !submitting

  const captureGps = async () => {
    setGpsBusy(true)
    const coords = await getCurrentCoordinates()
    setGpsBusy(false)
    if (!coords) { showToast('warning', 'Could not get GPS coordinates — enter them manually if needed.'); return }
    setGpsLat(coords.lat)
    setGpsLng(coords.lng)
    // Also saves onto the policy itself, so the farm location is on record
    // even outside the assessment.
    void db.policies.update(policyId, { gpsLat: coords.lat, gpsLng: coords.lng })
  }

  const handleOfflineCapture = (file: File, label: string) => {
    setOfflinePending(prev => [...prev, { label, file }])
    showToast('warning', 'No connection — photo saved on this device and will upload once you\'re back online.')
  }

  const handleSubmit = async () => {
    if (!canSubmit || !user) return
    setSubmitting(true)
    const photos = photo ? [photo] : []

    if (!navigator.onLine || offlinePending.length > 0) {
      const pendingPhotos = await Promise.all(offlinePending.map(async ({ label, file }) => ({
        label, base64: await fileToBase64(file), mediaType: file.type, fileName: file.name, capturedAt: new Date().toISOString(),
      })))
      queueAssessment('policy', policyId, {
        assessorId: user.id, cropType, cropPopulation, plantDate, notes, gpsLat, gpsLng,
        _alreadyUploadedPhotos: photos,
      }, pendingPhotos)
      showToast('success', 'Pre-loss assessment saved on this device — it will sync automatically once you\'re back online.')
      setSubmitting(false)
      onSubmitted()
      return
    }

    const { error } = await db.policyAssessments.create({
      policyId, assessorId: user.id, cropType, cropPopulation, plantDate: plantDate || undefined,
      photos, notes, gpsLat, gpsLng, syncStatus: 'synced',
    })
    setSubmitting(false)
    if (error) { showToast('error', error); return }
    const dupes = await checkAndRecordPhotoDuplicates(photos, 'policy', policyId, policyNumber)
    if (dupes.length > 0) {
      showToast('warning', `⚠ This photo appears to match one already used on another claim/policy — worth a second look.`)
    } else {
      showToast('success', 'Pre-loss assessment recorded.')
    }
    onSubmitted()
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 560 }}>
        <div className="modal-header">
          <h3>Pre-Loss Assessment — {policyNumber}</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="info-banner info-banner-info" style={{ marginBottom: '1rem' }}>
            Establishes what's actually planted on this farm before any claim exists — a claim for a crop never recorded here is an obvious red flag.
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Crop Type *</label>
              <input className="form-control" value={cropType} onChange={e => setCropType(e.target.value)} placeholder="e.g. Tobacco" />
            </div>
            <div className="form-group">
              <label>Crop Population <span style={{ fontWeight: 400, color: 'var(--muted)' }}>(e.g. 15,000 plants/ha)</span></label>
              <input className="form-control" value={cropPopulation} onChange={e => setCropPopulation(e.target.value)} placeholder="e.g. 15000 plants/ha" />
            </div>
          </div>
          <div className="form-group">
            <label>Plant Date</label>
            <input type="date" className="form-control" value={plantDate} onChange={e => setPlantDate(e.target.value)} />
          </div>
          <div className="form-group">
            <label>GPS Coordinates</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button type="button" className="btn btn-outline btn-sm" disabled={gpsBusy} onClick={captureGps}>📍 {gpsBusy ? 'Getting location…' : 'Use Current Location'}</button>
              {gpsLat !== undefined && gpsLng !== undefined && (
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>{gpsLat.toFixed(6)}, {gpsLng.toFixed(6)}</span>
              )}
            </div>
          </div>
          <div className="form-group">
            <label>Farm / Field Photo</label>
            <PhotoCaptureField label="Farm Establishment" folder="policies" recordId={policyId} value={photo} onChange={setPhoto} onOfflineCapture={handleOfflineCapture} />
          </div>
          <div className="form-group">
            <label>Notes</label>
            <textarea className="form-control" rows={3} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Anything else worth recording about the farm's condition…" />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={!canSubmit}>
            {submitting ? 'Saving…' : 'Save Assessment'}
          </button>
        </div>
      </div>
    </div>
  )
}
