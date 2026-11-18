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
    .select('id, phone_number, contact_type, state, note, is_expired, created_at, updated_at')
    .eq('phone_number', phone).eq('is_expired', false)
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  return (data as WaSession | null) ?? null
}

export async function createSession(admin: SupabaseClient, phone: string, contactType: ContactType, state: string): Promise<WaSession> {
  const { data, error } = await admin.from('wa_sessions').insert({
    phone_number: phone, contact_type: contactType, state, note: {},
  }).select('id, phone_number, contact_type, state, note, is_expired, created_at, updated_at').single()
  if (error) {
    // Two inbound messages can race before the unique open-session index
    // exists; the loser takes the row the winner just created.
    if (error.code === '23505') {
      const existing = await findSession(admin, phone)
      if (existing) return existing
    }
    throw new Error(`Could not start a session: ${error.message}`)
  }
  return data as WaSession
}

export function sessionExpired(s: WaSession): boolean {
  const lastActivity = new Date(s.updated_at ?? s.created_at).getTime()
  return Date.now() - lastActivity > SESSION_TTL_MINUTES * 60 * 1000
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
export async function resetSession(admin: SupabaseClient, s: WaSession, state: string, contactType?: ContactType): Promise<void> {
  s.state = state
  s.note = {}
  if (contactType) s.contact_type = contactType
  await admin.from('wa_sessions').update({
    state, note: {}, contact_type: s.contact_type, updated_at: new Date().toISOString(),
  }).eq('id', s.id)
}
