/** Every premium is annual — the figure on the product is the whole
 *  year's cover however it is collected (stop order, EcoCash, cash).
 *  Anywhere a premium is shown next to its billing period, use this
 *  instead of a hardcoded "/mo": the label exists so that if a
 *  monthly-priced product is ever added, the period changes in one
 *  place rather than across every screen and message. */
export function premiumPeriodLabel(_category: string, _productName?: string, _paymentMethod?: string | null): '/yr' | '/mo' {
  return '/yr'
}

export function formatPremium(premium: number, category: string, productName?: string, paymentMethod?: string | null): string {
  return `$${premium.toFixed(2)}${premiumPeriodLabel(category, productName, paymentMethod)}`
}

/**
 * Categories that cover named people, and therefore issue membership cards.
 *
 * A card identifies a person at a service desk — the funeral, hospital cash
 * and diaspora combo plans are held by a policyholder and their dependants,
 * and each of those people needs to be identifiable. The rest of the book
 * insures property: agriculture covers a crop and a barn, motor covers a
 * vehicle, property covers a building. There is nobody to hand a card to,
 * and issuing one would imply cover that follows a person when it does not.
 */
const MEMBER_CARD_CATEGORIES = ['funeral', 'life', 'health', 'accident']

export function categoryIssuesMemberCards(category?: string): boolean {
  return !!category && MEMBER_CARD_CATEGORIES.includes(category)
}

/** Tobacco hectarage — the planted area, captured as a SELECT, never
 *  free text: a report has to sum it, and "2ha", "2.0", "two hectares"
 *  don't sum. Stored as the number of hectares on policies.hectarage. */
export const HECTARAGE_OPTIONS = [0.5, 1, 1.5, 2, 2.5, 3] as const

export function hectarageLabel(ha: number): string {
  return `${ha} ha`
}
