import { supabase } from './supabase'

/**
 * Member portraits — one passport photo per member number in the public
 * 'member-photos' bucket.
 *
 * Writes go through a two-phase signed upload, staff included:
 *   1. POST /api/member-photo { memberNumber } — ownership is checked
 *      (staff: any member; policyholder: their own policy's members) and
 *      a signed upload token comes back.
 *   2. The file uploads straight to Supabase Storage with that token —
 *      no serverless body limit, so a 100MB original is fine.
 *   3. POST /api/member-photo { memberNumber, confirm } — registers the
 *      URL on member_photos.
 *
 * Reads are free: the bucket is public and member_photos is readable by
 * any signed-in user.
 */

const MAX_PHOTO_BYTES = 100 * 1024 * 1024 // 100MB

async function callApi(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { data: { session } } = await supabase.auth.getSession()
  const res = await fetch('/api/member-photo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}) },
    body: JSON.stringify(body),
  })
  return res.json().catch(() => ({ error: `Upload failed (HTTP ${res.status}).` }))
}

export async function uploadMemberPhoto(memberNumber: string, blob: Blob, updatedBy?: string): Promise<{ url: string | null; error: string | null }> {
  if (blob.size > MAX_PHOTO_BYTES) {
    return { url: null, error: `The photo is ${(blob.size / 1024 / 1024).toFixed(0)}MB — the limit is 100MB.` }
  }
  const minted = await callApi({ memberNumber })
  if (minted.error) return { url: null, error: minted.error as string }

  const { error: upErr } = await supabase.storage
    .from('member-photos')
    .uploadToSignedUrl(minted.path as string, minted.token as string, blob, { contentType: 'image/png' })
  if (upErr) return { url: null, error: `Storage rejected the upload: ${upErr.message}` }

  const confirmed = await callApi({ memberNumber, confirm: true, updatedBy })
  if (confirmed.error) return { url: null, error: confirmed.error as string }
  return { url: confirmed.url as string, error: null }
}

export async function memberPhotoMap(): Promise<Map<string, string>> {
  const { data } = await supabase.from('member_photos').select('member_number, photo_url')
  return new Map((data ?? []).map(r => [r.member_number, r.photo_url as string]))
}
