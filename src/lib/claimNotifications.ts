import type { Claim, ClaimStatus } from '../types'
import { notifyPhone } from './notify'
import { sendEmail, getNotifSettings, getSmsRecipientsForEvent } from './mailService'
import { db } from './db'
import { MAILBOXES } from './mailboxes'
import { noticeSms } from './smsText'
import { supabase } from './supabase'
import { resolveSmsText, smsVarMoney } from './smsTemplates'

/** NetOne distribution partnership is suspended for now — flip this back
 *  once it resumes rather than re-wiring the notification pipeline. */
export const NETONE_SUSPENDED = true

/** Client-facing claim text. A 'claim_update' template (Bulk SMS →
 *  Templates) overrides the standard wording — the product's own row
 *  wins over the type-wide one — while any miss or lookup failure falls
 *  back to the built-in shape so an edit can never leave a claim
 *  notification unsent. Staff-directed notices (assignments, decisions
 *  needed) are NOT templated: they address staff, not the client. */
async function claimSms(claim: Claim, event: string, detail?: string): Promise<string> {
  let productId: string | undefined
  try { productId = (await db.policies.get(claim.policyId)).data?.productId } catch { /**/ }
  return resolveSmsText(supabase, 'claim_update', {
    productId,
    vars: {
      clientName: claim.clientName,
      claimNumber: claim.claimNumber,
      policyNumber: claim.policyNumber,
      productName: claim.productName,
      event,
      detail,
      amount: smsVarMoney(claim.amount),
      claimStatus: claim.status,
    },
    fallback: noticeSms(claim.clientName, claim.claimNumber, event, detail),
  })
}

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

  const allEmails = [cfg.insurerEmail, NETONE_SUSPENDED ? '' : cfg.netoneEmail, client.email].filter(Boolean)
  const cc = allEmails.join(', ')

  const subject = `[New Claim] ${claim.claimNumber}: ${claim.clientName}`
  const staffBody = `A new insurance claim has been submitted and requires review.
${claimSummaryBlock(claim)}

Please log in to TariqifyIMS to review and process this claim.${signature(cfg.signature)}`

  const clientBody = `Dear ${claim.clientName},

Your insurance claim has been successfully submitted for processing. You can expect a response within 24 hours.
${claimSummaryBlock(claim)}

Please retain this email for your records. All parties will be copied on further updates.${signature(cfg.signature)}`

  void sendEmail({ to: cfg.insurerEmail, cc, subject, body: staffBody, linkedTo: claim.id, from: MAILBOXES.claims })
  if (!NETONE_SUSPENDED && cfg.netoneEmail) {
    void sendEmail({ to: cfg.netoneEmail, cc, subject, body: staffBody, linkedTo: claim.id, from: MAILBOXES.claims })
  }
  if (client.email) {
    void sendEmail({ to: client.email, cc, subject, body: clientBody, linkedTo: claim.id, folder: 'claims', from: MAILBOXES.claims })
  }
  if (client.phone) {
    notifyPhone(client.phone, await claimSms(claim, 'claim submitted', "We'll notify you"), 'claim', claim.claimNumber)
  }
  notifyOffice(claim, `submitted by ${claim.clientName}, $${claim.amount.toLocaleString()}, awaiting intake`)
}

export async function notifyClaimStatusChanged(claim: Claim, previousStatus: ClaimStatus): Promise<void> {
  if (claim.status === previousStatus) return
  if (claim.status === 'paid') {
    await notifyClaimResolved(claim)
    return
  }

  const cfg = getNotifSettings()
  const client = await getClientContact(claim)

  const allEmails = [cfg.insurerEmail, NETONE_SUSPENDED ? '' : cfg.netoneEmail, client.email].filter(Boolean)
  const cc = allEmails.join(', ')

  const statusLabel = claim.status.replace('_', ' ')
  const subject = `[Claim Update] ${claim.claimNumber}: Status changed to ${statusLabel}`

  const staffBody = `Claim ${claim.claimNumber} status has changed from "${previousStatus.replace('_', ' ')}" to "${statusLabel}".
${claimSummaryBlock(claim)}

Log in to TariqifyIMS to take further action.${signature(cfg.signature)}`

  const clientBody = `Dear ${claim.clientName},

Your claim ${claim.claimNumber} has been updated. New status: ${statusLabel.toUpperCase()}.
${claimSummaryBlock(claim)}

We will keep you informed as this claim progresses. All parties are copied on this correspondence.${signature(cfg.signature)}`

  void sendEmail({ to: cfg.insurerEmail, cc, subject, body: staffBody, linkedTo: claim.id, folder: 'claims', from: MAILBOXES.claims })
  if (!NETONE_SUSPENDED && cfg.netoneEmail) {
    void sendEmail({ to: cfg.netoneEmail, cc, subject, body: staffBody, linkedTo: claim.id, folder: 'claims', from: MAILBOXES.claims })
  }
  if (client.email) {
    void sendEmail({ to: client.email, cc, subject, body: clientBody, linkedTo: claim.id, folder: 'claims', from: MAILBOXES.claims })
  }
}

