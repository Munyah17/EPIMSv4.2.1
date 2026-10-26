import type { EmailMessage } from '../types'
import { db } from './db'
import { supabase } from './supabase'
import { reportOutcome } from './notify'
import { parseRecipientPhones, DEFAULT_OFFICE_SMS } from './smsText'

export interface SmsRecipient {
  id: string
  phone: string
  /** Which notification types this number receives */
  events: ('registration' | 'payment' | 'claim' | 'system')[]
}

export interface NotifSettings {
  insurerName: string
  insurerEmail: string
  insurerPhone: string
  netoneEmail: string
  netonePhone: string
  fromAddress: string
  fromName: string
  /** Where replies to outgoing notification emails should land — the sending
   *  address is typically a noreply mailbox, so replies need somewhere real
   *  to go instead of bouncing or vanishing. */
  replyTo: string
  smsEnabled: boolean
  /** Pause switch for the automatic SMS a client gets the moment they (or
   *  their group/policy) are registered — from Settings → Notifications.
   *  Office copies still go out; only the client-facing text stops. The
   *  flag lives in shared app_settings so it applies to every pipeline:
   *  counter registrations, group registrations, partner API sales and
   *  website checkouts alike. */
  registrationClientSmsPaused: boolean
  signature: string
  /** Configurable SMS recipients with event type filtering */
  smsRecipients: SmsRecipient[]
  /** Shown in the Policy Report/Certificate PDF header (Head Office block)
   *  — confirmed real values, editable from Settings -> Notifications if
   *  the office ever moves. */
  companyAddress: string
  companyPhone: string
  companyEmail: string
}

export const DEFAULT_NOTIF_SETTINGS: NotifSettings = {
  // Motions Microinsurance is the sole insurer this system underwrites for.
  insurerName: 'Motions Microinsurance',
  insurerEmail: 'info@motions.co.zw',
  insurerPhone: '+263242000000',
  // NetOne partnership is suspended for now — kept here (rather than
  // deleted) purely so Settings has something to show/restore; nothing
  // in the notification pipeline sends to it while suspended (see
  // NETONE_SUSPENDED in claimNotifications.ts and reminderEngine.ts).
  netoneEmail: 'insurance@netone.co.zw',
  netonePhone: '+263712001234',
  fromAddress: 'noreply@motions.co.zw',
  fromName: 'Motions Microinsurance',
  replyTo: 'admin@motions.co.zw',
  smsEnabled: false,
  registrationClientSmsPaused: false,
  signature: 'Regards,\nMotions Microinsurance\n+263 780 086 175\nwww.motions.co.zw',
  // The four office lines. +263780086175 is the main number, carried
  // by the CEO — it has to be on every event unless an admin removes it.
  // Single copy lives in smsText.ts (DEFAULT_OFFICE_SMS) so the browser
  // and the api/ functions seed from the same list.
  smsRecipients: DEFAULT_OFFICE_SMS.map((phone, i) => ({
    id: String(i + 1),
    phone,
    events: ['registration', 'payment', 'claim', 'system'],
  })),
  companyAddress: '24 Midlothian Avenue, Eastlea, Harare, Zimbabwe',
  companyPhone: '+263 780 086 175 / +263 780 086 176 / +263 780 086 177',
  companyEmail: 'info@motions.co.zw',
}

export function getNotifSettings(): NotifSettings {
  try {
    const raw = localStorage.getItem('tqfy_notif_settings')
    if (raw) {
      const parsed = JSON.parse(raw)
      // Merge smsRecipients to preserve existing ones if new structure
      return {
        ...DEFAULT_NOTIF_SETTINGS,
        ...parsed,
        smsRecipients: parsed.smsRecipients || DEFAULT_NOTIF_SETTINGS.smsRecipients,
      }
    }
  } catch { /**/ }
  return { ...DEFAULT_NOTIF_SETTINGS }
}

/** Writes through to the shared app_settings table (admin/super_admin only,
 *  enforced by RLS) as well as the local cache, so every staff browser
 *  converges on whatever a Super Admin configured instead of each browser
 *  quietly keeping its own copy. */
export function saveNotifSettings(settings: NotifSettings): void {
  try { localStorage.setItem('tqfy_notif_settings', JSON.stringify(settings)) } catch { /**/ }
  void db.settings.set('notif_settings', settings)
}

/** Call once at app startup: pulls the shared settings down into the local
 *  cache so getNotifSettings() (synchronous, used all over the app) reflects
 *  whatever was last saved by a Super Admin rather than this browser's own
 *  possibly-stale localStorage copy. */
