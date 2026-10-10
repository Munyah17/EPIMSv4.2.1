import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Shared types for the WhatsApp bot — the TS twin of
 * motions_bot's bot/utils/types/.
 */

export type ContactType = 'agent' | 'client' | 'unknown'

export interface WaSession {
  id: string
  phone_number: string        // digits only, e.g. '26377xxxxxxx'
  contact_type: ContactType
  state: string
  note: Record<string, unknown>   // working memory across steps
  is_expired: boolean
  created_at: string
}

export interface BotClient {
  id: string
  name: string
  phone: string
  nationalId: string
  email: string
}

export interface BotAgent {
  id: string                // profiles.id — becomes clients/policies.agent_id
  name: string
  email: string
}

export interface BotProduct {
  id: string
  name: string
  code: string
  category: string
  premium: number
  coverAmount: number
  active: boolean
}

export interface BotPolicy {
  id: string                // policies.id (uuid) — paynow needs it
  policyNumber: string
  productName: string
  premium: number
  coverAmount: number
  status: string
  dependants: { name: string; relationship?: string; nationalId?: string }[]
}

export interface Contact {
  type: ContactType
  client?: BotClient
  agent?: BotAgent
}

export interface Ctx {
  session: WaSession
  /** The normalised inbound message — text body or a button/list reply id. */
  input: string
  /** E.164 digits, no '+' — what senders address WhatsApp with. */
  phone: string
  /** WhatsApp profile name, for greetings. */
  username: string
  contact: Contact
  /** Service-role client — the bot reads and writes real rows. */
  admin: SupabaseClient
}

export type Handler = (ctx: Ctx) => Promise<void>
