/**
 * Policy start/end dates for server-side creation paths (website apply,
 * WhatsApp bot, partner API). Mirrors src/lib/exportUtils.ts — Tobacco
 * "Field to Floor" cover runs with the fixed tobacco season, not the day
 * the policy was keyed in, so every channel must store the same window the
 * policy document prints.
 */
export const TOBACCO_SEASON = { start: '2026-11-15', end: '2027-08-31' } as const

export function isTobaccoProduct(product: { name?: string; category?: string }): boolean {
  const n = (product.name ?? '').toLowerCase()
  return product.category === 'agriculture' && (n.includes('tobacco') || n.includes('field to floor'))
}

/** Season window for tobacco; today + 1 year for everything else. */
export function policyTermDates(product: { name?: string; category?: string }): { start: string; end: string } {
  if (isTobaccoProduct(product)) return { start: TOBACCO_SEASON.start, end: TOBACCO_SEASON.end }
  const start = new Date().toISOString().slice(0, 10)
  const end = new Date(Date.now() + 365 * 864e5).toISOString().slice(0, 10)
  return { start, end }
}
