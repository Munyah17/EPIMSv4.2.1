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

function takeUnits(text: string, maxUnits: number): string {
  let used = 0
  let i = 0
  for (; i < text.length; i++) {
    const w = GSM_EXT.has(text[i]) ? 2 : 1
    if (used + w > maxUnits) break
    used += w
  }
  let cut = i
  const slice = text.slice(0, i)
  const space = slice.lastIndexOf(' ')
  if (space > 20 && space > i - 30) cut = space
  return text.slice(0, cut).trim()
}

/**
 * GSM-7 segments that each stand alone. Concatenated SMS is not reliable
 * on Econet, so a long alert goes out as "(1/2) …" and "(2/2) …" rather
 * than one rejected blob.
 */
export function smsParts(raw: string): string[] {
  const text = toGsm(raw)
  if (!text) return []
  if (gsmUnits(text) <= SMS_GSM_LIMIT) return [text]

  const budget = SMS_GSM_LIMIT - 6
  const chunks: string[] = []
  let rest = text
  while (rest && chunks.length < 6) {
    const chunk = takeUnits(rest, budget)
    if (!chunk) break
    chunks.push(chunk)
    rest = rest.slice(chunk.length).trim()
  }
  if (chunks.length <= 1) return chunks
  return chunks.map((chunk, i) => `(${i + 1}/${chunks.length}) ${chunk}`)
}
