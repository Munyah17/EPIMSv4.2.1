import { supabase } from './supabase'

/** Public site checkout — where field agents send people to buy cover. */
export const AGENT_REFERRAL_SITE = 'https://motions.co.zw/apply'

export function agentReferralLink(code: string | null | undefined): string {
  return code ? `${AGENT_REFERRAL_SITE}?agent=${encodeURIComponent(code)}` : ''
}

export async function copyAgentReferralLink(code: string | null | undefined): Promise<boolean> {
  const link = agentReferralLink(code)
  if (!link) return false
  try {
    await navigator.clipboard.writeText(link)
    return true
  } catch {
    window.prompt('Copy the field-agent referral link:', link)
    return true
  }
}

export interface AgentReferralDelivery {
  channel: string
  recipient: string
  status: 'sent' | 'failed' | 'queued' | 'skipped'
  detail?: string
}

export interface AgentReferralRegisterEntry {
  profileId: string
  name: string
  email: string | null
  phone: string | null
  active: boolean
  territory: string | null
  referralCode: string
  referralLink: string
}

/** Super Admin-only action: backfill all links, email the complete register
 *  to the company recipients, and text each active agent their own link. */
export async function distributeAgentReferralLinks(): Promise<{
  agents: AgentReferralRegisterEntry[]
  deliveries: AgentReferralDelivery[]
  warnings: string[]
  error: string | null
}> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return { agents: [], deliveries: [], warnings: [], error: 'Not signed in.' }
  try {
    const res = await fetch('/api/agent-referrals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ action: 'distribute', notifyAgents: true }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      return { agents: [], deliveries: [], warnings: [], error: body?.error ?? `Referral distribution failed (HTTP ${res.status}).` }
    }
    return {
      agents: body.agents ?? [],
      deliveries: body.deliveries ?? [],
      warnings: body.warnings ?? [],
      error: null,
    }
  } catch (e) {
    return { agents: [], deliveries: [], warnings: [], error: `Could not reach the referral service: ${e}` }
  }
}
