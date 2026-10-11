/** WhatsApp Bot admin calls — server-gated (admins only), same
 *  token-on-fetch pattern as aiService.ts. */

import { supabase } from './supabase'

export interface WaBotStatus {
  enabled: boolean
  configured: {
    accessToken: boolean; phoneNumberId: boolean; verifyToken: boolean
    appSecret: boolean; paynow: boolean; ecocash: boolean; graphVersion: string
  }
  counts: { openSessions: number; sessions24h: number; policiesViaBot: number }
}

export interface WaSessionRow {
  id: string
  phone_number: string
  contact_type: string
  state: string
  note: Record<string, unknown> | null
  created_at: string
}

async function call<T>(body: Record<string, unknown>): Promise<{ data?: T; error?: string }> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return { error: 'Sign-in required.' }
  try {
    const res = await fetch('/api/whatsapp-admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(body),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) return { error: json.error ?? `HTTP ${res.status}` }
    return { data: json as T }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Network error' }
  }
}

export const waBot = {
  status: () => call<WaBotStatus>({ action: 'status' }),
  sessions: () => call<{ sessions: WaSessionRow[] }>({ action: 'sessions' }),
  endSession: (id: string) => call<{ ok: true }>({ action: 'end_session', id }),
  sendTest: (phone: string, text: string) => call<{ ok: true }>({ action: 'send_test', phone, text }),
  setEnabled: (enabled: boolean) => call<{ ok: true; enabled: boolean }>({ action: 'set_enabled', enabled }),
}
