import { useState, useEffect, useCallback, Suspense } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { startReminderEngine } from './lib/reminderEngine'
import { initNotifSettings } from './lib/mailService'
import { startOfflineSync } from './lib/offlineQueue'
import { DB_FALLBACK_EVENT } from './lib/db'
import { NOTIFY_FAILURE_EVENT } from './lib/notify'
import { startGatewayWatch } from './lib/smsService'
import { lazyWithRecovery } from './lib/lazyWithRecovery'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import LoginScreen from './components/Auth/LoginScreen'
import SuperAdminLogin from './components/Auth/SuperAdminLogin'
import AdminLogin from './components/Auth/AdminLogin'
import Sidebar from './components/Layout/Sidebar'
import TopBar from './components/Layout/TopBar'
import Toast from './components/ui/Toast'
import SystemHealth from './components/ui/SystemHealth'
import ChatWidget from './components/chat/ChatWidget'
import type { ToastMessage } from './types'

// Route-split: each page becomes its own chunk, fetched on first visit
// (and cached by the browser/CDN after) instead of all ~20 pages riding
// in one bundle every user downloads just to see the login screen.
const Dashboard = lazyWithRecovery('Dashboard', () => import('./pages/Dashboard'))
const Policies = lazyWithRecovery('Policies', () => import('./pages/Policies'))
const Claims = lazyWithRecovery('Claims', () => import('./pages/Claims'))
const Payments = lazyWithRecovery('Payments', () => import('./pages/Payments'))
const Products = lazyWithRecovery('Products', () => import('./pages/Products'))
const Clients = lazyWithRecovery('Clients', () => import('./pages/Clients'))
const Staff = lazyWithRecovery('Staff', () => import('./pages/Staff'))
const SystemAccessRoles = lazyWithRecovery('SystemAccessRoles', () => import('./pages/SystemAccessRoles'))
const Reminders = lazyWithRecovery('Reminders', () => import('./pages/Reminders'))
const Reports = lazyWithRecovery('Reports', () => import('./pages/Reports'))
const Leads = lazyWithRecovery('Leads', () => import('./pages/Leads'))
const Email = lazyWithRecovery('Email', () => import('./pages/Email'))
const Tickets = lazyWithRecovery('Tickets', () => import('./pages/Tickets'))
const Fraud = lazyWithRecovery('Fraud', () => import('./pages/Fraud'))
const Profile = lazyWithRecovery('Profile', () => import('./pages/Profile'))
const SystemHealthPage = lazyWithRecovery('SystemHealthPage', () => import('./pages/SystemHealthPage'))
const Settings = lazyWithRecovery('Settings', () => import('./pages/Settings'))
const DeveloperApi = lazyWithRecovery('DeveloperApi', () => import('./pages/DeveloperApi'))
const MassMessaging = lazyWithRecovery('MassMessaging', () => import('./pages/MassMessaging'))
const BillingReminders = lazyWithRecovery('BillingReminders', () => import('./pages/BillingReminders'))
const PreLossAssessments = lazyWithRecovery('PreLossAssessments', () => import('./pages/PreLossAssessments'))
const AgricultureInsurance = lazyWithRecovery('AgricultureInsurance', () => import('./pages/AgricultureInsurance'))
const MemberCards = lazyWithRecovery('MemberCards', () => import('./pages/MemberCards'))
const MyPolicies = lazyWithRecovery('MyPolicies', () => import('./pages/policyholder/MyPolicies'))
const MyClaims = lazyWithRecovery('MyClaims', () => import('./pages/policyholder/MyClaims'))
const MyPayments = lazyWithRecovery('MyPayments', () => import('./pages/policyholder/MyPayments'))
const LiveChat = lazyWithRecovery('LiveChat', () => import('./pages/LiveChat'))
const Groups = lazyWithRecovery('Groups', () => import('./pages/Groups'))
const Integrations = lazyWithRecovery('Integrations', () => import('./pages/Integrations'))
const WhatsAppBot = lazyWithRecovery('WhatsAppBot', () => import('./pages/WhatsAppBot'))

