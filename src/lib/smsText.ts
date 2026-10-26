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
 * ONE message, always. Splitting into "(1/2) …" "(2/2) …" was worse than
 * the problem — staff got fragments they couldn't act on and clients got
 * texts that read broken. A long text is sent whole: the gateway and the
 * handset handle concatenation on their side, and the recipient sees a
 * single message. (toGsm still strips characters Econet silently drops.)
 */
export function smsParts(raw: string): string[] {
  const text = toGsm(raw)
  return text ? [text] : []
}

/** Office-copy envelope label: 'registration' is the one long event name
 *  — 'REG:' says the same thing without eating ten characters of the
 *  message. Everything else is already short and goes out uppercase. */
export function smsEventLabel(event: string): string {
  return event === 'registration' ? 'REG' : event.toUpperCase()
}

// ── The ONE client-facing message shape ─────────────────────────────
//
// Approved standard (verbatim example, variables swapped per record):
//
//   Demo User TOB0514 Reg. Field To Floor Standard. Cover: Barn Fire
//   $500, Hail Storm $500, Wind Storm $500, Funeral $500. Stop Order
//   $105/yr. 263773909307
//
// Grammar: {clientName} {policyNumber} {event}. {details}. {method}
// {premium}/{period}. {phoneDigits}
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
  return n.includes('tobacco') || n.includes('field to floor')
}

export function fieldToFloorCover(sumInsured: number): Array<{ peril: string; benefit: number }> {
  const high = sumInsured >= 2000
  return [
    { peril: 'Barn Fire',  benefit: high ? 500 : 250 },
    { peril: 'Hail Storm', benefit: high ? 500 : 250 },
    { peril: 'Wind Storm', benefit: high ? 500 : 250 },
    { peril: 'Funeral',    benefit: 500 },
  ]
}

/** One line for SMS/WhatsApp: "Barn Fire $500, Hail Storm $500, …" */
export function fieldToFloorCoverLine(sumInsured: number): string {
  return fieldToFloorCover(sumInsured).map(c => `${c.peril} $${c.benefit}`).join(', ')
}

/** "$105" / "$12.50" — whole amounts never carry ".00" (segment space is
 *  precious), odd cents still show. */
function smsMoney(amount: number): string {
  const n = Number(amount || 0)
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`
}

/** Client's number as bare digits ("263773909307") — the tail of every
 *  standard message, matching the approved example. */
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

/** THE policy-registered text — the approved standard, verbatim shape. */
export function policyRegisteredSms(p: PolicyNoticeInput): string {
  // The product name already says "Field To Floor" — the cover label
  // doesn't repeat it.
  const cover = isTobaccoFieldToFloor(p.productName)
    ? `Cover: ${fieldToFloorCoverLine(p.coverAmount)}`
    : `Cover ${smsMoney(p.coverAmount)}`
  const period = p.productCategory === 'agriculture' ? '/yr' : '/mo'
  const method = (p.paymentMethod ?? '').trim()
  const phone = smsPhone(p.clientPhone)
  return `${p.clientName} ${p.policyNumber} Reg. ${p.productName}. ${cover}. ${method ? `${method} ` : ''}${smsMoney(p.premium)}${period}.${phone ? ` ${phone}` : ''}`
}

/** A client row exists but no policy yet — "reg.", never "covered". */
export function clientRegisteredSms(clientName: string, clientPhone?: string | null): string {
  const phone = smsPhone(clientPhone)
  return `${clientName} reg. No policy yet. Agent will contact you.${phone ? ` ${phone}` : ''}`
}

/** An organisation registered for group cover. */
export function groupRegisteredSms(groupName: string, kind: string, contactName?: string | null, contactPhone?: string | null): string {
  const phone = smsPhone(contactPhone)
  return `${groupName} reg. ${kind} cover. ${contactName || 'N/A'}${phone ? ` ${phone}` : ''}`
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
  const phone = smsPhone(p.clientPhone)
  const pol = (p.policyNumber ?? '').trim()
  return `${p.clientName}${pol ? ` ${pol}` : ''} paid. ${smsMoney(p.amount)}${method ? ` via ${method}` : ''}.${ref ? ` Ref ${ref}.` : ''}${phone ? ` ${phone}` : ''}`
}

/** A payment attempt that collected nothing. */
export function paymentFailedSms(p: PaymentNoticeInput): string {
  const method = (p.method ?? '').trim()
  const phone = smsPhone(p.clientPhone)
  const pol = (p.policyNumber ?? '').trim()
  return `${p.clientName}${pol ? ` ${pol}` : ''} payment failed. ${smsMoney(p.amount)}${method ? ` via ${method}` : ''}. Try again.${phone ? ` ${phone}` : ''}`
}

/** Monthly premium reminder (R1/R2/R3 — same text at every stage). */
export function premiumReminderSms(p: { clientName: string; policyNumber: string; amount: number; dueDate: Date; clientPhone?: string | null }): string {
  const phone = smsPhone(p.clientPhone)
  return `${p.clientName} ${p.policyNumber} premium ${smsMoney(p.amount)} due ${smsDate(p.dueDate)}. Pay to keep cover.${phone ? ` ${phone}` : ''}`
}

/** The grace window closed unpaid — cover suspended until reinstated. */
export function policyLapsedSms(p: { clientName: string; policyNumber: string; amount: number; dueDate: Date; clientPhone?: string | null }): string {
  const phone = smsPhone(p.clientPhone)
  return `${p.clientName} ${p.policyNumber} LAPSED. ${smsMoney(p.amount)} due ${smsDate(p.dueDate)} unpaid. Pay to reinstate.${phone ? ` ${phone}` : ''}`
}

/** A monthly group-cover invoice exists — billed to the organisation. */
export function invoiceIssuedSms(p: { orgName: string; policyNumber: string; invoiceNumber: string; amount: number; heads: number; period: string; dueDate: Date; clientPhone?: string | null }): string {
  const phone = smsPhone(p.clientPhone)
  return `${p.orgName} ${p.policyNumber} invoice ${p.invoiceNumber} issued. ${smsMoney(p.amount)} for ${p.heads} member(s), period ${p.period}, due ${smsDate(p.dueDate)}.${phone ? ` ${phone}` : ''}`
}

/** The same grammar for events with no cover/premium to quote — a claim
 *  or ticket stage. `{name} {ref} {event}. {detail}. {phone}` */
export function noticeSms(clientName: string, ref: string, event: string, detail?: string, clientPhone?: string | null): string {
  const phone = smsPhone(clientPhone)
  const d = detail?.trim().replace(/\.+$/, '')
  return `${clientName} ${ref} ${event}.${d ? ` ${d}.` : ''}${phone ? ` ${phone}` : ''}`
}
