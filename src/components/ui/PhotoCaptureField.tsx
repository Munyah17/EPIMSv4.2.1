import { useRef, useState } from 'react'
import type { AssessmentPhoto } from '../../types'
import { uploadDocument, getDocumentUrl } from '../../lib/storage'
import { readExifDateTaken } from '../../lib/exifDate'
import { analyzePhotoForFraud, fileToBase64 } from '../../lib/photoAnalysis'

interface Props {
  label: string
  folder: 'claims' | 'policies'
  recordId: string
  claimDescription?: string
  value: AssessmentPhoto | undefined
  onChange: (photo: AssessmentPhoto | undefined) => void
  onOfflineCapture?: (file: File, label: string) => void
}

const THREE_DAYS_MS = 3 * 24 * 3600 * 1000

function isStale(iso: string | undefined): boolean {
  if (!iso) return false
  return Date.now() - new Date(iso).getTime() > THREE_DAYS_MS
}

export default function PhotoCaptureField({ label, folder, recordId, claimDescription, value, onChange, onOfflineCapture }: Props) {
  const [busy, setBusy] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const cameraRef = useRef<HTMLInputElement>(null)
  const galleryRef = useRef<HTMLInputElement>(null)

  const handleFile = async (file: File | null) => {
    if (!file) return
    setBusy(true)
    const capturedAt = new Date().toISOString()

    const exifDate = await readExifDateTaken(file)

    if (!navigator.onLine) {
      // No connection right now — hand the raw file to the offline queue
      // instead of losing it; a background sync uploads it later.
      onOfflineCapture?.(file, label)
      setBusy(false)
      return
    }

    const { data, error } = await uploadDocument(folder, recordId, new File([file], `assessment_${label.replace(/\s+/g, '-')}_${file.name}`, { type: file.type }))
    if (error || !data) {
      // Upload failed (likely a flaky connection mid-upload) — fall back to
      // the offline queue rather than surfacing a dead end.
      onOfflineCapture?.(file, label)
      setBusy(false)
      return
    }

    const url = await getDocumentUrl(data.path)
    setPreviewUrl(url)

    let visibleDateStamp: string | undefined
    let aiNote: string | undefined
    let aiFlagged = false
    try {
      const base64 = await fileToBase64(file)
      const result = await analyzePhotoForFraud(base64, file.type, label, claimDescription)
      if (!result.simulated) {
        visibleDateStamp = result.visibleDateStamp ?? undefined
        aiNote = result.note
        aiFlagged = !!result.flagged
      }
    } catch { /* AI check is best-effort — never block on it */ }

    onChange({ path: data.path, label, exifDate: exifDate ?? undefined, visibleDateStamp, aiNote, aiFlagged, capturedAt })
    setBusy(false)
  }

  const staleWarning = isStale(value?.exifDate) || isStale(value?.visibleDateStamp)

  return (
    <div className="photo-capture-field">
      <div className="photo-capture-header">
        <span className="photo-capture-label">{label}</span>
        {value && (
          <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} onClick={() => { onChange(undefined); setPreviewUrl(null) }}>Remove</button>
        )}
      </div>

      {!value ? (
        <div className="photo-capture-actions">
          <input ref={cameraRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={e => handleFile(e.target.files?.[0] ?? null)} />
          <input ref={galleryRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={e => handleFile(e.target.files?.[0] ?? null)} />
          <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => cameraRef.current?.click()}>📷 Camera</button>
          <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => galleryRef.current?.click()}>🖼 Gallery</button>
          {busy && <span className="photo-capture-busy">Uploading &amp; analysing…</span>}
        </div>
      ) : (
        <div className="photo-capture-result">
          {previewUrl && <img src={previewUrl} alt={label} className="photo-capture-thumb" />}
          <div className="photo-capture-meta">
            {value.exifDate && <div>📅 EXIF: {new Date(value.exifDate).toLocaleString()}</div>}
            {value.visibleDateStamp && <div>🏷 Visible date stamp: {value.visibleDateStamp}</div>}
            {!value.exifDate && !value.visibleDateStamp && <div className="muted">No date metadata found on this photo.</div>}
            {value.aiNote && <div className="photo-capture-ai-note">🤖 {value.aiNote}</div>}
            {(staleWarning || value.aiFlagged) && (
              <div className="photo-capture-flag">⚠ {staleWarning ? 'This photo appears to be more than 3 days old.' : 'AI flagged this photo for review.'}</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
