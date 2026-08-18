import type { AssessmentPhoto } from '../types'

/**
 * Turns what we know about a captured photo into plain-language concerns an
 * assessor and a reviewer can both act on.
 *
 * None of these individually prove a photo is fake. A genuine phone photo
 * can lose its EXIF (some messaging apps and gallery re-saves strip it) and
 * a genuine editor pass can be nothing worse than a crop. What they do is
 * separate "straight off a camera, minutes ago" from "arrived here by some
 * other route", so a photo that can't account for itself gets looked at
 * instead of waved through.
 */

/** Blocking concerns stop submission; advisory ones only warn. */
export type PhotoConcernSeverity = 'blocking' | 'advisory'

export interface PhotoConcern {
  severity: PhotoConcernSeverity
  message: string
}

const MAX_PHOTO_AGE_MS = 3 * 24 * 3600 * 1000

/** Editors that announce themselves in the EXIF Software tag. A camera or
 *  phone writes its own firmware string here instead, so a match means the
 *  file was re-saved by an image editor after capture. */
const EDITOR_SOFTWARE = ['photoshop', 'gimp', 'lightroom', 'snapseed', 'picsart', 'pixlr', 'paint.net', 'affinity', 'canva', 'facetune']

export function assessPhotoIntegrity(photo: AssessmentPhoto): PhotoConcern[] {
  const concerns: PhotoConcern[] = []

  const dateStr = photo.exifDate || photo.visibleDateStamp
  if (dateStr) {
    const taken = new Date(dateStr).getTime()
    if (Number.isFinite(taken)) {
      if (Date.now() - taken > MAX_PHOTO_AGE_MS) {
        concerns.push({ severity: 'blocking', message: 'Taken more than 3 days ago.' })
      }
      // A capture date in the future means the clock was wrong or the
      // metadata was hand-edited; either way it can't be trusted as proof
      // of when this was shot.
      if (taken - Date.now() > 24 * 3600 * 1000) {
        concerns.push({ severity: 'blocking', message: 'Capture date is in the future; metadata is unreliable.' })
      }
    }
  } else {
    concerns.push({
      severity: 'blocking',
      message: 'No capture date in the file. Screenshots, downloads and forwarded images lose this; shoot with the Camera button instead.',
    })
  }

  if (photo.exifSoftware) {
    const lower = photo.exifSoftware.toLowerCase()
    if (EDITOR_SOFTWARE.some(s => lower.includes(s))) {
      concerns.push({ severity: 'blocking', message: `Re-saved by image editing software (${photo.exifSoftware}).` })
    }
  }

  if (photo.exifHasData && !photo.exifCamera) {
    concerns.push({ severity: 'advisory', message: 'File carries no camera make/model, unusual for a photo taken on site.' })
  }

  if (photo.aiFlagged) {
    concerns.push({ severity: 'advisory', message: photo.aiNote || 'AI review flagged this image.' })
  }

  return concerns
}

export function hasBlockingConcern(photo: AssessmentPhoto): boolean {
  return assessPhotoIntegrity(photo).some(c => c.severity === 'blocking')
}

/** Photos that can't be submitted as-is, with the reasons why. */
export function blockedPhotos(photos: AssessmentPhoto[]): { photo: AssessmentPhoto; concerns: PhotoConcern[] }[] {
  return photos
    .map(photo => ({ photo, concerns: assessPhotoIntegrity(photo).filter(c => c.severity === 'blocking') }))
    .filter(r => r.concerns.length > 0)
}
