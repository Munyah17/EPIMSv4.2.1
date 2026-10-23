import type { Policy, Client, Payment, Group } from '../types'
import { sendSms } from './smsService'
import { sendEmail, getNotifSettings, getSmsRecipientsForEvent } from './mailService'
import { MAILBOXES } from './mailboxes'
import { premiumPeriodLabel } from './productUtils'
import { COMPANY_NAME } from './company'
import { isTobaccoFieldToFloor, fieldToFloorCover } from './exportUtils'

/**
 * Fires the moment a policy is registered, by whatever route -- an agent in
 * the office, or a self-service checkout on the public site.
 *
 * Both the new client and the office are told immediately: the client gets
 * confirmation of what was registered, and the office gets a heads-up they
 * can act on without opening the system.
 *
 * Everything here is best-effort and never rethrows. A registration that
 * succeeded must not appear to fail because a text message or a mailbox was
 * temporarily unreachable.
 */

function money(amount: number): string {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** One office line failing must not swallow the rest — the CEO's number
 *  is often last in the list, and a throw on an earlier send used to
 *  stop it ever going out. */
async function textOffice(numbers: string[], message: string): Promise<void> {
  for (const number of numbers) {
    try { await sendSms(number, message) } catch { /* sendSms records the failure */ }
  }
}

/** Field-to-Floor in one GSM segment. Listing every peril in full took
 *  the alert past 160 characters, and Econet (078, including the main
 *  office line) then delivered nothing. */
function tobaccoCoverSms(sumInsured: number): string {
  const rows = fieldToFloorCover(sumInsured)
  const field = rows.find(r => r.peril === 'Barn Fire')?.benefit ?? 0
  const funeral = rows.find(r => r.peril === 'Funeral')?.benefit ?? 500
  return `F2F barn/hail/wind $${field}, funeral $${funeral}`
}

/**
 * A client registered on the CRM, before any policy exists. Deliberately
 * worded as "registered", never "covered" -- someone on file without a
 * policy has no cover, and telling them otherwise would be the worst kind
 * of mistake for an insurer to make by SMS.
 */
/** A registration that did NOT land — the office needs to know a client
 *  tried to register and it failed, same urgency as a successful one. */
export async function notifyRegistrationFailed(what: string, detail: string): Promise<void> {
  const cfg = getNotifSettings()
  const alert = `${what} FAILED. ${detail}`
  await textOffice(await getSmsRecipientsForEvent('registration'), alert)
  void sendEmail({
    to: cfg.insurerEmail,
    subject: `[Registration Failed] ${what}`,
    from: MAILBOXES.admin,
    body: `A registration did not complete.\n\nWhat failed: ${what}\nDetail:      ${detail}\nTime:        ${new Date().toISOString()}${cfg.signature ? `\n\n---\n${cfg.signature}` : ''}`,
  }).catch(() => { /**/ })
}

export async function notifyClientRegistered(client: Client, registeredBy?: string): Promise<void> {
  const cfg = getNotifSettings()

  if (client.phone) {
    await sendSms(
      client.phone,
      `Welcome ${client.name.split(' ')[0]}, registered. Agent will contact you.`,
    )
  }

  if (client.email) {
    void sendEmail({
      to: client.email,
      subject: `Welcome to ${COMPANY_NAME}`,
      from: MAILBOXES.noreply,
      body: `Dear ${client.name},

Your details have been registered with ${COMPANY_NAME}.

Name:        ${client.name}
National ID: ${client.nationalId || 'not given'}
Phone:       ${client.phone || 'not given'}

Please note this registration does not itself put any cover in place. One of our agents will contact you to arrange a policy suited to you.${cfg.signature ? `\n\n---\n${cfg.signature}` : ''}`,
    }).catch(() => { /**/ })
  }

  const phoneShort = client.phone ? client.phone.replace(/[^0-9]/g, '') : ''
  const alert = `${client.name} registered${phoneShort ? ` ${phoneShort}` : ''}${registeredBy ? ` by ${registeredBy}` : ''}. No policy.`
  await textOffice(await getSmsRecipientsForEvent('registration'), alert)
}

/** An organisation registered for group/corporate cover — the company's
 *  own numbers get told first (the org line AND the named contact's),
 *  then the office. Same proof-of-record SMS the client gets on
 *  registration; an org that never hears from us can't tell a typo'd
 *  number at this point, when it's still free to fix. */
export async function notifyGroupRegistered(group: Group): Promise<void> {
  const cfg = getNotifSettings()
  const kind = group.groupType === 'other' ? (group.customType ?? 'organisation') : group.groupType

  // The organisation's own numbers — org line and the representative's.
  const orgNumbers = [...new Set([group.orgPhone, group.contactPhone].filter(Boolean))] as string[]
  const contactPhoneShort = group.contactPhone ? group.contactPhone.replace(/[^0-9]/g, '') : ''
  const msg = `${group.name} (${kind}) reg. ${group.contactName || 'N/A'}${contactPhoneShort ? ` ${contactPhoneShort}` : ''}. Keep this.`
  for (const number of orgNumbers) {
    await sendSms(number, msg)
  }

  if (group.orgEmail || group.contactEmail) {
    void sendEmail({
      to: (group.orgEmail || group.contactEmail) as string,
      cc: group.orgEmail && group.contactEmail ? group.contactEmail : undefined,
      subject: `${group.name} — registered for group cover with ${COMPANY_NAME}`,
      from: MAILBOXES.noreply,
      body: `Dear ${group.contactName || group.name},\n\n${group.name} has been registered as a group client with ${COMPANY_NAME}.\n\nType:             ${kind}\n\nWe will manage your member roster, monthly invoicing and policy updates through this account. If any detail above is wrong, contact us and we will correct it.${cfg.signature ? `\n\n---\n${cfg.signature}` : ''}`,
    }).catch(() => { /**/ })
  }

  const alert = `${group.name} (${kind}) registered. ${group.contactName || ''}${contactPhoneShort ? ` ${contactPhoneShort}` : ''}`
  await textOffice(await getSmsRecipientsForEvent('registration'), alert)
}

export async function notifyPolicyRegistered(policy: Policy, client: Client): Promise<void> {
  const cfg = getNotifSettings()
  const period = premiumPeriodLabel(policy.productCategory ?? '')
  const cover = money(policy.coverAmount)
  const premium = `${money(policy.premium)}${period}`

  // Field-to-Floor messages quote the per-peril breakdown, never a bare
  // sum insured — the grower needs to know Barn Fire pays $500, not that
  // the four heads add up to $2,000.
  const fieldToFloor = isTobaccoFieldToFloor(policy.productName)
  const coverSms = fieldToFloor ? tobaccoCoverSms(policy.coverAmount) : cover
  const coverEmail = fieldToFloor
    ? `Cover Provided (Field to Floor):\n${fieldToFloorCover(policy.coverAmount).map(c => `  ${c.peril.padEnd(14)}${money(c.benefit)}`).join('\n')}`
    : `Cover Amount:   ${cover}`

  // ── The client ────────────────────────────────────────────────────
  // A receipt-style breakdown, not a one-line summary: the same figures
  // the policy document prints — product, cover breakdown, premium,
  // method, dates — so the SMS alone is proof of cover.
  if (client.phone) {
    if (fieldToFloor) {
      await sendSms(
        client.phone,
        `${client.name} ${policy.policyNumber} reg. ${tobaccoCoverSms(policy.coverAmount)}. ${policy.paymentMethod} ${premium}.`,
      )
    } else {
      await sendSms(
        client.phone,
        `${policy.policyNumber} reg. ${client.name}, ${policy.productName}. ${cover}. ${premium}/${period}. ${policy.paymentMethod}.`,
      )
    }
  }

  if (client.email) {
    void sendEmail({
      to: client.email,
      subject: `Policy ${policy.policyNumber} registered: welcome to ${COMPANY_NAME}`,
      from: MAILBOXES.noreply,
      body: `Dear ${client.name},

Thank you for choosing ${COMPANY_NAME}. Your policy has been registered.

Policy Number:  ${policy.policyNumber}
Product:        ${policy.productName}
${coverEmail}
Premium:        ${premium}
Payment Method: ${policy.paymentMethod}
Start Date:     ${policy.startDate}
Status:         ${policy.status.replace('_', ' ').toUpperCase()}

${policy.status === 'waiting_period'
  ? 'Your policy is in its waiting period. We will let you know as soon as cover becomes active.'
  : 'Your cover is active from the start date shown above.'}

Keep this email for your records. If any detail above is wrong, contact us and we will correct it.${cfg.signature ? `\n\n---\n${cfg.signature}` : ''}`,
    }).catch(() => { /**/ })
  }

  // ── The office ─────────────────────────────────────────────────────
  // The office alert quotes the same figure the client read — a tobacco
  // policy announced as "$2,000" to the office but per-peril to the
  // grower is how "the document says $500" disputes start.
  const phoneShort = client.phone ? client.phone.replace(/\D/g, '') : ''
  const productBit = fieldToFloor ? coverSms : policy.productName
  const alert = `${client.name} ${policy.policyNumber} reg. ${productBit}. ${policy.paymentMethod} ${premium}. ${phoneShort}`
  await textOffice(await getSmsRecipientsForEvent('registration'), alert)

  const insurerRecipient = cfg.insurerEmail

  if (insurerRecipient) {
    void sendEmail({
      to: insurerRecipient,
      subject: `[New Policy] ${policy.policyNumber}: ${client.name}`,
      from: MAILBOXES.admin,
      body: `A new policy has been registered.

Policy Number:  ${policy.policyNumber}
Client:         ${client.name}
National ID:    ${client.nationalId || 'not given'}
Phone:          ${client.phone || 'not given'}
Email:          ${client.email || 'not given'}
Product:        ${policy.productName}
Cover Amount:   ${cover}
Premium:        ${premium}
Start Date:     ${policy.startDate}
Status:         ${policy.status.replace('_', ' ').toUpperCase()}
Payment Method: ${policy.paymentMethod}
${policy.agentName ? `Registered by:  ${policy.agentName}` : 'Registered through the public website.'}${cfg.signature ? `\n\n---\n${cfg.signature}` : ''}`,
    }).catch(() => { /**/ })
  }
}

/**
 * Fires once money is actually confirmed in hand for a payment -- either a
 * manually recorded one already marked 'completed', a pending one just
 * validated, or an online gateway payment the moment it settles. Never for
 * a payment recorded or left as 'pending': nothing has been collected yet,
 * and telling the client or the office otherwise is exactly the kind of
 * mistake an insurer cannot afford to make by SMS.
 */
export async function notifyPaymentReceived(payment: Payment, client: { phone?: string } | null | undefined, productCategory?: string): Promise<void> {
  const amount = money(payment.amount)

  // The farmer never hands over money -- the association settles the
  // annual premium by stop order -- so a "we received your payment" text
  // would announce a transaction the client was never part of. Office
  // alerts below still go out; staff need the receipt regardless.
  if (productCategory !== 'agriculture' && client?.phone) {
    await sendSms(
      client.phone,
      `${payment.policyNumber} paid. ${amount} via ${payment.method}. Ref ${payment.reference}`,
    )
  }

  const alert = `${payment.policyNumber} paid. ${payment.clientName}. ${amount} via ${payment.method}. Ref ${payment.reference}`
  await textOffice(await getSmsRecipientsForEvent('payment'), alert)
}

/** A payment that came back failed — a declined EcoCash prompt, a bounced
 *  Paynow transaction. The client hears it plainly (their bank's own
 *  message doesn't count as ours) and the office knows someone needs a
 *  follow-up call. */
export async function notifyPaymentFailed(payment: { policyNumber: string; clientName: string; amount: number; method?: string; reference?: string }, client: { phone?: string; email?: string | null } | null | undefined, productCategory?: string): Promise<void> {
  const cfg = getNotifSettings()
  const amount = money(payment.amount)

  if (productCategory !== 'agriculture' && client?.phone) {
    await sendSms(
      client.phone,
      `${payment.policyNumber} payment failed. ${amount}. Try again.`,
    )
  }
  if (productCategory !== 'agriculture' && client?.email) {
    void sendEmail({
      to: client.email,
      subject: `Payment not completed: policy ${payment.policyNumber}`,
      from: MAILBOXES.noreply,
      body: `Dear ${payment.clientName},\n\nYour payment of ${amount} for policy ${payment.policyNumber} could not be completed${payment.method ? ` via ${payment.method}` : ''}.\n\nNo money was collected. Please try again — via EcoCash, Paynow, ZIPIT, or at our offices — or contact us for help.${cfg.signature ? `\n\n---\n${cfg.signature}` : ''}`,
    }).catch(() => { /**/ })
  }

  const alert = `${payment.policyNumber} payment FAILED. ${payment.clientName}. ${amount}${payment.method ? ` via ${payment.method}` : ''}`
  await textOffice(await getSmsRecipientsForEvent('payment'), alert)
  void sendEmail({
    to: cfg.insurerEmail,
    subject: `[Payment Failed] ${payment.policyNumber}: ${payment.clientName}`,
    from: MAILBOXES.admin,
    body: `A payment attempt failed.\n\nPolicy:    ${payment.policyNumber}\nClient:    ${payment.clientName}\nAmount:    ${amount}\nMethod:    ${payment.method ?? 'not specified'}\nReference: ${payment.reference ?? '—'}${cfg.signature ? `\n\n---\n${cfg.signature}` : ''}`,
  }).catch(() => { /**/ })
}