export type ActivePanel =
  | 'dashboard' | 'policies' | 'claims' | 'payments' | 'products'
  | 'clients' | 'groups' | 'staff' | 'system_access_roles' | 'reminders' | 'reports' | 'leads'
  | 'email' | 'tickets' | 'fraud' | 'profile'
  | 'system_health' | 'settings' | 'developer_api' | 'integrations' | 'mass_messaging' | 'billing_reminders' | 'pre_loss_assessments' | 'agriculture_insurance' | 'member_cards' | 'whatsapp_bot'
  | 'my_policies' | 'my_claims' | 'my_payments' | 'live_chat'

// Earlier demo builds seeded invented clients/policies/payments into
// localStorage under tqfy_*, and the simulated NetOne page used tqfy_mno_*.
// Nothing reads those keys anymore, but stale mock records have no business
// sitting in a live user's browser — remove them once at startup. Real keys
// (tqfy_cache_*, tqfy_offline_*, settings, payment/sms logs) are untouched.
const LEGACY_MOCK_KEYS = [
  'tqfy_policies', 'tqfy_clients', 'tqfy_products', 'tqfy_claims',
  'tqfy_payments', 'tqfy_tickets', 'tqfy_emails', 'tqfy_leads',
  'tqfy_staff', 'tqfy_fraudCases', 'tqfy_reminders',
]
function purgeLegacyMockStores() {
  try {
    for (const k of LEGACY_MOCK_KEYS) localStorage.removeItem(k)
    Object.keys(localStorage)
      .filter(k => k.startsWith('tqfy_mno_'))
      .forEach(k => localStorage.removeItem(k))
  } catch { /**/ }
}

