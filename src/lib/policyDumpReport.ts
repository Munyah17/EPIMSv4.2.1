import type { Client, Policy } from '../types'
import { formatDate } from './dateUtils'
import { normalizeGrowerNumber } from './growerNumber'

export const POLICY_DUMP_HEADERS = [
  'Name',
  'Surname',
  'DOB',
  'Grower No.',
  'Phone',
  'Address',
  'Status',
  'Agent Name',
  'Captured By',
  'Reg Date',
  'Policy Count',
  'Policy Number',
] as const

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

function capturedBy(policy: Policy): string {
  if (policy.capturedByName?.trim()) return policy.capturedByName.trim()
  return policy.source === 'motions_website' ? 'Self Signup' : ''
}

/** Operational all-policy dump: one row per policy, while Policy Count
 *  says how many policies that holder carries across the whole book. */
export function policyDumpRows(
  policies: Policy[],
  clientById: Map<string, Client>,
): (string | number)[][] {
  const policyCountByClient = new Map<string, number>()
  for (const policy of policies) {
    policyCountByClient.set(policy.clientId, (policyCountByClient.get(policy.clientId) ?? 0) + 1)
  }

  return policies.map(policy => {
    const client = clientById.get(policy.clientId)
    const [name, surname] = splitName(client?.name || policy.clientName)
    return [
      name,
      surname,
      formatDate(client?.dob),
      normalizeGrowerNumber(policy.growerNumber),
      client?.phone ?? '',
      client?.address ?? '',
      statusLabel(policy.status),
      policy.agentName ?? '',
      capturedBy(policy),
      formatDate(policy.createdAt || policy.startDate),
      policyCountByClient.get(policy.clientId) ?? client?.policyCount ?? 0,
      policy.policyNumber,
    ]
  })
}
