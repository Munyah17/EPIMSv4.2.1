import type { EmailMessage } from '../types'
import { db } from './db'

export interface NotifSettings {
  insurerName: string
  insurerEmail: string
  insurerPhone: string
  netoneEmail: string
  netonePhone: string
  fromAddress: string
  fromName: string
  smsEnabled: boolean
  signature: string
}

export const DEFAULT_NOTIF_SETTINGS: NotifSettings = {
  insurerName: 'Motions Microinsurance',
  insurerEmail: 'claims@motionsmicroinsurance.co.zw',
  insurerPhone: '+263242000000',
  netoneEmail: 'insurance@netone.co.zw',
  netonePhone: '+263712001234',
  fromAddress: 'noreply@enpassent.co.zw',
  fromName: 'Tariqify IMS',
  smsEnabled: false,
  signature: 'Regards,\nTariqify Insurance Management System\nwww.tariqify.com',
}

export function getNotifSettings(): NotifSettings {
  try {
    const raw = localStorage.getItem('tqfy_notif_settings')
    if (raw) return { ...DEFAULT_NOTIF_SETTINGS, ...JSON.parse(raw) }
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
export async function initNotifSettings(): Promise<void> {
  const remote = await db.settings.get<NotifSettings>('notif_settings')
  if (remote) {
    try { localStorage.setItem('tqfy_notif_settings', JSON.stringify({ ...DEFAULT_NOTIF_SETTINGS, ...remote })) } catch { /**/ }
  }
}

export interface SendEmailOptions {
  from?: string
  fromName?: string
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
 * Sent/history) and attempts real delivery through the Netlify email proxy
 * (see netlify/functions/send-email.ts). If the proxy isn't deployed or
 * RESEND_API_KEY isn't configured, the message is still recorded but
 * `delivered` comes back false with an explanatory `error`.
 */
export async function sendEmail(opts: SendEmailOptions): Promise<SendEmailResult> {
  const cfg = getNotifSettings()
  const from = opts.from ?? cfg.fromAddress
  const fromName = opts.fromName ?? cfg.fromName

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
    const res = await fetch('/.netlify/functions/send-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: opts.to, cc: opts.cc, subject: opts.subject, text: opts.body, from, fromName,
        attachmentBase64: opts.attachmentBase64, attachmentFilename: opts.attachmentFilename,
      }),
    })
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}))
      return { email, delivered: false, error: detail?.error ?? `Email service error (HTTP ${res.status})` }
    }
    const result = await res.json().catch(() => ({}))
    if (result?.simulated) {
      return { email, delivered: false, error: 'Email sending is not configured yet — message recorded but not actually sent.' }
    }
    return { email, delivered: true }
  } catch (e) {
    return { email, delivered: false, error: `Could not reach email service: ${e}` }
  }
}

export async function sendSystemEmail(opts: Omit<SendEmailOptions, 'folder'>): Promise<SendEmailResult> {
  return sendEmail({ ...opts, folder: 'sent' })
}
