import type { Ticket } from '../types'
import { sendEmail, getNotifSettings, DEFAULT_NOTIF_SETTINGS } from './mailService'
import { MAILBOXES } from './mailboxes'
import { notifyPhone } from './notify'
import { COMPANY_NAME } from './company'
import { db } from './db'

/** Get phone numbers configured for a specific event type.
 *  Fetches from database to ensure newly added recipients are immediately available. */
async function getSmsRecipientsForEvent(event: 'registration' | 'payment' | 'claim' | 'system'): Promise<string[]> {
  // Try to get latest settings from database first
  const remote = await db.settings.get<any>('notif_settings')
  const cfg = remote ? { ...DEFAULT_NOTIF_SETTINGS, ...remote } : getNotifSettings()
  return cfg.smsRecipients
    .filter((r: any) => r.phone && r.events.includes(event))
    .map((r: any) => r.phone)
}

/** The four fixed office lines, plus the configured Super Admin number if it
 *  isn't already one of them -- the same set every other event in the
 *  system alerts. */
async function notifyOffice(message: string, ref?: string) {
  const recipients = [...new Set(await getSmsRecipientsForEvent('system'))]
  for (const number of recipients) {
    notifyPhone(number, `${COMPANY_NAME}: ${message}`, 'ticket', ref)
  }
}

interface ClientContact {
  email?: string
  phone?: string
}

/** A new support ticket was filed -- tells the client it was received, and
 *  the office that something needs picking up. */
export async function notifyTicketCreated(ticket: Ticket, client: ClientContact): Promise<void> {
  const cfg = getNotifSettings()

  if (client.email) {
    void sendEmail({
      to: client.email,
      subject: `[Ticket ${ticket.ticketNumber}] We've received your request`,
      from: MAILBOXES.admin,
      linkedTo: ticket.id,
      body: `Dear ${ticket.clientName},

We have received your support request and will respond as soon as possible.

Ticket Number: ${ticket.ticketNumber}
Subject:       ${ticket.subject}
Priority:      ${ticket.priority}

${ticket.description}${cfg.signature ? `\n\n---\n${cfg.signature}` : ''}`,
    })
  }
  if (client.phone) {
    notifyPhone(client.phone, `${COMPANY_NAME}: Ticket ${ticket.ticketNumber} received. We'll respond.`, 'ticket', ticket.ticketNumber)
  }
  await notifyOffice(`New ticket ${ticket.ticketNumber} from ${ticket.clientName}: "${ticket.subject}"`, ticket.ticketNumber)
}

/** Staff posted a reply -- only the client needs telling; the staff member
 *  who wrote it obviously already knows. */
export async function notifyTicketReplied(ticket: Ticket, client: ClientContact, replyText: string): Promise<void> {
  const cfg = getNotifSettings()

  if (client.email) {
    void sendEmail({
      to: client.email,
      subject: `[Ticket ${ticket.ticketNumber}] New response`,
      from: MAILBOXES.admin,
      linkedTo: ticket.id,
      body: `Dear ${ticket.clientName},

You have a new response on your support ticket ${ticket.ticketNumber} (${ticket.subject}):

"${replyText}"

Log in or reply to this email to continue the conversation.${cfg.signature ? `\n\n---\n${cfg.signature}` : ''}`,
    })
  }
  if (client.phone) {
    notifyPhone(client.phone, `${COMPANY_NAME}: New response on ticket ${ticket.ticketNumber}. Check email.`, 'ticket', ticket.ticketNumber)
  }
}

/** The ticket was closed -- tells the client plainly, and gives them a way
 *  to say "not actually resolved" without opening a new ticket: staff can
 *  reopen it from the same view with one click, and this line points them
 *  to how (get back in touch rather than a self-service portal that does
 *  not exist yet). */
export async function notifyTicketClosed(ticket: Ticket, client: ClientContact): Promise<void> {
  const cfg = getNotifSettings()

  if (client.email) {
    void sendEmail({
      to: client.email,
      subject: `[Ticket ${ticket.ticketNumber}] Closed`,
      from: MAILBOXES.admin,
      linkedTo: ticket.id,
      body: `Dear ${ticket.clientName},

Your support ticket ${ticket.ticketNumber} (${ticket.subject}) has been closed.

If this did not fully resolve your issue, contact us and we will reopen it.${cfg.signature ? `\n\n---\n${cfg.signature}` : ''}`,
    })
  }
  if (client.phone) {
    notifyPhone(client.phone, `${COMPANY_NAME}: Ticket ${ticket.ticketNumber} closed. Contact us if unresolved.`, 'ticket', ticket.ticketNumber)
  }
}
