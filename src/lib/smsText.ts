/**
 * Zimbabwe SMS shaping.
 *
 * Afrosoft accepts a number only as 263 followed by 9 digits, and Econet
 * (077 and 078 — the CEO's +263780086175 is 078) drops anything that is
 * not a single GSM-7 segment. A Unicode character or a 161st character
 * is enough for the gateway to accept the request and the handset to
 * show nothing. Every sender runs text and numbers through here first.
 */

export const SMS_GSM_LIMIT = 160

const GSM_BASIC = new Set(
  ("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ ÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?"
    + '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà ').split(''),
)
const GSM_EXT = new Set('^{}\\[~]|€'.split(''))

const UNICODE_TO_GSM: Record<string, string> = {
  '\u2014': '-', '\u2013': '-', '\u2015': '-',
  '\u201C': '"', '\u201D': '"', '\u201E': '"',
  '\u2018': "'", '\u2019': "'", '\u00B4': "'", '`': "'",
  '\u2026': '...',
  '\u2022': '-', '\u00B7': '-',
  '\u00A0': ' ',
}

/** 263 + 9 digits, or null when the text can never be a Zimbabwe mobile. */
export function normalizeZwMobile(raw: string): string | null {
  let digits = String(raw ?? '').replace(/\D/g, '')
  if (!digits) return null
  if (digits.startsWith('00')) digits = digits.slice(2)
  // Dial code typed twice: "+263263780086175".
  if (digits.startsWith('263263')) digits = digits.slice(3)
  if (digits.startsWith('0')) digits = `263${digits.slice(1)}`
  // "+263 0780086175" keeps the trunk 0. It has to come off or the
  // gateway stores a number that does not exist.
  else if (digits.startsWith('2630')) digits = `263${digits.slice(4)}`
  else if (!digits.startsWith('263')) digits = `263${digits}`
  return /^263[17]\d{8}$/.test(digits) ? digits : null
}

/** One box may hold several lines ("+263… / +263…"). Each valid one is kept, once. */
export function parseRecipientPhones(raw: string): string[] {
  const pieces = String(raw ?? '').split(/[,;/|]+/).map(s => s.trim()).filter(Boolean)
  const out: string[] = []
  for (const piece of pieces) {
    const n = normalizeZwMobile(piece)
    if (n && !out.includes(n)) out.push(n)
  }
  return out
}

export function toGsm(raw: string): string {
  let out = ''
  for (const ch of String(raw ?? '')) {
    if (GSM_BASIC.has(ch) || GSM_EXT.has(ch)) out += ch
    else if (UNICODE_TO_GSM[ch]) out += UNICODE_TO_GSM[ch]
    else if (ch === '\t' || ch === '\n' || ch === '\r') out += ' '
    else out += ' '
  }
  return out.replace(/ {2,}/g, ' ').trim()
}

export function gsmUnits(text: string): number {
  let n = 0
  for (const ch of text) n += GSM_EXT.has(ch) ? 2 : 1
  return n
}

/**
 * ONE message, always — sent whole in a single request even when it runs
 * past 160 units. The gateway handles it as one concatenated SMS; we
 * never split into "(1/2)" fragments ourselves and never truncate.
 * (toGsm still strips characters Econet silently drops.)
 */
export function smsParts(raw: string): string[] {
  const text = toGsm(raw)
  return text ? [text] : []
}

/** Office-copy envelope label. Registration carries none — the message
 *  itself is the alert, and a REG: prefix was banned outright. Other
 *  events keep their short uppercase tag (PAYMENT:, CLAIM:, …). */
export function smsEventLabel(event: string): string {
  return event === 'registration' ? '' : event.toUpperCase()
}

/**
 * Collapses upstream text that is one message repeated — providers
 * concatenate status and narrative fields that often carry identical
 * text, and the reply lands as "Something went wrong, please try
 * again.Something went wrong, please try again." Shown verbatim that
 * looks like a bug of ours; one copy says the same thing.
 */
export function dedupeMessage(raw: string): string {
  const msg = String(raw ?? '').trim()
  if (!msg) return msg
  // Whole string = the same half twice, no separator ("X.X").
  if (msg.length % 2 === 0) {
    const half = msg.length / 2
    if (msg.slice(0, half) === msg.slice(half)) return msg.slice(0, half).trim()
  }
  const sentences = msg.match(/[^.!?]+[.!?]+\s*/g)
  if (!sentences || sentences.length < 2) return msg
  // Every sentence identical ("X. X.").
  if (sentences.every(s => s.trim() === sentences[0].trim())) return sentences[0].trim()
  // Consecutive duplicates ("A. A. B." → "A. B.").
  const kept = sentences.filter((s, i) => i === 0 || s.trim() !== sentences[i - 1].trim())
  return kept.map(s => s.trim()).join(' ')
}

