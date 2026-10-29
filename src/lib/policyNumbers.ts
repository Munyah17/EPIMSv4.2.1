import { supabase } from './supabase'
import { fetchAllRows } from './paged'

/**
 * Policy numbers.
 *
 * Every policy number is a short product prefix followed by a running
 * sequence per prefix — FCP0001, HCP0042, TOB0007 — short enough to read
 * over the phone and to write on a claim form. The prefix names the cover,
 * so a policy number alone tells staff what product it belongs to:
 *
 *   FCP  Funeral Cash Plan
 *   HCP  Hospital Cash Plan
 *   MED  Medical Aid
 *   LEG  Legal Insurance
 *   TOB  Tobacco Insurance (Field to Floor)
 *   AGR  other agriculture cover (barn fire, hail, ...)
 *
 * The prefix carries no separator — no hyphen, slash or stroke — and the
 * digits grow as needed (FCP0001 → FCP10000) so numbers stay short for as
 * long as the book stays small.
 *
 * Sequences live in the database (policy_sequences / next_policy_sequence,
 * see database/add_policy_source_and_numbering.sql) so every issuing
 * channel — this app, the website, a chatbot — draws from the same counter.
 */

export interface PolicyNumberProduct {
  name?: string
  code?: string
  category?: string
}

/** Picks the prefix for a product. Name keywords win because they say what
 *  the product actually is; the product code's letters are the fallback for
 *  products the prefixes were never drawn up for, so a new product never
 *  needs a code change here to keep issuing numbers. */
export function policyNumberPrefix(product: PolicyNumberProduct): string {
  const name = (product.name ?? '').toLowerCase()
  if (name.includes('tobacco') || name.includes('field to floor')) return 'TOB'
  if (name.includes('funeral') || name.includes('burial') || name.includes('cash plan') && !name.includes('hospital')) return 'FCP'
  if (name.includes('hospital')) return 'HCP'
  if (name.includes('medical')) return 'MED'
  if (name.includes('legal')) return 'LEG'
  const codeLetters = (product.code ?? '').replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase()
  if (codeLetters.length === 3) return codeLetters
  switch (product.category) {
    case 'funeral': return 'FCP'
    case 'health': return 'MED'
    case 'agriculture': return 'AGR'
    default: return 'POL'
  }
}

/** Formats a sequence value into the printed number: 1 -> "FCP0001". */
export function formatPolicyNumber(prefix: string, sequence: number): string {
  return `${prefix}${String(sequence).padStart(4, '0')}`
}

/**
 * Draws the next policy number for a product.
 *
 * Asks the database for the next sequence value first. If the migration
 * has not been run yet, falls back to the highest number already issued
 * under that prefix — race-prone under simultaneous creation, but only a
 * stopgap until the function exists, and the UNIQUE constraint on
 * policy_number still refuses a collision outright rather than silently
 * issuing a duplicate.
 */
export async function nextPolicyNumber(product: PolicyNumberProduct): Promise<string> {
  const prefix = policyNumberPrefix(product)

  const { data: seq, error: rpcError } = await supabase.rpc('next_policy_sequence', { p_prefix: prefix })
  if (!rpcError && typeof seq === 'number') {
    return formatPolicyNumber(prefix, seq)
  }

  const { data: rows } = await fetchAllRows(
    () => supabase
      .from('policies')
      .select('policy_number')
      .ilike('policy_number', `${prefix}%`),
    { orderBy: 'id' },
  )
  const maxSeq = (rows ?? []).reduce((max: number, r: { policy_number: string }) => {
    const digits = r.policy_number.slice(prefix.length).replace(/\D/g, '')
    const n = Number(digits)
    return Number.isFinite(n) ? Math.max(max, n) : max
  }, 0)
  return formatPolicyNumber(prefix, maxSeq + 1)
}
