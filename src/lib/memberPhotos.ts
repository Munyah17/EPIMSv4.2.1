import { supabase } from './supabase'

/**
 * Member portraits — one passport photo per member number, in the public
 * 'member-photos' bucket with the URL registered on member_photos.
 *
 * Public on purpose: the card rasteriser draws it with a plain <img> and
 * a private bucket's signed URLs expire inside the export window. The
 * table stays staff-only so only staff can point a member at a photo.
 */

const BUCKET = 'member-photos'

export async function uploadMemberPhoto(memberNumber: string, blob: Blob, updatedBy?: string): Promise<{ url: string | null; error: string | null }> {
  const path = `${memberNumber}.png`
  const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, blob, { upsert: true, contentType: 'image/png' })
  if (upErr) return { url: null, error: upErr.message }
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path)
  // Cache-bust — same path serves the new upload, but browsers cache the old.
  const url = `${data.publicUrl}?v=${Date.now()}`
  const { error: rowErr } = await supabase.from('member_photos').upsert({
    member_number: memberNumber, photo_url: url, updated_by: updatedBy ?? null,
  }, { onConflict: 'member_number' })
  if (rowErr) return { url: null, error: rowErr.message }
  return { url, error: null }
}

export async function memberPhotoMap(): Promise<Map<string, string>> {
  const { data } = await supabase.from('member_photos').select('member_number, photo_url')
  return new Map((data ?? []).map(r => [r.member_number, r.photo_url as string]))
}