// ── The ONE client-facing message shape ─────────────────────────────
//
// Approved standard (verbatim example, variables swapped per record):
//
//   Demo User TOB0514. Field To Floor Standard. Cover: Barn Fire
//   $500, Hail Storm $500, Wind Storm $500, Funeral $500. Stop Order
//   $105.
//
// Grammar: {clientName} {policyNumber} {event}. {details}. {method}
// {premium}{period}. Field To Floor products drop the "Reg." verb and
// the "/yr" period label — the peril breakdown is the cover clause —
// every other product keeps "Reg." and "/yr".
//
// No trailing phone number: the recipient is the owner of that number —
// echoing it back costs twelve characters and tells them nothing.
//
// Every channel — counter sale, Assign Policy, website checkout, partner
// API, Paynow finalise, both reminder engines — builds its client text
// through these builders so the message is byte-identical no matter who
// captured it or where it came in. Nothing here imports app modules:
// api/ serverless functions consume this file too.

/** Field-to-Floor peril schedule — single source of truth. The printed
 *  policy document (exportUtils) re-exports these rather than keeping a
 *  second copy that could drift from what the SMS quotes. */
export function isTobaccoFieldToFloor(productName: string): boolean {
  const n = productName.toLowerCase()
  // "Field To Field" is the misspelling that keeps reappearing in the
  // product sheet — accept it so a data-entry typo never drops the
  // peril breakdown off a grower's message.
  return n.includes('tobacco') || n.includes('field to floor') || n.includes('field to field')
}

/**
 * Field To Floor peril schedule — keyed by PRODUCT TIER, not sum insured.
 * The product sheet (Oct 2026):
 *   Entry    $60/yr   field perils $250
 *   Basic    $65/yr   field perils $250
 *   Standard $105/yr  field perils $500
 *   Comfort  $165/yr  field perils $750
 *   Premium  $210/yr  field perils $1,000
 *   Funeral benefit is a flat $500 at every tier (grower's own cover,
 *   not scaled with the crop).
 *
 * Tier comes from the product name; the annual premium is the
 * tie-breaker when the name carries no tier word (mid-point bands
 * between the listed prices), and an unrecognised F2F product falls
 * back to the Standard schedule — the flagship tier.
 */
function fieldToFloorPerilBenefit(productName: string, premium?: number): number {
  const n = productName.toLowerCase()
  if (n.includes('premium')) return 1000
  if (n.includes('comfort')) return 750
  if (n.includes('standard')) return 500
  if (n.includes('entry') || n.includes('basic')) return 250
  if (premium != null && premium > 0) {
    if (premium <= 85) return 250    // Entry $60 / Basic $65
    if (premium <= 135) return 500   // Standard $105
    if (premium <= 187.5) return 750 // Comfort $165
    return 1000                      // Premium $210
  }
  return 500
}

export function fieldToFloorCover(productName: string, premium?: number): Array<{ peril: string; benefit: number }> {
  const b = fieldToFloorPerilBenefit(productName, premium)
  return [
    { peril: 'Barn Fire',  benefit: b },
    { peril: 'Hail Storm', benefit: b },
    { peril: 'Wind Storm', benefit: b },
    { peril: 'Funeral',    benefit: 500 },
  ]
}

/** One line for SMS/WhatsApp: "Barn Fire $500, Hail Storm $500, …" */
export function fieldToFloorCoverLine(productName: string, premium?: number): string {
  return fieldToFloorCover(productName, premium).map(c => `${c.peril} $${c.benefit}`).join(', ')
}

/** "$105" / "$12.50" — whole amounts never carry ".00" (segment space is
 *  precious), odd cents still show. */
