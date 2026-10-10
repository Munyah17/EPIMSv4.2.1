import { useCallback, useEffect, useRef, useState } from 'react'
import type { PolicyMember } from '../../lib/memberNumbers'
import { uploadMemberPhoto } from '../../lib/memberPhotos'
import { loadImage, renderPassport, autoFix, removeBackground, canvasToBlob, PASSPORT_W, PASSPORT_H, DEFAULT_EDIT } from '../../lib/imageEditor'
import type { EditState } from '../../lib/imageEditor'

/**
 * Passport-photo editor for member cards.
 *
 * Upload → drag to frame → adjust → Auto Fix / Remove Background → Save.
 * Everything happens on a canvas in the browser; only the finished
 * passport-size PNG is uploaded. "Remove Background" is edge flood-fill —
 * designed for the plain wall most office photos are shot against, not a
 * general ML eraser.
 */

interface Props {
  member: PolicyMember
  onClose: () => void
  onSaved: (memberNumber: string, url: string) => void
  showToast: (type: 'success' | 'error' | 'warning' | 'info', message: string) => void
  staffName?: string
}

const PREVIEW_W = 250

export default function PhotoEditorModal({ member, onClose, onSaved, showToast, staffName }: Props) {
  const [img, setImg] = useState<HTMLImageElement | HTMLCanvasElement | null>(null)
  const [state, setState] = useState<EditState>({ ...DEFAULT_EDIT })
  const [bgTolerance, setBgTolerance] = useState(48)
  const [saving, setSaving] = useState(false)
  const [working, setWorking] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const drag = useRef<{ x: number; y: number } | null>(null)

  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || !img) return
    canvas.width = PASSPORT_W; canvas.height = PASSPORT_H
    canvas.getContext('2d')!.drawImage(renderPassport(img, state), 0, 0)
  }, [img, state])
  useEffect(redraw, [redraw])

  const pickFile = async (file: File | undefined) => {
    if (!file) return
    if (!file.type.startsWith('image/')) { showToast('error', 'That is not an image file.'); return }
    setWorking(true)
    try {
      const url = URL.createObjectURL(file)
      const image = await loadImage(url)
      setImg(image)
      setState({ ...DEFAULT_EDIT })
      // A sane first frame, then let the user fine-tune.
      setState(autoFix(image))
    } catch (e) {
      showToast('error', `Could not load that image: ${e}`)
    } finally {
      setWorking(false)
    }
  }

  // Drag on the preview pans the photo within the passport frame.
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    drag.current = { x: e.clientX, y: e.clientY }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag.current || !img) return
    const dx = (e.clientX - drag.current.x) / 60
    const dy = (e.clientY - drag.current.y) / 60
    drag.current = { x: e.clientX, y: e.clientY }
    setState(s => ({
      ...s,
      offsetX: Math.max(-1, Math.min(1, s.offsetX + dx)),
      offsetY: Math.max(-1, Math.min(1, s.offsetY + dy)),
    }))
  }
  const onPointerUp = () => { drag.current = null }

  const doAutoFix = () => { if (img) setState(autoFix(img)) }

  const doRemoveBg = () => {
    if (!img) return
    setWorking(true)
    // Let the "working" state paint before the flood-fill blocks.
    setTimeout(() => {
      try {
        setImg(removeBackground(img, bgTolerance))
        setState(s => ({ ...s, opacity: 100 }))
        showToast('info', 'Background removed. Increase or lower the tolerance and press again if the edge needs a different cut.')
      } catch (e) {
        showToast('error', `Background removal failed: ${e}`)
      } finally { setWorking(false) }
    }, 30)
  }

  const doSave = async () => {
    if (!img) return
    setSaving(true)
    try {
      const blob = await canvasToBlob(renderPassport(img, state))
      const { url, error } = await uploadMemberPhoto(member.memberNumber, blob, staffName)
      if (error || !url) { showToast('error', error ?? 'Upload failed.'); return }
      onSaved(member.memberNumber, url)
      showToast('success', `Passport photo saved for ${member.name || member.memberNumber} — it's on the card now.`)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  const slider = (label: string, key: keyof EditState, min: number, max: number) => (
    <div className="form-group" style={{ marginBottom: 8 }}>
      <label style={{ fontSize: 11 }}>{label} — {state[key] as number}{key === 'opacity' || key === 'brightness' || key === 'contrast' || key === 'saturate' ? '%' : ''}</label>
      <input type="range" min={min} max={max} value={state[key] as number}
        onChange={e => setState(s => ({ ...s, [key]: Number(e.target.value) }))}
        style={{ width: '100%' }} />
    </div>
  )

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ maxWidth: 720 }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title">📷 Passport Photo — {member.name || member.memberNumber}</h3>
          <button type="button" className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
            <div style={{ flex: '0 0 auto' }}>
              <canvas
                ref={canvasRef}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                style={{
                  width: PREVIEW_W,
                  height: PREVIEW_W * (PASSPORT_H / PASSPORT_W),
                  borderRadius: 8, border: '1px solid var(--border)',
                  background: img ? undefined : 'var(--bg2, #F1F5F9)',
                  cursor: img ? 'grab' : 'default', touchAction: 'none',
                }}
              />
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6, textAlign: 'center' }}>
                {img ? 'Drag to reposition · passport 35×45mm' : 'Upload a portrait to begin'}
              </div>
              <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
                onChange={e => pickFile(e.target.files?.[0])} />
              <button type="button" className="btn btn-outline btn-sm" style={{ width: '100%', marginTop: 8 }} onClick={() => fileRef.current?.click()}>
                {img ? '↺ Choose a different photo' : '⬆ Upload portrait'}
              </button>
            </div>

            <div style={{ flex: 1, minWidth: 260 }}>
              {img ? (
                <>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                    <button type="button" className="btn btn-primary btn-sm" onClick={doAutoFix} disabled={working}>
                      ✨ Auto Fix
                    </button>
                    <button type="button" className="btn btn-outline btn-sm" onClick={() => setState({ ...DEFAULT_EDIT })} disabled={working}>
                      Reset
                    </button>
                  </div>

                  {slider('Brightness', 'brightness', 30, 200)}
                  {slider('Contrast', 'contrast', 30, 200)}
                  {slider('Colour', 'saturate', 0, 200)}
                  {slider('Opacity', 'opacity', 30, 100)}
                  {slider('Zoom', 'scale', 50, 400)}

                  <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 10 }}>
                    <label style={{ fontSize: 11, color: 'var(--muted)' }}>Background colour</label>
                    <input type="color" value={state.bgColor}
                      onChange={e => setState(s => ({ ...s, bgColor: e.target.value }))}
                      style={{ width: 36, height: 26, padding: 0, border: '1px solid var(--border)', borderRadius: 4 }} />
                    <span className="mono" style={{ fontSize: 11 }}>{state.bgColor}</span>
                  </div>

                  <div className="card" style={{ padding: '10px 12px', marginBottom: 10 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Remove Background</div>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                      <label style={{ fontSize: 11, color: 'var(--muted)' }}>Tolerance {bgTolerance}</label>
                      <input type="range" min={8} max={140} value={bgTolerance} onChange={e => setBgTolerance(Number(e.target.value))} style={{ flex: 1, minWidth: 100 }} />
                      <button type="button" className="btn btn-outline btn-sm" onClick={doRemoveBg} disabled={working}>
                        {working ? 'Cutting…' : '✂ Remove'}
                      </button>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
                      Works on plain backgrounds — a wall, a door. Cuts inward from the edges; if the cut takes too much or too little, adjust tolerance and press again.
                    </div>
                  </div>
                </>
              ) : (
                <div className="empty-state" style={{ padding: '2rem 1rem' }}>
                  Upload a portrait photo. The editor resizes it to passport size automatically — phone photos, scans and screenshots all work.
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={doSave} disabled={!img || saving || working}>
            {saving ? 'Saving…' : 'Save to Member Card'}
          </button>
        </div>
      </div>
    </div>
  )
}
