/**
 * Passport-photo pipeline for member cards — all canvas, zero libraries.
 *
 * Output size: 35mm x 45mm passport portrait at ~300dpi -> 413 x 531.
 * Every adjustment (crop, brightness, opacity, background) lands on this
 * same fixed canvas, so whatever the user uploads — phone selfie, scan,
 * screenshot — leaves as one standard passport photo.
 */

export const PASSPORT_W = 413
export const PASSPORT_H = 531

export interface EditState {
  /** Zoom multiplier over the base cover-fit. */
  scale: number
  /** Pan as a fraction of the spare room (-1..1 each axis). */
  offsetX: number
  offsetY: number
  /** Percent values — 100 = untouched. */
  brightness: number
  contrast: number
  saturate: number
  /** Photo opacity over the background colour (percent). */
  opacity: number
  /** Colour the portrait sits on (passport standard is white/light). */
  bgColor: string
}

export const DEFAULT_EDIT: EditState = {
  scale: 1, offsetX: 0, offsetY: -0.15, // slight top bias — faces sit high
  brightness: 100, contrast: 100, saturate: 100, opacity: 100,
  bgColor: '#FFFFFF',
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not read that image file.'))
    img.src = src
  })
}

/**
 * The final passport canvas: background colour, then the image cover-fitted
 * with the user's zoom/pan, filtered by their brightness/contrast/saturation
 * and drawn at their opacity.
 */
export function renderPassport(img: HTMLImageElement | HTMLCanvasElement, s: EditState): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = PASSPORT_W
  canvas.height = PASSPORT_H
  const ctx = canvas.getContext('2d')!

  ctx.fillStyle = s.bgColor
  ctx.fillRect(0, 0, PASSPORT_W, PASSPORT_H)

  const iw = 'naturalWidth' in img ? img.naturalWidth : img.width
  const ih = 'naturalHeight' in img ? img.naturalHeight : img.height
  const base = Math.max(PASSPORT_W / iw, PASSPORT_H / ih) // cover-fit
  const scale = base * s.scale
  const dw = iw * scale, dh = ih * scale
  // Slack between the drawn image and the frame — pan moves within it.
  const slackX = (PASSPORT_W - dw) / 2
  const slackY = (PASSPORT_H - dh) / 2
  const dx = slackX + slackX * s.offsetX
  const dy = slackY + slackY * s.offsetY

  ctx.globalAlpha = s.opacity / 100
  ctx.filter = `brightness(${s.brightness}%) contrast(${s.contrast}%) saturate(${s.saturate}%)`
  ctx.drawImage(img, dx, dy, dw, dh)
  ctx.filter = 'none'
  ctx.globalAlpha = 1
  return canvas
}

/**
 * Auto Fix: analyse the photo and set the adjustments for it.
 *
 * - Histogram percentile stretch for contrast (clip 2% each side — the
 *   standard auto-levels every photo tool does).
 * - Mean luminance pulled toward the middle of the range for brightness.
 * - A small saturation lift, because phone cameras wash colour out.
 * - Zoom reset to cover-fit; pan keeps its slight top bias for faces.
 */
export function autoFix(img: HTMLImageElement | HTMLCanvasElement): EditState {
  const probe = document.createElement('canvas')
  const W = 96, H = 96
  probe.width = W; probe.height = H
  const ctx = probe.getContext('2d')!
  ctx.drawImage(img, 0, 0, W, H)
  const px = ctx.getImageData(0, 0, W, H).data

  const lums: number[] = []
  for (let i = 0; i < px.length; i += 4) {
    lums.push(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2])
  }
  lums.sort((a, b) => a - b)
  const p2 = lums[Math.floor(lums.length * 0.02)]
  const p98 = lums[Math.floor(lums.length * 0.98)]
  const mean = lums.reduce((a, b) => a + b, 0) / lums.length

  // Contrast % that stretches [p2, p98] onto roughly [13, 242].
  const span = Math.max(p98 - p2, 1)
  const stretch = (242 - 13) / span
  const contrast = Math.min(Math.max(stretch * 100, 100), 160)
  // After the stretch, the effective mid moves; pull the mean to ~128.
  const shiftedMean = (mean - p2) * stretch + 13
  const brightness = Math.min(Math.max(128 / Math.max(shiftedMean, 1) * 100, 75), 130)

  return {
    ...DEFAULT_EDIT,
    brightness: Math.round(brightness),
    contrast: Math.round(contrast),
    saturate: 112,
    scale: 1, offsetX: 0, offsetY: -0.15,
  }
}

/**
 * Remove a plain background — the wall most office photos are taken
 * against. Flood-fills inward from every border pixel, treating anything
 * within `tolerance` of the average border colour as background and
 * clearing it. The subject is left untouched because a person in the
 * middle is never border-connected background.
 *
 * Returns a transparent-background canvas — the bgColor is painted in at
 * render time, so the card colour still decides the final look.
 */
export function removeBackground(img: HTMLImageElement | HTMLCanvasElement, tolerance: number): HTMLCanvasElement {
  const w = 'naturalWidth' in img ? img.naturalWidth : img.width
  const h = 'naturalHeight' in img ? img.naturalHeight : img.height
  const canvas = document.createElement('canvas')
  canvas.width = w; canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0)
  const imgData = ctx.getImageData(0, 0, w, h)
  const px = imgData.data

  // Average border colour — the background's reference.
  const border: number[] = [0, 0, 0]
  let n = 0
  const acc = (i: number) => { border[0] += px[i]; border[1] += px[i + 1]; border[2] += px[i + 2]; n++ }
  for (let x = 0; x < w; x++) { acc(x * 4); acc(((h - 1) * w + x) * 4) }
  for (let y = 0; y < h; y++) { acc(y * w * 4); acc((y * w + w - 1) * 4) }
  const avg = border.map(v => v / n)
  const tol2 = tolerance * tolerance

  const closeToBg = (i: number) => {
    const dr = px[i] - avg[0], dg = px[i + 1] - avg[1], db = px[i + 2] - avg[2]
    return dr * dr + dg * dg + db * db <= tol2
  }

  // BFS inward from every border pixel that looks like background.
  const seen = new Uint8Array(w * h)
  const queue: number[] = []
  const seed = (i: number) => { if (!seen[i] && closeToBg(i * 4)) { seen[i] = 1; queue.push(i) } }
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x) }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1) }

  while (queue.length) {
    const i = queue.pop()!
    px[i * 4 + 3] = 0 // clear to transparent
    const x = i % w, y = (i / w) | 0
    if (x > 0) seed(i - 1)
    if (x < w - 1) seed(i + 1)
    if (y > 0) seed(i - w)
    if (y < h - 1) seed(i + w)
  }

  ctx.putImageData(imgData, 0, 0)
  return canvas
}

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not encode the photo.'))), 'image/png'),
  )
}