function AppInner() {
  const { user, loading } = useAuth()
  const [activePanel, setActivePanelRaw] = useState<ActivePanel>(() =>
    user?.role === 'policyholder' ? 'my_policies' : 'dashboard'
  )
  // Lets a page hand the next one a starting filter, so "View Agriculture
  // Policies" from the Agriculture view opens Policies already narrowed to
  // agriculture instead of showing the whole book.
  const [panelCategory, setPanelCategory] = useState<string | undefined>(undefined)
  const setActivePanel = useCallback((panel: ActivePanel, category?: string) => {
    setPanelCategory(category)
    setActivePanelRaw(panel)
  }, [])

  useEffect(() => {
    purgeLegacyMockStores()
    // Deferred past first paint — none of these touch what the screen shows
    // initially, and running them inline made every sign-in pay for a
    // settings fetch and a full reminder scan before anything rendered.
    const start = window.setTimeout(() => {
      void initNotifSettings()
      void startReminderEngine()
      void startOfflineSync()
      void startGatewayWatch()
    }, 2000)
    return () => clearTimeout(start)
  }, [])
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [toasts, setToasts] = useState<ToastMessage[]>([])

  // Stable references: 11 pages use `[showToast]` as a data-fetch effect
  // dependency. An inline function here would be recreated on every render
  // of AppInner (e.g. whenever ANY toast anywhere appears or auto-dismisses),
  // which would re-trigger every mounted page's fetch and silently overwrite
  // any not-yet-persisted local state — including a just-added item.
  const showToast = useCallback((type: ToastMessage['type'], message: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    setToasts(prev => [...prev, { id, type, message }])
    // Stays up to 15s so it's actually readable — the user can also close
    // it early via the toast's own dismiss button (see Toast.tsx).
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 15000)
  }, [])

  const dismissToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  useEffect(() => {
    let lastReadWarningAt = 0
    let lastWriteWarningAt = 0
    const onFallback = (e: Event) => {
      const { type } = (e as CustomEvent<{ table: string; type: 'read' | 'write' | 'delete' }>).detail
      const now = Date.now()
      if (type === 'read') {
        if (now - lastReadWarningAt < 8000) return
        lastReadWarningAt = now
        showToast('warning', 'Could not reach the server, showing locally cached data. Some records may be out of date.')
      } else {
        if (now - lastWriteWarningAt < 8000) return
        lastWriteWarningAt = now
        // writeFailed() no longer saves locally — the toast must not claim
        // it did. The action's own error toast carries the real reason.
        showToast('warning', 'Could not save to the server — nothing was recorded. Check your connection and try again.')
      }
    }
    window.addEventListener(DB_FALLBACK_EVENT, onFallback)
    return () => window.removeEventListener(DB_FALLBACK_EVENT, onFallback)
  }, [])

  // A notification channel that fails used to vanish quietly — this turns
  // it into a toast on the very screen that ran the action, rate-limited
  // the same way as the DB warnings so a fan-out to five numbers doesn't
  // stack five toasts.
  useEffect(() => {
    let lastWarningAt = 0
    const onFailure = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail
      const now = Date.now()
      if (now - lastWarningAt < 8000) return
      lastWarningAt = now
      showToast('warning', `A notification could not be sent (${detail}). Admins can see this on the dashboard health strip.`)
    }
    window.addEventListener(NOTIFY_FAILURE_EVENT, onFailure)
    return () => window.removeEventListener(NOTIFY_FAILURE_EVENT, onFailure)
  }, [showToast])

  if (loading || !user) return null

  const panelProps = { showToast, setActivePanel }

  const renderPanel = () => {
    switch (activePanel) {
      case 'dashboard': return <Dashboard {...panelProps} />
      case 'policies': return <Policies {...panelProps} initialCategory={panelCategory} />
      case 'claims': return <Claims {...panelProps} initialCategory={panelCategory} />
      case 'payments': return <Payments {...panelProps} />
      case 'products': return <Products {...panelProps} initialCategory={panelCategory} />
      case 'clients': return <Clients {...panelProps} />
      case 'groups': return <Groups {...panelProps} />
      case 'staff': return <Staff {...panelProps} />
      case 'system_access_roles': return <SystemAccessRoles {...panelProps} />
      case 'reminders': return <Reminders {...panelProps} />
      case 'reports': return <Reports {...panelProps} />
      case 'leads': return <Leads {...panelProps} />
      case 'email': return <Email {...panelProps} />
      case 'tickets': return <Tickets {...panelProps} />
      case 'fraud': return <Fraud {...panelProps} />
      case 'system_health': return <SystemHealthPage {...panelProps} />
      case 'settings': return <Settings {...panelProps} />
      case 'developer_api': return <DeveloperApi {...panelProps} />
      case 'integrations': return <Integrations {...panelProps} />
      case 'mass_messaging': return <MassMessaging {...panelProps} />
      case 'whatsapp_bot': return <WhatsAppBot {...panelProps} />
      case 'billing_reminders': return <BillingReminders {...panelProps} />
      case 'pre_loss_assessments': return <PreLossAssessments {...panelProps} />
      case 'agriculture_insurance': return <AgricultureInsurance {...panelProps} />
      case 'member_cards': return <MemberCards {...panelProps} />
      case 'profile': return <Profile {...panelProps} />
      case 'my_policies': return <MyPolicies {...panelProps} />
      case 'my_claims': return <MyClaims {...panelProps} />
      case 'my_payments': return <MyPayments {...panelProps} />
      case 'live_chat': return <LiveChat {...panelProps} />
      default: return <Dashboard {...panelProps} />
    }
  }

  return (
    <div className="app-shell">
      <Sidebar
        activePanel={activePanel}
        setActivePanel={(panel) => { setActivePanel(panel); setSidebarOpen(false) }}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}
      <div className="main-content">
        <TopBar
          activePanel={activePanel}
          onMenuToggle={() => setSidebarOpen(o => !o)}
          showToast={showToast}
          setActivePanel={setActivePanel}
        />
        <div className="content-area">
          <Suspense fallback={<div className="panel"><div className="empty-state">Loading…</div></div>}>
            {renderPanel()}
          </Suspense>
        </div>
      </div>
      <Toast toasts={toasts} onDismiss={dismissToast} />
      {/* The chat FAB is also fixed bottom-right — only policyholders get
          it, so only they need the health button lifted clear of it. */}
      <SystemHealth aboveFab={user.role === 'policyholder'} />
      {user.role === 'policyholder' && (
        <ChatWidget prefill={{ name: user.name, phone: user.phone ?? '', email: user.email }} />
      )}
    </div>
  )
}

function AuthGate() {
  const { user, loading } = useAuth()

  if (loading) return <div className="app-loading">Loading…</div>

  return (
    <Routes>
      <Route path="/super-admin" element={user ? <Navigate to="/" replace /> : <SuperAdminLogin />} />
      <Route path="/admin" element={user ? <Navigate to="/" replace /> : <AdminLogin />} />
      <Route path="/*" element={user ? <AppInner /> : <LoginScreen />} />
    </Routes>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  )
}
