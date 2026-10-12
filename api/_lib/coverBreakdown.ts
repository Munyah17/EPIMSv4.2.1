/**
 * Server-side mirror of the Field-to-Floor peril breakdown in
 * src/lib/exportUtils.ts — the two must stay identical: the same figures
 * go out on the policy PDF, the client SMS, the WhatsApp bot, and the
 * emailed welcome. A grower reading "Barn Fire $500" on the document
 * reads the same numbers on their phone.
 *
 * Perils are itemised per sum insured: a $2,000 policy pays $500 on each
 * field peril plus a flat $500 funeral benefit (the grower's own funeral
 * cover, not scaled with the crop); a $1,000 policy pays $250 per field
 * peril with the funeral benefit still $500.
 */

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

/** What a message should quote as "cover": the peril breakdown for a
 *  Field-to-Floor product ("cover: Barn Fire $500, Hail Storm $500, …"),
 *  the bare sum insured for anything else ("cover $2,000"). A tobacco
 *  policy is never announced as a single round figure — nobody's barn
 *  is insured for $2,000 when the peril that burns it pays $500. */
export function coverLabel(productName: string, coverAmount: number): string {
  return isTobaccoFieldToFloor(productName)
    ? `cover: ${fieldToFloorCoverLine(coverAmount)}`
    : `cover $${coverAmount.toLocaleString()}`
}
