/**
 * Zimbabwean identity formats — one rule at every point a person is
 * captured, matched by the server-side checks in api/_lib/zwFormats.ts.
 *
 * National ID: 8 or 9 digits, one check letter, then 2 digits — the
 * card prints "63-1234567-A-89", the record keeps "631234567A89".
 * Anything else (spaces, dashes, slashes, a different shape) is
 * rejected and the field is highlighted.
 *
 * Phone: "+263" followed by exactly 9 digits, or 10 digits starting
 * with 0 — "+263773909307" and "0773909307" are the only two shapes.
 */

export const NATIONAL_ID_HINT = '8 or 9 digits, a letter, then 2 digits — e.g. 632118532K12 (no spaces, dashes or slashes)'
export const PHONE_HINT = '+263 followed by 9 digits (e.g. +263773909307), or 10 digits starting with 0 (e.g. 0773909307)'

/** Canonical form — separators and case stripped, the same
 *  normalisation the API applies before storing: two presentations of
 *  the same ID must deduplicate to one person. */
export function normalizeNationalId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
}

/** Live input cleaner — the field produces the canonical form as it is
 *  typed, so a pasted "63-1234567-A-89" lands as "631234567A89". */
export const cleanNationalIdInput = normalizeNationalId

export function isNationalId(raw: string): boolean {
  return /^\d{8,9}[A-Z]\d{2}$/.test(normalizeNationalId(raw))
}

export function isZwPhone(raw: string): boolean {
  const s = raw.trim().replace(/[\s-]+/g, '')
  return /^\+263\d{9}$/.test(s) || /^0\d{9}$/.test(s)
}
