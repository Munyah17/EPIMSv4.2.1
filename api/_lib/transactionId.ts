/**
 * Server-side copy of src/lib/transactionId.ts — transaction IDs for
 * payments with no gateway reference (cash, manual rails, API partners).
 *
 *   {payer initials}-{method abbreviation}{DDMMYYYY}{HHmm}
 *   LAM-CSH081020261649 = L. Andres Messi, Cash, 08/10/2026 16:49.
 */

const METHOD_ABBREVIATIONS: Record<string, string> = {
  cash: 'CSH',
  ecocash: 'ECH',
  'ecocash instant': 'ECH',
  onemoney: 'OMN',
  innbucks: 'INB',
  'bank transfer': 'BTR',
  'debit order': 'DBO',
  'stop order': 'STO',
  paynow: 'PNW',
  zipit: 'ZPT',
  'split payment': 'SPL',
}

function nameInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'XX'
  if (parts.length > 3) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  return parts.map(p => p[0]).join('').toUpperCase()
}

function methodAbbreviation(method: string): string {
  const key = method.trim().toLowerCase()
  if (METHOD_ABBREVIATIONS[key]) return METHOD_ABBREVIATIONS[key]
  const words = method.trim().split(/[\s_-]+|(?<=[a-z])(?=[A-Z])/).filter(Boolean)
  if (words.length > 1) return words.map(w => w[0]).join('').toUpperCase().slice(0, 4)
  const word = (words[0] ?? 'X').toUpperCase()
  const consonants = word.slice(1).replace(/[AEIOU]/g, '')
  return (word[0] + consonants.slice(0, 2)).padEnd(3, 'X')
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

export function generateTransactionId(opts: { clientName: string; method: string; at?: Date }): string {
  const at = opts.at ?? new Date()
  const ddmmyyyy = `${pad2(at.getDate())}${pad2(at.getMonth() + 1)}${at.getFullYear()}`
  const hhmm = `${pad2(at.getHours())}${pad2(at.getMinutes())}`
  return `${nameInitials(opts.clientName)}-${methodAbbreviation(opts.method)}${ddmmyyyy}${hhmm}`
}
