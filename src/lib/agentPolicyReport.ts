import { formatDate } from './dateUtils'
import { isNationalId, normalizeNationalId } from './validation'

export interface AgentBookClient {
  id: string
  name: string
  nationalId: string
  dob: string
  phone: string
  address: string
  createdAt: string
}

export interface AgentBookPolicy {
  id: string
  clientId: string
  policyNumber: string
  growerNumber: string
  status: string
  startDate: string
  createdAt: string
}

export const AGENT_POLICY_HEADERS = [
  'Name',
  'Surname',
  'Date of Birth',
  'ID No.',
  "Grower's Number",
  'Phone No.',
  'Address',
  'Status',
  'Reg Date',
  'Policy Number',
] as const

export interface AgentPolicyReport {
  headers: string[]
  metadata: [string, string][]
  rows: (string | number)[][]
}

export function normalizeGrowerNumber(raw: string | null | undefined): string {
  const value = String(raw ?? '').trim().replace(/\s+/g, '').toUpperCase()
  return value ? (value.startsWith('V') ? value : `V${value}`) : ''
}

function splitName(name: string): [string, string] {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return [parts[0] ?? '', parts.slice(1).join(' ')]
}

function statusLabel(status: string): string {
  return status.replace(/_/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/** One row per policy; a client with no policy still appears with a
 *  No Policy row so the agent's whole book is not silently shortened.
 *  Bad National IDs stop the export instead of producing a report that
 *  silently certifies unusable identity data. */
export function buildAgentPolicyReport(
  agentName: string,
  clients: AgentBookClient[],
  policies: AgentBookPolicy[],
): { data: AgentPolicyReport | null; error: string | null } {
  const invalid = clients
    .filter(c => !isNationalId(c.nationalId))
    .map(c => `${c.name || c.id} (${c.nationalId.trim() || 'missing'})`)
  if (invalid.length > 0) {
    const shown = invalid.slice(0, 4).join(', ')
    const more = invalid.length > 4 ? ` and ${invalid.length - 4} more` : ''
    return {
      data: null,
      error: `Report not exported — fix the National ID format for ${shown}${more} first.`,
    }
  }

  const policiesByClient = new Map<string, AgentBookPolicy[]>()
  for (const policy of policies) {
    const rows = policiesByClient.get(policy.clientId) ?? []
    rows.push(policy)
    policiesByClient.set(policy.clientId, rows)
  }

  const rows: (string | number)[][] = []
  for (const client of [...clients].sort((a, b) => a.name.localeCompare(b.name))) {
    const [name, surname] = splitName(client.name)
    const clientPolicies = (policiesByClient.get(client.id) ?? [])
      .sort((a, b) => (a.createdAt || a.startDate).localeCompare(b.createdAt || b.startDate) || a.policyNumber.localeCompare(b.policyNumber))
    const identity = [
      name,
      surname,
      formatDate(client.dob),
      normalizeNationalId(client.nationalId),
      '', // filled per policy below
      client.phone,
      client.address,
    ]

    if (clientPolicies.length === 0) {
      rows.push([...identity, 'No Policy', formatDate(client.createdAt), ''])
      continue
    }
    for (const policy of clientPolicies) {
      rows.push([
        ...identity.slice(0, 4),
        normalizeGrowerNumber(policy.growerNumber),
        ...identity.slice(5),
        statusLabel(policy.status),
        formatDate(policy.createdAt || policy.startDate || client.createdAt),
        policy.policyNumber,
      ])
    }
  }

  return {
    data: {
      headers: [...AGENT_POLICY_HEADERS],
      metadata: [
        ['Field Agent', agentName],
        ['Generated', formatDate(new Date())],
      ],
      rows,
    },
    error: null,
  }
}
