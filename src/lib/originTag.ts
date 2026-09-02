/**
 * The tag that opens every payment reference this app creates.
 *
 * Several applications collect through the same Paynow account, so a
 * reference on Paynow's side or on a bank statement has to say which one
 * started the transaction. Reconciliation reads this prefix.
 *
 * Keep it short, uppercase and free of separators that a gateway might
 * normalise away; the dash after it is the only separator.
 */
export const ORIGIN_TAG = 'MIMS'

/** Prefixes a reference with the origin tag, once. */
export function taggedReference(reference: string): string {
  return reference.startsWith(`${ORIGIN_TAG}-`) ? reference : `${ORIGIN_TAG}-${reference}`
}