/**
 * Who should be texted for this event, from the shared settings (so the
 * staff member who captures a client uses the list an admin saved, not
 * whatever this browser happened to remember).
 *
 * Numbers are returned as +263XXXXXXXXX. A box with several numbers
 * separated by "/" still delivers to each of them. A bad number is
 * skipped; it does not drop the rest of the list.
 */
export async function getSmsRecipientsForEvent(event: SmsRecipient['events'][number]): Promise<string[]> {
  let list = getNotifSettings().smsRecipients
  try {
    const remote = await db.settings.get<NotifSettings>('notif_settings')
    if (remote?.smsRecipients) list = remote.smsRecipients
  } catch { /* the local copy still sends */ }
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of list ?? []) {
    const events = Array.isArray(r?.events) ? r.events : []
    if (!events.includes(event)) continue
    for (const n of parseRecipientPhones(r?.phone ?? '')) {
      if (seen.has(n)) continue
      seen.add(n)
      out.push(`+${n}`)
    }
  }
  return out
}

export async function initNotifSettings(): Promise<void> {
  const remote = await db.settings.get<NotifSettings>('notif_settings')
  if (remote) {
    try { localStorage.setItem('tqfy_notif_settings', JSON.stringify({ ...DEFAULT_NOTIF_SETTINGS, ...remote })) } catch { /**/ }
  }
}

export interface SendEmailOptions {
  from?: string
  fromName?: string
  replyTo?: string
  to: string
  cc?: string
  subject: string
  body: string
  folder?: EmailMessage['folder']
  linkedTo?: string
  /** Base64 payload (no data: URI prefix) — e.g. from getPolicyReportPdfBase64(). */
  attachmentBase64?: string
  attachmentFilename?: string
}

export interface SendEmailResult {
  email: EmailMessage
  /** True only if the message was actually handed off to the email provider (not just recorded). */
  delivered: boolean
  error?: string
}

/**
 * Records the message (via the Supabase-backed db layer, so it shows up in
 * Sent/history) and attempts real delivery through the server-side email
 * proxy (/api/send-email — api/send-email.ts). If the endpoint fails or
 * RESEND_API_KEY isn't configured, the message is still recorded but
 * `delivered` comes back false with an explanatory `error`.
 */
export async function sendEmail(opts: SendEmailOptions): Promise<SendEmailResult> {
  const cfg = getNotifSettings()
  const from = opts.from ?? cfg.fromAddress
  const fromName = opts.fromName ?? cfg.fromName
  const replyTo = opts.replyTo ?? cfg.replyTo

  const { data: saved } = await db.emails.create({
    from, fromName, to: opts.to, cc: opts.cc, subject: opts.subject, body: opts.body,
    read: true, folder: opts.folder ?? 'sent', linkedTo: opts.linkedTo, starred: false, attachments: [],
  })
  const email: EmailMessage = saved ?? {
    id: `em-local-${Date.now()}`, from, fromName, to: opts.to, cc: opts.cc,
    subject: opts.subject, body: opts.body, timestamp: new Date().toISOString(),
    read: true, starred: false, folder: opts.folder ?? 'sent', linkedTo: opts.linkedTo, attachments: [],
  }

  try {
    // /api/send-email only answers signed-in users (or the cron secret) —
    // it sends on our own mail accounts, so anonymous calls are refused.
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch('/api/send-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}) },
      body: JSON.stringify({
        to: opts.to, cc: opts.cc, subject: opts.subject, text: opts.body, from, fromName, replyTo,
        attachmentBase64: opts.attachmentBase64, attachmentFilename: opts.attachmentFilename,
      }),
    })
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}))
      const err = detail?.error ?? `Email service error (HTTP ${res.status})`
      reportOutcome({ channel: 'email', recipient: opts.to, event: opts.subject.slice(0, 60), status: 'failed', detail: err })
      return { email, delivered: false, error: err }
    }
    const result = await res.json().catch(() => ({}))
    if (result?.simulated) {
      const err = 'Email sending is not configured yet; message recorded but not actually sent.'
      reportOutcome({ channel: 'email', recipient: opts.to, event: opts.subject.slice(0, 60), status: 'skipped', detail: err })
      return { email, delivered: false, error: err }
    }
    reportOutcome({ channel: 'email', recipient: opts.to, event: opts.subject.slice(0, 60), status: 'sent' })
    return { email, delivered: true }
  } catch (e) {
    const err = `Could not reach email service: ${e}`
    reportOutcome({ channel: 'email', recipient: opts.to, event: opts.subject.slice(0, 60), status: 'failed', detail: err })
    return { email, delivered: false, error: err }
  }
}

export async function sendSystemEmail(opts: Omit<SendEmailOptions, 'folder'>): Promise<SendEmailResult> {
  return sendEmail({ ...opts, folder: 'sent' })
}
