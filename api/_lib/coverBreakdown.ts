/**
 * Server-side mirror of the Field-to-Floor peril breakdown in
 * src/lib/smsText.ts — the two must stay identical: the same figures
 * go out on the policy PDF, the client SMS, the WhatsApp bot, and the
 * emailed welcome. A grower reading "Barn Fire $500" on the document
 * reads the same numbers on their phone.
 *
 * Perils are itemised per PRODUCT TIER (Oct 2026 product sheet):
 *   Entry $60 / Basic $65     → field perils $250
 *   Standard $105             → field perils $500
 *   Comfort $165              → field perils $750
 *   Premium $210              → field perils $1,000
 *   Funeral benefit is a flat $500 at every tier (the grower's own
 *   funeral cover, not scaled with the crop).
 */

export function isTobaccoFieldToFloor(productName: string): boolean {
  const n = productName.toLowerCase()
  // "Field To Field" is the misspelling that keeps reappearing — accept
  // it so a data-entry typo never drops the peril breakdown.
  return n.includes('tobacco') || n.includes('field to floor') || n.includes('field to field')
}

function fieldToFloorPerilBenefit(productName: string, premium?: number): number {
  const n = productName.toLowerCase()
  if (n.includes('premium')) return 1000
  if (n.includes('comfort')) return 750
  if (n.includes('standard')) return 500
  if (n.includes('entry') || n.includes('basic')) return 250
  if (premium != null && premium > 0) {
    if (premium <= 85) return 250
    if (premium <= 135) return 500
    if (premium <= 187.5) return 750
    return 1000
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

/** What a message should quote as "cover": the peril breakdown for a
 *  Field-to-Floor product ("cover: Barn Fire $500, Hail Storm $500, …"),
 *  the bare sum insured for anything else ("cover $2,000"). A tobacco
 *  policy is never announced as a single round figure — nobody's barn
 *  is insured for $2,000 when the peril that burns it pays $500. */
export function coverLabel(productName: string, coverAmount: number, premium?: number): string {
  return isTobaccoFieldToFloor(productName)
    ? `cover: ${fieldToFloorCoverLine(productName, premium)}`
    : `cover $${coverAmount.toLocaleString()}`
}
