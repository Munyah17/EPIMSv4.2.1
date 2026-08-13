import { useEffect, useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { db } from '../../lib/db'
import type { SidebarCounts } from '../../lib/db'
import type { ActivePanel } from '../../App'
import Copyright from './Copyright'

interface SidebarProps {
  activePanel: ActivePanel
  setActivePanel: (panel: ActivePanel) => void
  isOpen: boolean
  onClose: () => void
}

interface NavItem {
  id: ActivePanel
  label: string
  icon: string
  badge?: number | string
  roles?: string[]
}

interface NavSection {
  label: string
  items: NavItem[]
}

// Policies and Products live together under one collapsible group rather
// than as two separate top-level items — they're closely related, and it
// keeps the main section shorter.
const POLICIES_PRODUCTS_GROUP: NavItem[] = [
  { id: 'policies', label: 'Policies', icon: '🛡' },
  { id: 'products', label: 'Products', icon: '📦', roles: ['super_admin', 'admin', 'policy_admin'] },
]

const STAFF_SECTIONS: NavSection[] = [
  {
    label: 'MAIN',
    items: [
      { id: 'dashboard', label: 'Dashboard', icon: '⊞' },
      { id: 'claims', label: 'Claims', icon: '📋' },
      { id: 'payments', label: 'Payments', icon: '💳' },
    ],
  },
  {
    label: 'CLIENT MANAGEMENT',
    items: [
      { id: 'clients', label: 'Clients', icon: '👥' },
      { id: 'leads', label: 'Leads & Marketing', icon: '🎯', badge: 'AI' },
    ],
  },
  {
    label: 'OPERATIONS',
    items: [
      { id: 'staff', label: 'Staff', icon: '✅', roles: ['super_admin', 'admin'] },
      { id: 'reminders', label: 'Reminders', icon: '🔔' },
      { id: 'reports', label: 'Reports', icon: '📊', roles: ['super_admin', 'admin', 'finance'] },
      { id: 'email', label: 'Email', icon: '✉' },
      { id: 'tickets', label: 'Tickets', icon: '💬' },
      { id: 'live_chat', label: 'Live Chat', icon: '🟢', roles: ['super_admin', 'admin', 'client_relations'] },
      { id: 'mass_messaging', label: 'Bulk SMS Messaging', icon: '📱', roles: ['super_admin', 'admin'] },
      { id: 'billing_reminders', label: 'Billing & Reminders', icon: '💳', roles: ['super_admin', 'admin', 'finance'] },
    ],
  },
  {
    label: 'INTEGRATIONS',
    items: [
      { id: 'mno_integration', label: 'NetOne Integration', icon: '📡', roles: ['super_admin', 'admin'] },
      { id: 'fraud', label: 'Fraud Detection', icon: '⚠', roles: ['super_admin', 'admin', 'claims_officer'] },
      { id: 'developer_api', label: 'Developer API', icon: '🔌', roles: ['super_admin', 'admin'] },
    ],
  },
  {
    label: 'SYSTEM',
    items: [
      { id: 'system_health', label: 'System Health', icon: '🖥', roles: ['super_admin', 'admin'] },
      { id: 'settings', label: 'Settings', icon: '⚙', roles: ['super_admin', 'admin'] },
      { id: 'profile', label: 'My Profile', icon: '👤' },
    ],
  },
]

const BADGE_COUNT_KEYS: Partial<Record<ActivePanel, keyof SidebarCounts>> = {
  policies: 'policies',
  claims: 'claimsPending',
  clients: 'clients',
  reminders: 'remindersDue',
  email: 'emailUnread',
  tickets: 'ticketsOpen',
}

const CLIENT_NAV: NavItem[] = [
  { id: 'my_policies', label: 'My Policies', icon: '🛡' },
  { id: 'my_claims', label: 'My Claims', icon: '📋' },
  { id: 'my_payments', label: 'My Payments', icon: '💳' },
  { id: 'profile', label: 'My Profile', icon: '👤' },
]

export default function Sidebar({ activePanel, setActivePanel, isOpen, onClose }: SidebarProps) {
  const { user, canAccess } = useAuth()
  const [counts, setCounts] = useState<SidebarCounts | null>(null)
  const [policiesGroupOpen, setPoliciesGroupOpen] = useState(activePanel === 'policies' || activePanel === 'products')

  useEffect(() => {
    if (!user || user.role === 'policyholder') return
    const load = () => { db.sidebarCounts.load().then(setCounts) }
    load()
    const interval = setInterval(load, 60000)
    return () => clearInterval(interval)
  }, [user])

  if (!user) return null

  const isClient = user.role === 'policyholder'

  if (isClient) {
    const visible = CLIENT_NAV.filter(item => canAccess(item.id))
    return (
      <aside className={`sidebar${isOpen ? ' sidebar-open' : ''}`}>
        <SidebarHeader onClose={onClose} />
        <nav className="sidebar-nav">
          {visible.map(item => (
            <NavBtn key={item.id} item={item} active={activePanel === item.id} onClick={() => setActivePanel(item.id)} />
          ))}
        </nav>
        <SidebarFooter user={user} />
      </aside>
    )
  }

  return (
    <aside className={`sidebar${isOpen ? ' sidebar-open' : ''}`}>
      <SidebarHeader onClose={onClose} />
      <nav className="sidebar-nav">
        {STAFF_SECTIONS.map(section => {
          const visible = section.items.filter(item => {
            if (item.roles && !item.roles.includes(user.role)) return false
            return canAccess(item.id)
          })
          const groupItems = section.label === 'MAIN'
            ? POLICIES_PRODUCTS_GROUP.filter(item => {
              if (item.roles && !item.roles.includes(user.role)) return false
              return canAccess(item.id)
            })
            : []
          if (!visible.length && !groupItems.length) return null
          return (
            <div key={section.label}>
              <span className="nav-sec">{section.label}</span>
              {visible.map(item => {
                const countKey = BADGE_COUNT_KEYS[item.id]
                const liveBadge = countKey && counts ? counts[countKey] : undefined
                const resolved = liveBadge !== undefined ? (liveBadge > 0 ? liveBadge : undefined) : item.badge
                return (
                  <NavBtn key={item.id} item={{ ...item, badge: resolved }} active={activePanel === item.id} onClick={() => setActivePanel(item.id)} />
                )
              })}
              {groupItems.length > 0 && (
                <>
                  <button
                    type="button"
                    className={`nav-item${groupItems.some(i => i.id === activePanel) ? ' active' : ''}`}
                    onClick={() => setPoliciesGroupOpen(o => !o)}
                  >
                    <span className="nav-icon">🛡</span>
                    <span className="nav-label">Policies &amp; Products</span>
                    <span style={{ fontSize: 10, opacity: 0.6 }}>{policiesGroupOpen ? '▾' : '▸'}</span>
                  </button>
                  {policiesGroupOpen && groupItems.map(item => {
                    const countKey = BADGE_COUNT_KEYS[item.id]
                    const liveBadge = countKey && counts ? counts[countKey] : undefined
                    const resolved = liveBadge !== undefined ? (liveBadge > 0 ? liveBadge : undefined) : item.badge
                    return (
                      <div key={item.id} style={{ paddingLeft: 16 }}>
                        <NavBtn item={{ ...item, badge: resolved }} active={activePanel === item.id} onClick={() => setActivePanel(item.id)} />
                      </div>
                    )
                  })}
                </>
              )}
            </div>
          )
        })}
      </nav>
      <SidebarFooter user={user} />
    </aside>
  )
}

function SidebarHeader({ onClose }: { onClose: () => void }) {
  return (
    <div className="sidebar-logo">
      <div className="sidebar-logo-mark">T</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="sidebar-logo-name">TARIQIFY IMS</div>
        <div className="sidebar-logo-sub">Enpassent Multiple Agents</div>
      </div>
      <button className="sidebar-close-btn" onClick={onClose} aria-label="Close sidebar">✕</button>
    </div>
  )
}

function SidebarFooter({ user }: { user: { name: string; role: string } }) {
  return (
    <>
      <div className="sidebar-user">
        <div className="sidebar-user-avatar">{user.name.charAt(0)}</div>
        <div className="sidebar-user-info">
          <div className="sidebar-user-name">{user.name}</div>
          <div className="sidebar-user-role">{user.role.replace(/_/g, ' ')}</div>
        </div>
      </div>
      <Copyright />
    </>
  )
}

function NavBtn({ item, active, onClick }: { item: NavItem; active: boolean; onClick: () => void }) {
  return (
    <button
      className={`nav-item${active ? ' active' : ''}`}
      onClick={onClick}
    >
      <span className="nav-icon">{item.icon}</span>
      <span className="nav-label">{item.label}</span>
      {item.badge !== undefined ? <span className="nav-badge">{item.badge}</span> : null}
    </button>
  )
}