function smsMoney(amount: number): string {
  const n = Number(amount || 0)
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`
}

/** Digits-only rendering of a number ("263773909307"). Used where the
 *  number identifies someone OTHER than the recipient — e.g. the group
 *  contact's line on the org's registration alert. Client texts never
 *  carry the recipient's own number back at them. */
function smsPhone(raw: string | null | undefined): string {
  return normalizeZwMobile(raw ?? '') ?? String(raw ?? '').replace(/\D/g, '')
}

const SMS_MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
/** House date format DD-MON-YYYY — same as src/lib/dateUtils.formatDate,
 *  restated so this file stays import-free (api/ functions read it too). */
export function smsDate(d: Date): string {
  return `${String(d.getDate()).padStart(2, '0')}-${SMS_MONTHS[d.getMonth()]}-${d.getFullYear()}`
}

/**
 * The standard office lines — the ONE copy in the whole system.
 *
 * Every notification path resolves its recipients from Settings → SMS
 * Recipients (app_settings.notif_settings.smsRecipients). This constant is
 * only ever the SEED: what Settings shows before an admin has saved
 * anything, and the last-resort fallback when no saved list exists at
 * all. Once the Settings row is saved, it is the assignment and this list
 * is never consulted — a removed number stops being texted everywhere.
 *
 * Lives here because this is the single file both the app bundle and the
 * api/ serverless functions can import — two copies used to exist (one
 * per pipeline) and they could drift apart.
 */
export const DEFAULT_OFFICE_SMS = ['+263780086175', '+263780086176', '+263780086177', '+263780086178']

export interface PolicyNoticeInput {
  clientName: string
  policyNumber: string
  productName: string
  productCategory?: string
  coverAmount: number
  premium: number
  paymentMethod?: string | null
  clientPhone?: string | null
}

/** The whole cover clause — "Cover: Barn Fire $250, …" for Field To
 *  Floor, "Cover $5,000" for everything else. Shared between the
 *  builder and every registration-template call site so a {coverClause}
 *  placeholder and the fallback text can never drift apart. */
export function policyCoverClause(productName: string, coverAmount: number, premium: number): string {
  return isTobaccoFieldToFloor(productName)
    ? `Cover: ${fieldToFloorCoverLine(productName, premium)}`
    : `Cover ${smsMoney(coverAmount)}`
}

/** THE policy-registered text — the approved standard, verbatim shape. */
export function policyRegisteredSms(p: PolicyNoticeInput): string {
  const fieldToFloor = isTobaccoFieldToFloor(p.productName)
  const cover = policyCoverClause(p.productName, p.coverAmount, p.premium)
  const method = (p.paymentMethod ?? '').trim()
  // Every premium is quoted annual — the figure on the product is the
  // whole year's cover however it is collected (stop order, EcoCash,
  // cash). "/mo" was misquoting the same figure as a monthly price.
  if (fieldToFloor) {
    // Tobacco wording per the approved example: no "Reg.", no phone,
    // no "/yr", and NO closing period — the text ends on the premium:
    // "… Funeral $500. Stop Order $60"
    return `${p.clientName} ${p.policyNumber}. ${p.productName}. ${cover}. ${method ? `${method} ` : ''}${smsMoney(p.premium)}`
  }
  const period = '/yr'
  // No 'Reg.' verb on any product — the policy number already says this
  // is a registration.
  return `${p.clientName} ${p.policyNumber}. ${p.productName}. ${cover}. ${method ? `${method} ` : ''}${smsMoney(p.premium)}${period}.`
}

/** A client row exists but no policy yet — never imply cover. */
export function clientRegisteredSms(clientName: string, _clientPhone?: string | null): string {
  return `${clientName}. No policy yet. Agent will contact you.`
}

/** An organisation registered for group cover. */
export function groupRegisteredSms(groupName: string, kind: string, contactName?: string | null, contactPhone?: string | null): string {
  const phone = smsPhone(contactPhone)
  return `${groupName} ${kind} cover. ${contactName || 'N/A'}${phone ? ` ${phone}` : ''}`
}

export interface PaymentNoticeInput {
  clientName: string
  policyNumber?: string | null
  amount: number
  method?: string | null
  reference?: string | null
  clientPhone?: string | null
}

/** Money confirmed in hand. */
export function paymentReceivedSms(p: PaymentNoticeInput): string {
  const method = (p.method ?? '').trim()
  const ref = (p.reference ?? '').trim()
  const pol = (p.policyNumber ?? '').trim()
  return `${p.clientName}${pol ? ` ${pol}` : ''} paid. ${smsMoney(p.amount)}${method ? ` via ${method}` : ''}.${ref ? ` Ref ${ref}.` : ''}`
}

/** A payment attempt that collected nothing. */
export function paymentFailedSms(p: PaymentNoticeInput): string {
  const method = (p.method ?? '').trim()
  const pol = (p.policyNumber ?? '').trim()
  return `${p.clientName}${pol ? ` ${pol}` : ''} payment failed. ${smsMoney(p.amount)}${method ? ` via ${method}` : ''}. Try again.`
}

/** Monthly premium reminder (R1/R2/R3 — same text at every stage). */
export function premiumReminderSms(p: { clientName: string; policyNumber: string; amount: number; dueDate: Date; clientPhone?: string | null }): string {
  return `${p.clientName} ${p.policyNumber} premium ${smsMoney(p.amount)} due ${smsDate(p.dueDate)}. Pay to keep cover.`
}

/** The grace window closed unpaid — cover suspended until reinstated. */
export function policyLapsedSms(p: { clientName: string; policyNumber: string; amount: number; dueDate: Date; clientPhone?: string | null }): string {
  return `${p.clientName} ${p.policyNumber} LAPSED. ${smsMoney(p.amount)} due ${smsDate(p.dueDate)} unpaid. Pay to reinstate.`
}

/** A monthly group-cover invoice exists — billed to the organisation. */
export function invoiceIssuedSms(p: { orgName: string; policyNumber: string; invoiceNumber: string; amount: number; heads: number; period: string; dueDate: Date; clientPhone?: string | null }): string {
  return `${p.orgName} ${p.policyNumber} invoice ${p.invoiceNumber} issued. ${smsMoney(p.amount)} for ${p.heads} member(s), period ${p.period}, due ${smsDate(p.dueDate)}.`
}

/** The same grammar for events with no cover/premium to quote — a claim
 *  or ticket stage. `{name} {ref} {event}. {detail}.` */
export function noticeSms(clientName: string, ref: string, event: string, detail?: string, _clientPhone?: string | null): string {
  const d = detail?.trim().replace(/\.+$/, '')
  return `${clientName} ${ref} ${event}.${d ? ` ${d}.` : ''}`
}
