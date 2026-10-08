import { useAuth } from '../contexts/AuthContext'
import type { ActivePanel } from '../App'

interface Props {
  setActivePanel: (panel: ActivePanel) => void
}

type Direction = 'inbound' | 'outbound' | 'keys-issued' | 'core'

interface Integration {
  name: string
  kind: string
  direction: Direction
  /** What actually flows through it. */
  description: string
  /** Where it is managed or referenced — panel id or external console name. */
  managedIn?: { panel: ActivePanel; label: string } | string
  status: string
}

const DIRECTION_LABEL: Record<Direction, string> = {
  'inbound': 'Inbound — they call us',
  'outbound': 'Outbound — we call them',
  'keys-issued': 'Keys issued to partners',
  'core': 'Core infrastructure',
}

const DIRECTION_PILL: Record<Direction, string> = {
  'inbound': 'pill-blue',
  'outbound': 'pill-purple',
  'keys-issued': 'pill-warning',
  'core': 'pill-gray',
}

const INTEGRATIONS: Integration[] = [
  { name: 'Supabase', kind: 'Database, Auth & Realtime', direction: 'core',
    description: 'All records — clients, policies, payments, claims, groups — plus staff logins and row-level security.',
    managedIn: 'supabase.com project console', status: 'Core — always on' },
  { name: 'Vercel', kind: 'Hosting & Serverless API', direction: 'core',
    description: 'Hosts portal.motions.co.zw and every /api/* endpoint — webhooks, provisioning, cron jobs.',
    managedIn: 'vercel.com project console', status: 'Core — always on' },
  { name: 'EcoCash Instant (EIP)', kind: 'Payment gateway', direction: 'outbound',
    description: 'Pushes the USSD charge prompt and verifies the transaction server-side. Merchant credentials in environment secrets.',
    managedIn: { panel: 'settings', label: 'Settings' }, status: 'Active rail' },
  { name: 'Paynow', kind: 'Payment gateway', direction: 'outbound',
    description: 'Hosted checkout for online payments; the website cart and portal Pay Online both run through it.',
    managedIn: { panel: 'settings', label: 'Settings' }, status: 'Active rail' },
  { name: 'Paynow Webhook', kind: 'Webhook', direction: 'inbound',
    description: 'Paynow posts the final transaction status to /api/paynow-webhook — that callback is what marks a payment completed and issues the policy.',
    status: 'Listening on /api/paynow-webhook' },
  { name: 'ZIPIT / Bank Transfer', kind: 'Payment rail (manual)', direction: 'inbound',
    description: 'Reference-based bank transfer rail — the payer uses the issued reference; staff validate the settled transfer.',
    status: 'Manual confirmation rail' },
  { name: 'Afrosoft SMS', kind: 'SMS gateway', direction: 'outbound',
    description: 'Premium reminders, billing notices and bulk messaging go out through the Afrosoft aggregator via /api/gateway-proxy.',
    managedIn: { panel: 'mass_messaging', label: 'Bulk SMS Messaging' }, status: 'Active — proxied' },
  { name: 'Email service', kind: 'Transactional email', direction: 'outbound',
    description: 'Policy documents, receipts and staff notices sent from /api/send-email.',
    managedIn: { panel: 'email', label: 'Email' }, status: 'Active rail' },
  { name: 'WhatsApp', kind: 'Click-to-chat', direction: 'outbound',
    description: 'Website and portal chat hand-offs to the office WhatsApp line — no API session, just deep links.',
    status: 'Deep-link only' },
  { name: 'Groq AI', kind: 'AI service', direction: 'outbound',
    description: 'Lead research and assistant features in Leads & Marketing, served by /api/ai with a server-side key.',
    managedIn: { panel: 'leads', label: 'Leads & Marketing' }, status: 'Active rail' },
  { name: 'Developer API (v1)', kind: 'Partner API', direction: 'keys-issued',
    description: 'External developers sell policies and record payments through /api/v1/* using issued API keys. Keys, permissions and usage are managed on the Developers and API page.',
    managedIn: { panel: 'developer_api', label: 'Developers and API' }, status: 'Accepting partner traffic' },
  { name: 'Cron — Reminder Engine', kind: 'Scheduled job', direction: 'outbound',
    description: 'Hourly /api/cron-reminders run: lifts waiting periods, queues payment reminders, flags lapses.',
    status: 'Scheduled on Vercel Cron' },
  { name: 'Motions Website', kind: 'Public site & checkout', direction: 'inbound',
    description: 'motions.co.zw buys end in a checkout session; once a gateway confirms payment, provisioning writes the client, policy and payment rows here.',
    status: 'Linked — shares this database' },
]

/** Every external connection the platform has — gateways, webhooks,
 *  issued API keys, outbound services — in one place, so a new
 *  integration always has a visible home instead of living only in
 *  someone's memory. */
export default function Integrations({ setActivePanel }: Props) {
  const { canAccess } = useAuth()
  if (!canAccess('integrations')) {
    return <div className="panel"><div className="empty-state">This area is restricted to Administrators.</div></div>
  }

  return (
    <div className="panel">
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-header"><h3 className="card-title">🔗 Connected Systems</h3></div>
        <p style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 12px' }}>
          Every integration the platform holds — payment gateways, webhooks, SMS/email rails, issued API keys and partner systems.
        </p>
        <div className="tbl-scroll">
        <table className="table">
          <thead>
            <tr><th>Integration</th><th>Kind</th><th>Direction</th><th>What flows through it</th><th>Status</th><th>Managed</th></tr>
          </thead>
          <tbody>
            {INTEGRATIONS.map(i => (
              <tr key={i.name}>
                <td><strong>{i.name}</strong></td>
                <td>{i.kind}</td>
                <td><span className={`pill ${DIRECTION_PILL[i.direction]} pill-xs`}>{DIRECTION_LABEL[i.direction]}</span></td>
                <td style={{ fontSize: 12, maxWidth: 380 }}>{i.description}</td>
                <td><span className="pill pill-active pill-xs">{i.status}</span></td>
                <td>
                  {i.managedIn && typeof i.managedIn === 'object'
                    ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => setActivePanel((i.managedIn as { panel: ActivePanel; label: string }).panel)}>{(i.managedIn as { label: string }).label} →</button>
                    : <span style={{ fontSize: 11, color: 'var(--muted)' }}>{i.managedIn ?? '—'}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  )
}
