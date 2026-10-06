/**
 * Where a policy was bought/issued — the channel it entered the book
 * through. Stored as a short slug in policies.source, displayed through
 * the labels below. Adding a channel later (a new platform integration)
 * means adding a line here, nothing more.
 */
export const POLICY_SOURCES: { value: string; label: string }[] = [
  // Staff logged into the IMS issuing a policy for a client at the desk.
  { value: 'web_app', label: 'TariqifyIMS (Web App)' },
  { value: 'motions_website', label: 'Motions Website' },
  { value: 'whatsapp_chatbot', label: 'WhatsApp Chatbot' },
  { value: 'ussd', label: 'USSD' },
  { value: 'api_partner', label: 'API Partner' },
]

export const DEFAULT_POLICY_SOURCE = 'web_app'

/** Display label for a stored slug; unknown/new slugs show as typed. */
export function policySourceLabel(source?: string | null): string {
  if (!source) return '—'
  return POLICY_SOURCES.find(s => s.value === source)?.label ?? source
}