// ── Pipeline handoffs: intake (Claims Receiver) -> assessment (Claims
// Processor) -> final_review (MD/COO) -> closed. Each handoff notifies the
// client and whoever is picking the claim up next — never the agent (their
// portal reflects the outcome passively via the claim's own status/pill,
// no push notification, per the 2026-08 access review).

interface StaffContact { email?: string; phone?: string; name: string }

/** Every claims-pipeline stage alerts the office (SMS) and the Motions info
 *  mailbox (email CC), in addition to the client and whichever staff member
 *  is picking the claim up next. */
const CLAIMS_ESCALATION_CC_EMAIL = 'info@motions.co.zw'

/** Get phone numbers configured for claims notifications */
async function notifyOffice(claim: Claim, stageMessage: string) {
  const recipients = [...new Set(await getSmsRecipientsForEvent('claim'))]
  for (const number of recipients) {
    notifyPhone(number, `Claim ${claim.claimNumber}: ${stageMessage}`, 'claim', claim.claimNumber)
  }
}

export async function notifyClaimIntakeAccepted(claim: Claim, processor: StaffContact): Promise<void> {
  const cfg = getNotifSettings()
  const client = await getClientContact(claim)
  const subject = `[Claim Received] ${claim.claimNumber}: Now with Claims Processing`
  await notifyOffice(claim, `accepted at intake, assigned to ${processor.name} for assessment.`)

  if (client.email) {
    void sendEmail({
      to: client.email, cc: CLAIMS_ESCALATION_CC_EMAIL, subject, linkedTo: claim.id, folder: 'claims', from: MAILBOXES.claims,
      body: `Dear ${claim.clientName},\n\nYour claim ${claim.claimNumber} has been received and accepted for processing.${claimSummaryBlock(claim)}\n\nIt is now with our claims processing team for assessment.${signature(cfg.signature)}`,
    })
  }
  if (client.phone) notifyPhone(client.phone, await claimSms(claim, 'claim received', 'Processing'), 'claim', claim.claimNumber)

  if (processor.email) {
    void sendEmail({
      to: processor.email, subject: `[Assigned] Claim ${claim.claimNumber} needs assessment`, linkedTo: claim.id, folder: 'claims', from: MAILBOXES.claims,
      body: `${claim.claimNumber} has been accepted at intake and assigned to you for assessment.${claimSummaryBlock(claim)}\n\nLog in to TariqifyIMS to review.${signature(cfg.signature)}`,
    })
  }
  if (processor.phone) notifyPhone(processor.phone, noticeSms(processor.name, claim.claimNumber, 'claim assigned', 'Assess.', processor.phone), 'claim', claim.claimNumber)
}

export async function notifyClaimIntakeRejected(claim: Claim): Promise<void> {
  const cfg = getNotifSettings()
  const client = await getClientContact(claim)
  const subject = `[Claim Not Accepted] ${claim.claimNumber}`
  await notifyOffice(claim, 'rejected at intake.')
  if (client.email) {
    void sendEmail({
      to: client.email, cc: CLAIMS_ESCALATION_CC_EMAIL, subject, linkedTo: claim.id, folder: 'claims', from: MAILBOXES.claims,
      body: `Dear ${claim.clientName},\n\nWe were unable to accept your claim ${claim.claimNumber} for processing.${claimSummaryBlock(claim)}\n\nPlease contact us if you believe this is in error.${signature(cfg.signature)}`,
    })
  }
  if (client.phone) notifyPhone(client.phone, await claimSms(claim, 'claim rejected', 'Contact us'), 'claim', claim.claimNumber)
}

