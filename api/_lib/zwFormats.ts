/**
 * Zimbabwean identity formats — the single rule every capture path
 * (portal, WhatsApp bot, website bridge, partner API) rejects against.
 * Mirrors src/lib/validation.ts; the two live in separate builds.
 *
 * National ID: 8 or 9 digits, one check letter, then 2 digits —
 * "63-1234567-A-89" as printed is stored as "631234567A89".
 * Phone: "+263" + exactly 9 digits, or 10 digits starting with 0.
 */

/** One stored shape — separators and case stripped, so "63-1234567-a-89"
 *  and "631234567A89" are the same person for dedup and lookups. */
export function normalizeNationalId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
}

export function isZwNationalId(raw: string): boolean {
  return /^\d{8,9}[A-Z]\d{2}$/.test(normalizeNationalId(raw))
}

export function isZwPhone(raw: string): boolean {
  const s = String(raw ?? '').trim().replace(/[\s-]+/g, '')
  return /^\+263\d{9}$/.test(s) || /^0\d{9}$/.test(s)
}
