import type { Client, Policy, PolicyStatus } from '../types'

/**
 * Snake_case Supabase rows -> the app's camelCase shapes.
 *
 * Deliberately import-free at runtime (like smsText.ts / smsTemplates.ts):
 * api/ serverless functions consume this file too — regenerate-policy-
 * documents.ts needs the same row mapping the browser's db.ts applies,
 * or a regenerated document reads `policy.productName` off a raw
 * `product_name` column and prints blanks. One module, one mapping.
 *
 * Every relative import here (and in anything this file pulls in) must
 * carry a .js extension — api/ functions run as transpiled ESM where
 * Node resolves literally.
 */

export function date(v: string | null | undefined): string { return v?.split('T')[0] ?? '' }

export function toClient(r: Record<string, unknown>): Client {
  return {
    id:          r.id as string,
    name:        r.name as string,
    email:       (r.email as string) ?? '',
    phone:       r.phone as string,
    nationalId:  r.national_id as string,
    dob:         date(r.dob as string),
    gender:      (r.gender as string | null) ?? undefined,
    address:     (r.address as string) ?? '',
    occupation:  r.occupation as string | undefined,
    insurer:     (r.insurer as Client['insurer']) ?? undefined,
    insurerProvisional: (r.insurer_provisional as boolean) ?? false,
    agentId:     (r.agent_id as string | null) ?? undefined,
    agentName:   (r.agent as { name?: string } | null)?.name ?? undefined,
    capturedById:   ((r.capturer as { id?: string } | null)?.id ?? r.captured_by) as string | undefined,
    capturedByName: (r.capturer as { name?: string } | null)?.name ?? undefined,
    createdAt:   date(r.created_at as string),
    policyCount: (r.policy_count as number) ?? 0,
    status:      r.status as Client['status'],
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toPolicy(r: any): Policy {
  return {
    id:              r.id,
    policyNumber:    r.policy_number,
    clientId:        r.clients?.id ?? r.client_id ?? '',
    clientName:      r.clients?.name ?? '',
    productId:       r.products?.id ?? r.product_id ?? '',
    productName:     r.products?.name ?? '',
    productCategory: r.products?.category ?? undefined,
    excess:          r.products?.excess ?? undefined,
    premium:         r.premium,
    coverAmount:     r.cover_amount,
    startDate:       date(r.start_date),
    endDate:         date(r.end_date),
    status:          r.status as PolicyStatus,
    dependants:      r.dependants ?? [],
    paymentMethod:   r.payment_method,
    insurer:         r.insurer ?? undefined,
    growerNumber:    r.grower_number ?? undefined,
    gpsLat:          r.gps_lat ?? undefined,
    gpsLng:          r.gps_lng ?? undefined,
    agentId:         r.profiles?.id ?? r.agent_id,
    agentName:       r.profiles?.name,
    // The staff member who captured the policy — a different person from
    // the agent/field officer who sourced the business.
    capturedById:    r.capturer?.id ?? r.captured_by ?? undefined,
    capturedByName:  r.capturer?.name ?? undefined,
    groupId:         r.groups?.id ?? r.group_id ?? undefined,
    groupName:       r.groups?.name ?? undefined,
    coverScope:      (r.cover_scope as Policy['coverScope']) ?? 'individual',
    teamActivity:    r.team_activity ?? undefined,
    hasChronicIllness: r.has_chronic_illness ?? undefined,
    chronicIllnessDetails: r.chronic_illness_details ?? undefined,
    contractor:      r.contractor ?? undefined,
    hectarage:       r.hectarage != null ? Number(r.hectarage) : undefined,
    source:          r.source ?? undefined,
    createdAt:       date(r.created_at),
    nextPaymentDate: r.next_payment_date ? date(r.next_payment_date) : undefined,
    lastPaymentDate: r.last_payment_date ? date(r.last_payment_date) : undefined,
  }
}
