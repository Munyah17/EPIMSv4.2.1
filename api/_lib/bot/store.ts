import type { SupabaseClient } from '@supabase/supabase-js'
import type { WaSession, ContactType } from './types.js'

/**
 * wa_sessions — the EChatSession doctype's replacement. One open session
 * per phone number; 60-minute expiry, `exit` resets, `note` carries the
 * flow's working memory until it commits to real tables.
 */

export const SESSION_TTL_MINUTES = 60

export async function findSession(admin: SupabaseClient, phone: string): Promise<WaSession | null> {
  const { data } = await admin.from('wa_sessions')
    .select('id, phone_number, contact_type, state, note, is_expired, created_at')
    .eq('phone_number', phone).eq('is_expired', false)
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  return (data as WaSession | null) ?? null
}

export async function createSession(admin: SupabaseClient, phone: string, contactType: ContactType, state: string): Promise<WaSession> {
  const { data, error } = await admin.from('wa_sessions').insert({
    phone_number: phone, contact_type: contactType, state, note: {},
  }).select('id, phone_number, contact_type, state, note, is_expired, created_at').single()
  if (error) throw new Error(`Could not start a session: ${error.message}`)
  return data as WaSession
}

export function sessionExpired(s: WaSession): boolean {
  return Date.now() - new Date(s.created_at).getTime() > SESSION_TTL_MINUTES * 60 * 1000
}

export async function deleteSession(admin: SupabaseClient, s: WaSession): Promise<void> {
  await admin.from('wa_sessions').delete().eq('id', s.id)
}

export async function setState(admin: SupabaseClient, s: WaSession, state: string): Promise<void> {
  s.state = state
  await admin.from('wa_sessions').update({ state, updated_at: new Date().toISOString() }).eq('id', s.id)
}

/** Merge into the session's working memory — the note survives until
 *  the flow ends, exactly like the Frappe version's JSON field. */
export async function patchNote(admin: SupabaseClient, s: WaSession, patch: Record<string, unknown>): Promise<void> {
  s.note = { ...(s.note ?? {}), ...patch }
  await admin.from('wa_sessions').update({ note: s.note, updated_at: new Date().toISOString() }).eq('id', s.id)
}

/** Full wipe — used on 'exit' so a stale note from a half-finished flow
 *  can't leak into the next conversation. */
export async function resetSession(admin: SupabaseClient, s: WaSession, state: string): Promise<void> {
  s.state = state
  s.note = {}
  await admin.from('wa_sessions').update({ state, note: {}, updated_at: new Date().toISOString() }).eq('id', s.id)
}
