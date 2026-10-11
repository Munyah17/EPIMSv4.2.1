import type { SupabaseClient } from '@supabase/supabase-js'
import type { Handler, Contact } from './types.js'
import { findContact } from './data.js'
import { findSession, createSession, deleteSession, sessionExpired, resetSession } from './store.js'
import { sendText } from './whatsapp.js'
import { REG_HANDLERS } from './handlers/registration.js'
import { CLIENT_HANDLERS } from './handlers/client.js'
import { AGENT_HANDLERS } from './handlers/agent.js'

/**
 * The dispatcher — respond_to()/continue_session() in the Frappe
 * version. Inbound normalised message + phone in, reply out.
 *
 *   classify (agent | client | unknown)
 *   -> find open session (expired? restart; 'exit'? wipe to main menu)
 *   -> HANDLERS[audience][session.state](ctx)
 *
 * A state with no handler kills the session — same rule as before:
 * better a clean restart than a conversation stuck on a broken step.
 */

const ENTRY_STATE: Record<Contact['type'], string> = {
  agent: 'AGENT_MENU',
  client: 'CLIENT_MENU',
  unknown: 'REG_MENU',
}

const MAPS: Record<Contact['type'], Record<string, Handler>> = {
  agent: AGENT_HANDLERS,
  client: CLIENT_HANDLERS,
  unknown: REG_HANDLERS,
}

/** The WhatsApp Bot page's pause switch — read per inbound message so
 *  toggling takes effect on the very next one, no redeploy. Default ON:
 *  only an explicit { enabled: false } in app_settings pauses. */
async function botEnabled(admin: SupabaseClient): Promise<boolean> {
  const { data } = await admin.from('app_settings').select('value').eq('key', 'whatsapp_bot').maybeSingle()
  return (data?.value as { enabled?: boolean } | null)?.enabled !== false
}

export async function dispatchMessage(admin: SupabaseClient, raw: {
  phone: string; input: string; username: string
}): Promise<void> {
  const { phone, input, username } = raw
  try {
    if (!(await botEnabled(admin))) {
      console.error(`whatsapp bot: paused — inbound message from ${phone} dropped`)
      return
    }

    const contact = await findContact(admin, phone)
    let session = await findSession(admin, phone)

    if (session && sessionExpired(session)) {
      await deleteSession(admin, session)
      await sendText(phone, 'Your session has expired. Starting a new conversation.')
      session = null
    }
    if (!session) {
      session = await createSession(admin, phone, contact.type, ENTRY_STATE[contact.type])
    }

    // 'exit' anywhere: wipe the working memory and drop to the main menu —
    // the flow continues there with this same message, so the user sees
    // the menu again rather than having to say anything twice.
    if (input.trim().toLowerCase() === 'exit') {
      await resetSession(admin, session, ENTRY_STATE[contact.type])
    }

    const handler = MAPS[contact.type][session.state]
    if (!handler) {
      console.error(`whatsapp bot: no handler for ${contact.type} state '${session.state}' — session deleted`)
      await deleteSession(admin, session)
      await sendText(phone, 'Something went wrong on our side — send any message to start again.')
      return
    }

    await handler({ session, input, phone, username, contact, admin })
  } catch (e) {
    // A thrown handler is a dead conversation — tell the caller, kill
    // the session so the next message starts clean, and log it loudly.
    console.error(`whatsapp bot: handler error for ${phone} ("${input}")`, e)
    try {
      const session = await findSession(admin, phone)
      if (session) await deleteSession(admin, session)
      await sendText(phone, 'An error occurred on our side. Your session has been reset — send any message to start again.')
    } catch { /* WhatsApp itself may be down — nothing more to do */ }
  }
}
