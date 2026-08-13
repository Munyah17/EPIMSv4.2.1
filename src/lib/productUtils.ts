/** Agriculture products are billed once per year (Stop Order), not
 *  monthly like every other category — anywhere a premium is shown next to
 *  its billing period, use these instead of a hardcoded "/mo". */
export function premiumPeriodLabel(category: string): '/yr' | '/mo' {
  return category === 'agriculture' ? '/yr' : '/mo'
}

export function formatPremium(premium: number, category: string): string {
  return `$${premium.toFixed(2)}${premiumPeriodLabel(category)}`
}
