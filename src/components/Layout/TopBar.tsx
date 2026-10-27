import { useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { hardRefresh } from '../../lib/hardRefresh'
import type { ActivePanel } from '../../App'
import type { ToastMessage } from '../../types'

interface TopBarProps {
  activePanel: ActivePanel
  onMenuToggle: () => void
  showToast: (type: ToastMessage['type'], message: string) => void
  setActivePanel: (panel: ActivePanel) => void
}

const PANEL_TITLES: Record<ActivePanel, string> = {
  dashboard: 'Dashboard',
  policies: 'Policies',
  claims: 'Claims',
  payments: 'Payments',
  payment_verifications: 'Payment Verifications',
  products: 'Products',
  clients: 'Clients Management',
  clients_no_policy: 'Clients With No Policy',
  groups: 'Group Teams Insurance',
  staff: 'Staff Management',
  reminders: 'Reminders',
  reports: 'Reports',
  leads: 'Leads & Marketing',
  email: 'Email',
  tickets: 'Support Tickets',
  live_chat: 'Live Chat',
  fraud: 'Fraud Alert',
  integrations: 'Integrations',
  marketing_contacts: 'Marketing Database',
  campaign_composer: 'Campaign Composer',
  system_health: 'System Health',
  settings: 'Settings',
  developer_api: 'Developers and API',
  mass_messaging: 'Bulk SMS Messaging',
  sms_templates: 'SMS Templates',
  whatsapp_bot: 'WhatsApp Chatbot',
  billing_reminders: 'Billing & Reminders',
  accounting: 'Accounting',
  pre_loss_assessments: 'Pre-Loss Assessments',
  member_cards: 'Membership IDs',
  agriculture_insurance: 'Agriculture Insurance',
  system_access_roles: 'System Access Roles',
  profile: 'My Profile',
  my_policies: 'My Policies',
  my_claims: 'My Claims',
  my_payments: 'My Payments',
}

export default function TopBar({ activePanel, onMenuToggle, showToast }: TopBarProps) {
  const { user, logout } = useAuth()
  const [showDropdown, setShowDropdown] = useState(false)
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })

  const handleLogout = () => {
    setShowDropdown(false)
    setShowLogoutConfirm(true)
  }

  const confirmLogout = () => {
    showToast('info', 'Signed out successfully.')
    setTimeout(logout, 500)
  }

  return (
    <>
      <header className="topbar">
        <div className="topbar-left">
          <button className="menu-toggle" onClick={onMenuToggle} aria-label="Toggle menu">
            ☰
          </button>
          <div>
            <h1 className="topbar-title">{PANEL_TITLES[activePanel]}</h1>
            <p className="topbar-date">{today}</p>
          </div>
        </div>

        <div className="topbar-right">
          {/* "Force Refresh Updates" — for the "I can't see the fix you
              deployed" problem. Named so a customer can be told to press
              it without a word about caches or builds: it quietly clears
              stored data and loads the newest version. Auth tokens are
              deliberately not cleared — it never signs anyone out. */}
          <button
            type="button"
            className="topbar-refresh"
            title="Force Refresh Updates — loads the newest version"
            aria-label="Force Refresh Updates"
            disabled={refreshing}
            onClick={() => {
              setRefreshing(true)
              showToast('info', 'Getting the latest updates…')
              void hardRefresh()
            }}
          >
            <span className={refreshing ? 'refresh-spin' : undefined}>↻</span> Force Refresh Updates
          </button>
          <div className="topbar-profile" onClick={() => setShowDropdown(o => !o)}>
            <div className="topbar-avatar">{user?.name.charAt(0)}</div>
            <div className="topbar-user-info">
              <span className="topbar-user-name">{user?.name}</span>
              <span className="topbar-user-role">{user?.role.replace(/_/g, ' ')}</span>
            </div>
            <span className="topbar-chevron">{showDropdown ? '▲' : '▼'}</span>
          </div>

          {/* Mobile-only avatar button */}
          <button
            className="mobile-avatar-btn"
            onClick={() => setShowDropdown(o => !o)}
            aria-label="Profile menu"
          >
            {user?.name.charAt(0)}
          </button>

          {showDropdown && (
            <>
              <div className="dropdown-backdrop" onClick={() => setShowDropdown(false)} />
              <div className="profile-dropdown">
                <div className="dropdown-header">
                  <strong>{user?.name}</strong>
                  <span>{user?.email}</span>
                </div>
                <div className="dropdown-divider" />
                <button className="dropdown-item" onClick={() => setShowDropdown(false)}>
                  👤 My Profile
                </button>
                <button className="dropdown-item danger" onClick={handleLogout}>
                  ⏻ Sign Out
                </button>
              </div>
            </>
          )}
        </div>
      </header>

      {showLogoutConfirm && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 380 }}>
            <div className="modal-header">
              <h3>Sign Out</h3>
            </div>
            <div className="modal-body">
              <p>Are you sure you want to sign out of TariqifyIMS?</p>
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setShowLogoutConfirm(false)}>Cancel</button>
              <button className="btn btn-danger" onClick={confirmLogout}>Sign Out</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
