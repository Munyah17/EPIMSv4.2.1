import { supabase } from '../supabase'
import { fetchAllRows } from '../paged'
import type { AgentBookClient, AgentBookPolicy } from '../agentPolicyReport'

const CLIENT_REPORT_SELECT = 'id, name, national_id, dob, phone, address, created_at'
const POLICY_REPORT_SELECT = 'id, client_id, policy_number, grower_number, status, start_date, created_at'

/** Rows needed by the personalised Field Agent report — deliberately a
 *  narrow read, not the joined client/policy feeds used by list pages. */
export const agentBook = {
  async report(profileId: string): Promise<{
    data: { clients: AgentBookClient[]; policies: AgentBookPolicy[] } | null
    error: string | null
  }> {
    const [clientsRes, attributedPoliciesRes] = await Promise.all([
      fetchAllRows(() => supabase
        .from('clients')
        .select(CLIENT_REPORT_SELECT)
        .eq('agent_id', profileId)
        .order('name'), { orderBy: 'id' }),
      fetchAllRows(() => supabase
        .from('policies')
        .select(POLICY_REPORT_SELECT)
        .eq('agent_id', profileId)
        .order('created_at', { ascending: false }), { orderBy: 'id' }),
    ])
    if (clientsRes.error || attributedPoliciesRes.error) {
      return {
        data: null,
        error: clientsRes.error?.message ?? attributedPoliciesRes.error?.message ?? 'Could not load the agent book.',
      }
    }

    const clients = new Map<string, AgentBookClient>()
    for (const r of (clientsRes.data ?? []) as Record<string, unknown>[]) {
      clients.set(String(r.id), {
        id: String(r.id),
        name: String(r.name ?? ''),
        nationalId: String(r.national_id ?? ''),
        dob: String(r.dob ?? '').split('T')[0],
        phone: String(r.phone ?? ''),
        address: String(r.address ?? ''),
        createdAt: String(r.created_at ?? '').split('T')[0],
      })
    }

    const policies = new Map<string, AgentBookPolicy>()
    const addPolicy = (r: Record<string, unknown>) => {
      policies.set(String(r.id), {
        id: String(r.id),
        clientId: String(r.client_id ?? ''),
        policyNumber: String(r.policy_number ?? ''),
        growerNumber: String(r.grower_number ?? ''),
        status: String(r.status ?? ''),
        startDate: String(r.start_date ?? '').split('T')[0],
        createdAt: String(r.created_at ?? '').split('T')[0],
      })
    }
    for (const r of (attributedPoliciesRes.data ?? []) as Record<string, unknown>[]) addPolicy(r)

    // An agent owns the client relationship, even when a later policy was
    // attributed to a different agent through an approved exception. Their
    // report therefore carries every policy for clients assigned to them.
    if (clients.size > 0) {
      const clientPoliciesRes = await fetchAllRows(() => supabase
        .from('policies')
        .select(POLICY_REPORT_SELECT)
        .in('client_id', [...clients.keys()])
        .order('created_at', { ascending: false }), { orderBy: 'id' })
      if (clientPoliciesRes.error) return { data: null, error: clientPoliciesRes.error.message }
      for (const r of (clientPoliciesRes.data ?? []) as Record<string, unknown>[]) addPolicy(r)
    }

    // A policy can stay attributed to this agent after its client is
    // reassigned/merged. Pull those holders too so history remains visible.
    const missingClientIds = [...policies.values()]
      .map(p => p.clientId)
      .filter(id => id && !clients.has(id))
    if (missingClientIds.length > 0) {
      const policyClientsRes = await fetchAllRows(() => supabase
        .from('clients')
        .select(CLIENT_REPORT_SELECT)
        .in('id', [...new Set(missingClientIds)])
        .order('name'), { orderBy: 'id' })
      if (policyClientsRes.error) return { data: null, error: policyClientsRes.error.message }
      for (const r of (policyClientsRes.data ?? []) as Record<string, unknown>[]) {
        clients.set(String(r.id), {
          id: String(r.id),
          name: String(r.name ?? ''),
          nationalId: String(r.national_id ?? ''),
          dob: String(r.dob ?? '').split('T')[0],
          phone: String(r.phone ?? ''),
          address: String(r.address ?? ''),
          createdAt: String(r.created_at ?? '').split('T')[0],
        })
      }
    }

    return {
      data: {
        clients: [...clients.values()].sort((a, b) => a.name.localeCompare(b.name)),
        policies: [...policies.values()].sort((a, b) => a.policyNumber.localeCompare(b.policyNumber)),
      },
      error: null,
    }
  },
}
