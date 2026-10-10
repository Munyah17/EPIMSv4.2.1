import { supabase } from './supabase'

/**
 * Member portraits — one passport photo per member number in the public
 * 'member-photos' bucket.
 *
 * Writes ALL go through POST /api/member-photo, staff included: the
 * ownership check (any member for staff, own-policy members for
 * policyholders) lives there once, not spread across RLS policies that
 * have to agree. member_photos stays staff-writable in the database;
 * the API signs its writes with the service role.
 *
 * Reads are free: the bucket is public and member_photos is readable by
 * any signed-in user — the URL map is how cards and the portal find the
 * current photo.
 */

export async function uploadMemberPhoto(memberNumber: string, blob: Blob, updatedBy?: string): Promise<{ url: string | null; error: string | null }> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('Could not read the photo file.'))
    reader.readAsDataURL(blob)
  })
  const { data: { session } } = await supabase.auth.getSession()
  const res = await fetch('/api/member-photo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}) },
    body: JSON.stringify({ memberNumber, image: dataUrl, updatedBy }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) return { url: null, error: (body as { error?: string })?.error ?? `Upload failed (HTTP ${res.status}).` }
  return { url: (body as { url: string }).url, error: null }
}

export async function memberPhotoMap(): Promise<Map<string, string>> {
  const { data } = await supabase.from('member_photos').select('member_number, photo_url')
  return new Map((data ?? []).map(r => [r.member_number, r.photo_url as string]))
}
