import type { Claim, ClaimStatus } from '../types'
import { sendEmail, getNotifSettings } from './mailService'
import { db } from './db'

async function getClientContact(claim: Claim): Promise<{ email: string; phone: string }> {
  const { data } = await db.clients.list()
  const client = data?.find(c => c.id === claim.clientId)
  return { email: client?.email ?? '', phone: client?.phone ?? '' }
}

function signature(sig: string) { return sig ? `\n\n---\n${sig}` : '' }

function claimSummaryBlock(claim: Claim) {
  return `
Claim Number:   ${claim.claimNumber}
Policy Number:  ${claim.policyNumber}
Client Name:    ${claim.clientName}
Product:        ${claim.productName}
Claim Type:     ${claim.claimType}
Amount:         $${claim.amount.toLocaleString()}
Date of Event:  ${claim.dateOfEvent}
Date Submitted: ${claim.dateSubmitted}
Status:         ${claim.status.replace('_', ' ').toUpperCase()}
${claim.description ? `\nDescription:\n${claim.description}` : ''}`
}

export async function notifyClaimCreated(claim: Claim): Promise<void> {
  const cfg = getNotifSettings()
  const client = await getClientContact(claim)

  const allEmails = [cfg.insurerEmail, cfg.netoneEmail, client.email].filter(Boolean)
  const cc = allEmails.join(', ')

  const subject = `[New Claim] ${claim.claimNumber} — ${claim.clientName}`
  const staffBody = `A new insurance claim has been submitted and requires review.
${claimSummaryBlock(claim)}

Please log in to Tariqify IMS to review and process this claim.${signature(cfg.signature)}`

  const clientBody = `Dear ${claim.clientName},

Your insurance claim has been successfully submitted for processing. You can expect a response within 24 hours.
${claimSummaryBlock(claim)}

Please retain this email for your records. All parties will be copied on further updates.${signature(cfg.signature)}`

  void sendEmail({ to: cfg.insurerEmail, cc, subject, body: staffBody, linkedTo: claim.id })
  void sendEmail({ to: cfg.netoneEmail, cc, subject, body: staffBody, linkedTo: claim.id })
  if (client.email) {
    void sendEmail({ to: client.email, cc, subject, body: clientBody, linkedTo: claim.id, folder: 'claims' })
  }
}

export async function notifyClaimStatusChanged(claim: Claim, previousStatus: ClaimStatus): Promise<void> {
  if (claim.status === previousStatus) return
  if (claim.status === 'paid') {
    await notifyClaimResolved(claim)
    return
  }

  const cfg = getNotifSettings()
  const client = await getClientContact(claim)

  const allEmails = [cfg.insurerEmail, cfg.netoneEmail, client.email].filter(Boolean)
  const cc = allEmails.join(', ')

  const statusLabel = claim.status.replace('_', ' ')
  const subject = `[Claim Update] ${claim.claimNumber} — Status changed to ${statusLabel}`

  const staffBody = `Claim ${claim.claimNumber} status has changed from "${previousStatus.replace('_', ' ')}" to "${statusLabel}".
${claimSummaryBlock(claim)}

Log in to Tariqify IMS to take further action.${signature(cfg.signature)}`

  const clientBody = `Dear ${claim.clientName},

Your claim ${claim.claimNumber} has been updated. New status: ${statusLabel.toUpperCase()}.
${claimSummaryBlock(claim)}

We will keep you informed as this claim progresses. All parties are copied on this correspondence.${signature(cfg.signature)}`

  void sendEmail({ to: cfg.insurerEmail, cc, subject, body: staffBody, linkedTo: claim.id, folder: 'claims' })
  void sendEmail({ to: cfg.netoneEmail, cc, subject, body: staffBody, linkedTo: claim.id, folder: 'claims' })
  if (client.email) {
    void sendEmail({ to: client.email, cc, subject, body: clientBody, linkedTo: claim.id, folder: 'claims' })
  }
}

async function notifyClaimResolved(claim: Claim): Promise<void> {
  const cfg = getNotifSettings()
  const client = await getClientContact(claim)

  const allEmails = [cfg.insurerEmail, cfg.netoneEmail, client.email].filter(Boolean)
  const cc = allEmails.join(', ')

  const subject = `[Claim Closed] ${claim.claimNumber} — Payment Processed`

  const staffBody = `Claim ${claim.claimNumber} has been resolved and payment processed.
${claimSummaryBlock(claim)}

This claim is now closed. No further action required.${signature(cfg.signature)}`

  const clientBody = `Dear ${claim.clientName},

We are pleased to inform you that your claim ${claim.claimNumber} has been approved and payment of $${claim.amount.toLocaleString()} has been processed.
${claimSummaryBlock(claim)}

Thank you for choosing our insurance services.${signature(cfg.signature)}`

  void sendEmail({ to: cfg.insurerEmail, cc, subject, body: staffBody, linkedTo: claim.id, folder: 'claims' })
  void sendEmail({ to: cfg.netoneEmail, cc, subject, body: staffBody, linkedTo: claim.id, folder: 'claims' })
  if (client.email) {
    void sendEmail({ to: client.email, cc, subject, body: clientBody, linkedTo: claim.id, folder: 'claims' })
  }
}
