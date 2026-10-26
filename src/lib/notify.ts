import { supabase } from './supabase'
import { sendSms } from './smsService'

/**
 * Client-side face of the notification bus (api/notify.ts).
 *
 * Two things the old pipeline never did:
 *
 *   1. WhatsApp — sendWhatsApp() hands the text to the server, which sends
 *      through the Meta Cloud API when credentials exist, or queues it with
 *      a wa.me link staff can tap from the outbox. Either way it lands in
 *      notification_log.
 *   2. A failure that somebody sees — reportOutcome() writes every failed
 *      send to notification_log and raises NOTIFY_FAILURE_EVENT, which
 *      App.tsx turns into a toast and the dashboard turns into an admin
 *      banner. "Health says 100% but nobody got the text" is over.
 */

export const NOTIFY_FAILURE_EVENT = 'ims:notify-failed'

/**
 * Pre-flight gate for writes that are owed a notification.
 *
 * Registration and payment flows are server-side: the client/policy row
 * commits to Supabase and the confirmation/alert fires through /api/*.
 * If the server cannot even be reached, the write must NOT commit —
 * otherwise the office sees a client who paid but nobody was told. So
 * the save paths check this FIRST: unreachable server → nothing is
 * registered, nothing is collected, the user is told to try again.
 */
export async function serverReachable(timeoutMs = 5000): Promise<boolean> {
  try {
    const res = await fetch('/api/health-check', { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok
  } catch {
    return false
  }
}

export interface NotifyChannelResult {
  channel: string
  recipient: string
  status: 'sent' | 'failed' | 'queued' | 'skipped'
  detail?: string
}

async function callNotify(body: Record<string, unknown>): Promise<{ ok: boolean; failed?: number; queued?: number }> {
  try {
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch('/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}) },
      body: JSON.stringify(body),
    })
    if (!res.ok) return { ok: false }
    return await res.json() as { ok: boolean; failed?: number; queued?: number }
  } catch {
    return { ok: false }
  }
}

/** Record the outcome of a send made elsewhere (the sms proxy, send-email)
 *  into notification_log — and make failures loud. Called by the channel
 *  wrappers themselves so every call site benefits without being touched. */
export function reportOutcome(entry: { channel: 'sms' | 'email' | 'whatsapp'; recipient: string; event: string; ref?: string; status: 'sent' | 'failed' | 'skipped'; detail?: string }) {
  void callNotify({ logOnly: true, ...entry })
  if (entry.status === 'failed') {
    window.dispatchEvent(new CustomEvent(NOTIFY_FAILURE_EVENT, { detail: `${entry.channel} → ${entry.recipient}: ${entry.detail ?? 'failed'}` }))
  }
}

/** WhatsApp through the server — Meta Cloud API when configured, else a
 *  queued wa.me link for a human to tap. Never silently dropped. */
export async function sendWhatsApp(to: string, text: string, event: string, ref?: string): Promise<NotifyChannelResult> {
  const res = await fetch('/api/notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${(await supabase.auth.getSession()).data.session?.access_token ?? ''}` },
    body: JSON.stringify({ channel: 'whatsapp', recipient: to, text, event, ref }),
  }).then(r => r.json().catch(() => ({}))).catch(() => ({})) as { ok?: boolean; delivery?: NotifyChannelResult }
  const delivery = res.delivery ?? { channel: 'whatsapp', recipient: to, status: 'failed' as const, detail: 'Notify endpoint unreachable' }
  if (delivery.status === 'failed') {
    window.dispatchEvent(new CustomEvent(NOTIFY_FAILURE_EVENT, { detail: `whatsapp → ${to}: ${delivery.detail ?? 'failed'}` }))
  }
  return delivery
}

/** A phone number that needs BOTH channels — SMS and WhatsApp at once.
 *  The SMS leg reports its own outcome to notification_log (sent AND
 *  failed) now that sendSms carries the event/ref through. */
export function notifyPhone(to: string, text: string, event: string, ref?: string) {
  void sendSms(to, text, { event, ref })
  void sendWhatsApp(to, text, event, ref)
}

/**
 * Full fan-out for events that go through /api/notify end-to-end (the
 * server sends to the client AND the office lines over all channels).
 * Any failed channel raises the toast event + lands in notification_log.
 */
export async function notifyEvent(job: {
  event: 'registration' | 'payment' | 'renewal' | 'claim' | 'ticket' | 'system'
  ref?: string
  client?: { name?: string; phone?: string | null; email?: string | null }
  smsText: string
  emailSubject: string
  emailText: string
  whatsappText?: string
  notifyClient?: boolean
  notifyOffice?: boolean
}): Promise<void> {
  const res = await callNotify(job)
  if (!res.ok || (res.failed ?? 0) > 0) {
    window.dispatchEvent(new CustomEvent(NOTIFY_FAILURE_EVENT, {
      detail: res.ok ? `${res.failed} channel(s) failed` : 'Notification endpoint unreachable',
    }))
  }
}
