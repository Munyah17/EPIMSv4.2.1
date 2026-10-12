/**
 * Negotiated group rate cards.
 *
 * Group insurance is negotiated per member — but some groups arrive
 * with an agreed rate card: a fixed schedule of packages the whole
 * roster prices from. For those groups the member form offers a
 * "Package" select that fills the negotiated premium and sum assured;
 * the figures stay editable because a negotiated schedule can still
 * be varied per member.
 *
 * Keyed on the group's name, lower-cased — a card belongs to a real
 * organisation, not a product.
 */

export interface GroupRatePackage {
  label: string
  premium: number
  coverAmount: number
}

const RATE_CARDS: Record<string, GroupRatePackage[]> = {
  // Peaceful Spirits (funeral service provider) — the custom schedule
  // agreed for its roster.
  'peaceful spirits': [
    { label: 'Basic — $1,000', premium: 1.2, coverAmount: 1000 },
    { label: 'Comfort — $2,000', premium: 2.4, coverAmount: 2000 },
    { label: 'Diaspora — $4,000', premium: 9.5, coverAmount: 4000 },
    { label: 'Children below 20 — $500', premium: 0.6, coverAmount: 500 },
    { label: 'Above 70 years (Basic) — $1,000', premium: 2, coverAmount: 1000 },
  ],
}

export function groupRateCard(groupName: string | undefined | null): GroupRatePackage[] | null {
  return RATE_CARDS[(groupName ?? '').trim().toLowerCase()] ?? null
}
