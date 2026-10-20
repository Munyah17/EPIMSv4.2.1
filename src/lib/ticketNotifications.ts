import type { Ticket } from '../types'
import { sendEmail, getNotifSettings } from './mailService'
import { MAILBOXES } from './mailboxes'
import { notifyPhone } from './notify'
import { COMPANY_NAME } from './company'

/** Get phone numbers configured for a specific event type */
function getSmsRecipientsForEvent(event: 'registration' | 'payment' | 'claim' | 'system'): string[] {
  const cfg = getNotifSettings()
  return cfg.smsRecipients
    .filter(r => r.phone && r.events.includes(event))
    .map(r => r.phone)
}

/** The four fixed office lines, plus the configured Super Admin number if it
 *  isn't already one of them -- the same set every other event in the
 *  system alerts. */
function notifyOffice(message: string, ref?: string) {
  const recipients = [...new Set(getSmsRecipientsForEvent('system'))]
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
    notifyPhone(client.phone, `${COMPANY_NAME}: Your support ticket ${ticket.ticketNumber} has been received. We'll be in touch.`, 'ticket', ticket.ticketNumber)
  }
  notifyOffice(`New support ticket ${ticket.ticketNumber} from ${ticket.clientName}: "${ticket.subject}".`, ticket.ticketNumber)
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
    notifyPhone(client.phone, `${COMPANY_NAME}: You have a new response on ticket ${ticket.ticketNumber}. Check your email for details.`, 'ticket', ticket.ticketNumber)
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
    notifyPhone(client.phone, `${COMPANY_NAME}: Your support ticket ${ticket.ticketNumber} has been closed. Contact us if this isn't fully resolved.`, 'ticket', ticket.ticketNumber)
  }
}
