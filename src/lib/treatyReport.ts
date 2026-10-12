import type { Policy, Client } from '../types'

/**
 * Policy (treaty/cession) report — the column layout of the reinsurer's
 * "Report Template.xlsx". One row per INSURED HEAD: the holder as
 * PRINCIPAL MEMBER, each dependant as their own DEPENDENT row, since
 * cover and premium are priced per head.
 *
 * Formatting rules (fixed — a treaty file is compared across months):
 *   - dates:      d-MMM-yyyy   ("7-Dec-2026")
 *   - national ID: upper-case, no spaces/dashes
 *   - designation: PRINCIPAL MEMBER | DEPENDENT <RELATIONSHIP>
 *   - money:      numeric cells, 2 decimals
 *   - retention:  RETENTION_SHARE retained / the rest ceded
 */

/** Treaty retention — 40% of each risk stays on our book, the rest is
 *  ceded. When the treaty terms move, this becomes a setting. */
export const RETENTION_SHARE = 0.4

export const TREATY_HEADERS = [
  'NAME', 'Surname', 'DOB', 'ID', 'GENDER', 'POLICY', 'POLICY NUMBER',
  'DESIGNATION', 'COMMENCE DATE', 'PERIOD (in months)',
  'SUM ASSURED', 'MONTHLY PREMIUM', 'TOTAL PREMIUM',
  'RETAINED SUM ASSURED', 'RETAINED PREMIUM', 'SUM REASSURED', 'REASS PREMIUM',
]

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Every date on the export, one format — "7-Dec-2026". Blank stays
 *  blank; a value we can't parse goes out untouched rather than as
 *  "NaN-undefined-NaN". */
export function reportDate(iso: string | undefined | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return `${d.getDate()}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`
}

/** National ID — one canonical shape: upper-case, no spaces or dashes. */
function canonicalId(id: string | undefined | null): string {
  return (id ?? '').toUpperCase().replace(/[\s-]/g, '')
}

function money(n: number): number {
  return Math.round(n * 100) / 100
}

/** surname = last word, NAME = everything before it — matches the
 *  template's two-column split. */
function splitName(full: string): { name: string; surname: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean)
  if (parts.length <= 1) return { name: parts[0] ?? '', surname: '' }
  return { name: parts.slice(0, -1).join(' '), surname: parts[parts.length - 1] }
}

/** Relationship label normalized to the template vocabulary —
 *  "DEPENDENT SPOUSE", "DEPENDENT FATHER", "DEPENDENT" when unknown. */
function designation(rel: string | undefined | null): string {
  const r = (rel ?? '').trim()
  if (!r) return 'DEPENDENT'
  return `DEPENDENT ${r.toUpperCase()}`
}

/** One row: a person, their designation, cover and premium share. */
function row(
  person: { name: string; nationalId?: string; dob?: string; gender?: string },
  desig: string, policy: Policy, premium: number, assured: number,
): (string | number)[] {
  const { name, surname } = splitName(person.name)
  const retainedA = assured * RETENTION_SHARE
  const retainedP = premium * RETENTION_SHARE
  return [
    name, surname, reportDate(person.dob), canonicalId(person.nationalId),
    person.gender ?? '',
    policy.productName, policy.policyNumber, desig,
    reportDate(policy.startDate), 1,
    money(assured), money(premium), money(premium * 1),
    money(retainedA), money(retainedP),
    money(assured - retainedA), money(premium - retainedP),
  ]
}

/** The whole book, or whatever filtered set the caller passes. The
 *  holder's ID/DOB/gender live on the client row, so callers pass a
 *  clientId→Client lookup; a holder whose client isn't loaded still
 *  exports — identity columns just come out blank. */
export function treatyRows(policies: Policy[], clientsById: Map<string, Client>): (string | number)[][] {
  const rows: (string | number)[][] = []
  for (const p of policies) {
    const c = clientsById.get(p.clientId)
    rows.push(row(
      { name: p.clientName, nationalId: c?.nationalId, dob: c?.dob, gender: c?.gender },
      'PRINCIPAL MEMBER', p, p.premium, p.coverAmount,
    ))
    for (const d of p.dependants ?? []) {
      rows.push(row(
        { name: d.name, nationalId: d.nationalId, dob: d.dob, gender: d.gender },
        designation(d.relationship), p,
        d.premium ?? p.premium, d.coverAmount ?? p.coverAmount,
      ))
    }
  }
  return rows
}
