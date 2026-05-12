import type { EmailMessage } from '../types'
import { localStore } from './localStore'

function uid() { return `em${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }

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
  fromAddress: 'noreply@tariqify.com',
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

export function saveNotifSettings(settings: NotifSettings): void {
  try { localStorage.setItem('tqfy_notif_settings', JSON.stringify(settings)) } catch { /**/ }
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
}

export function sendEmail(opts: SendEmailOptions): EmailMessage {
  const cfg = getNotifSettings()
  const email: EmailMessage = {
    id: uid(),
    from: opts.from ?? cfg.fromAddress,
    fromName: opts.fromName ?? cfg.fromName,
    to: opts.to,
    cc: opts.cc,
    subject: opts.subject,
    body: opts.body,
    timestamp: new Date().toISOString(),
    read: true,
    folder: opts.folder ?? 'sent',
    linkedTo: opts.linkedTo,
  }
  localStore.emails.create(email)
  return email
}

export function sendSystemEmail(opts: Omit<SendEmailOptions, 'folder'>): EmailMessage {
  return sendEmail({ ...opts, folder: 'sent' })
}