export async function notifyClaimEscalated(claim: Claim, reviewer: StaffContact): Promise<void> {
  const cfg = getNotifSettings()
  const client = await getClientContact(claim)
  const subject = `[Claim Under Final Review] ${claim.claimNumber}`
  await notifyOffice(claim, `escalated to ${reviewer.name} for final review.`)

  if (client.email) {
    void sendEmail({
      to: client.email, cc: CLAIMS_ESCALATION_CC_EMAIL, subject, linkedTo: claim.id, folder: 'claims', from: MAILBOXES.claims,
      body: `Dear ${claim.clientName},\n\nYour claim ${claim.claimNumber} has completed assessment and is now with our final reviewer for a decision.${claimSummaryBlock(claim)}${signature(cfg.signature)}`,
    })
  }
  if (client.phone) notifyPhone(client.phone, await claimSms(claim, 'claim with reviewer'), 'claim', claim.claimNumber)

  if (reviewer.email) {
    void sendEmail({
      to: reviewer.email, subject: `[Decision Needed] Claim ${claim.claimNumber}`, linkedTo: claim.id, folder: 'claims', from: MAILBOXES.claims,
      body: `${claim.claimNumber} has been assessed and escalated to you for a final decision.${claimSummaryBlock(claim)}${claim.assessmentNotes ? `\n\nAssessment notes:\n${claim.assessmentNotes}` : ''}\n\nLog in to TariqifyIMS to approve or decline.${signature(cfg.signature)}`,
    })
  }
  if (reviewer.phone) notifyPhone(reviewer.phone, noticeSms(reviewer.name, claim.claimNumber, 'claim needs decision', 'Decide.', reviewer.phone), 'claim', claim.claimNumber)
}

export async function notifyClaimFinalDecision(claim: Claim): Promise<void> {
  const cfg = getNotifSettings()
  const client = await getClientContact(claim)
  const approved = claim.status === 'approved'
  const subject = `[Claim ${approved ? 'Approved' : 'Declined'}] ${claim.claimNumber}`
  await notifyOffice(claim, `final decision: ${approved ? 'APPROVED' : 'DECLINED'}.`)

  if (client.email) {
    void sendEmail({
      to: client.email, cc: CLAIMS_ESCALATION_CC_EMAIL, subject, linkedTo: claim.id, folder: 'claims', from: MAILBOXES.claims,
      body: `Dear ${claim.clientName},\n\nA final decision has been made on your claim ${claim.claimNumber}: ${approved ? 'APPROVED' : 'DECLINED'}.${claimSummaryBlock(claim)}\n\n${approved ? 'Payment will be processed shortly.' : 'If you have questions about this decision, please contact us.'}${signature(cfg.signature)}`,
    })
  }
  if (client.phone) {
    notifyPhone(client.phone, await claimSms(claim, `claim ${approved ? 'APPROVED' : 'DECLINED'}`), 'claim', claim.claimNumber)
  }
}

async function notifyClaimResolved(claim: Claim): Promise<void> {
  const cfg = getNotifSettings()
  const client = await getClientContact(claim)

  const allEmails = [cfg.insurerEmail, NETONE_SUSPENDED ? '' : cfg.netoneEmail, client.email].filter(Boolean)
  const cc = allEmails.join(', ')

  const subject = `[Claim Closed] ${claim.claimNumber}: Payment Processed`

  const staffBody = `Claim ${claim.claimNumber} has been resolved and payment processed.
${claimSummaryBlock(claim)}

This claim is now closed. No further action required.${signature(cfg.signature)}`

  const clientBody = `Dear ${claim.clientName},

We are pleased to inform you that your claim ${claim.claimNumber} has been approved and payment of $${claim.amount.toLocaleString()} has been processed.
${claimSummaryBlock(claim)}

Thank you for choosing our insurance services.${signature(cfg.signature)}`

  void sendEmail({ to: cfg.insurerEmail, cc, subject, body: staffBody, linkedTo: claim.id, folder: 'claims', from: MAILBOXES.claims })
  if (!NETONE_SUSPENDED && cfg.netoneEmail) {
    void sendEmail({ to: cfg.netoneEmail, cc, subject, body: staffBody, linkedTo: claim.id, folder: 'claims', from: MAILBOXES.claims })
  }
  if (client.email) {
    void sendEmail({ to: client.email, cc, subject, body: clientBody, linkedTo: claim.id, folder: 'claims', from: MAILBOXES.claims })
  }
  if (client.phone) {
    notifyPhone(client.phone, await claimSms(claim, 'claim paid', `$${claim.amount.toLocaleString()}`), 'claim', claim.claimNumber)
  }
  await notifyOffice(claim, `paid, $${claim.amount.toLocaleString()} processed. Closed`)
}
