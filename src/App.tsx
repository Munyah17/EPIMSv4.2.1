import { useState, useEffect, useCallback, lazy, Suspense } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { startReminderEngine } from './lib/reminderEngine'
import { DB_FALLBACK_EVENT } from './lib/db'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import LoginScreen from './components/Auth/LoginScreen'
import SuperAdminLogin from './components/Auth/SuperAdminLogin'
import AdminLogin from './components/Auth/AdminLogin'
import Sidebar from './components/Layout/Sidebar'
import TopBar from './components/Layout/TopBar'
import Toast from './components/ui/Toast'
import SystemHealth from './components/ui/SystemHealth'
import type { ToastMessage } from './types'

// Route-split: each page becomes its own chunk, fetched on first visit
// (and cached by the browser/CDN after) instead of all ~20 pages riding
// in one bundle every user downloads just to see the login screen.
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Policies = lazy(() => import('./pages/Policies'))
const Claims = lazy(() => import('./pages/Claims'))
const Payments = lazy(() => import('./pages/Payments'))
const Products = lazy(() => import('./pages/Products'))
const Clients = lazy(() => import('./pages/Clients'))
const Staff = lazy(() => import('./pages/Staff'))
const Reminders = lazy(() => import('./pages/Reminders'))
const Reports = lazy(() => import('./pages/Reports'))
const Leads = lazy(() => import('./pages/Leads'))
const Email = lazy(() => import('./pages/Email'))
const Tickets = lazy(() => import('./pages/Tickets'))
const Fraud = lazy(() => import('./pages/Fraud'))
const Profile = lazy(() => import('./pages/Profile'))
const MnoIntegration = lazy(() => import('./pages/MnoIntegration'))
const SystemHealthPage = lazy(() => import('./pages/SystemHealthPage'))
const NotificationSettings = lazy(() => import('./pages/NotificationSettings'))
const MassMessaging = lazy(() => import('./pages/MassMessaging'))
const BillingReminders = lazy(() => import('./pages/BillingReminders'))
const MyPolicies = lazy(() => import('./pages/policyholder/MyPolicies'))
const MyClaims = lazy(() => import('./pages/policyholder/MyClaims'))
const MyPayments = lazy(() => import('./pages/policyholder/MyPayments'))

export type ActivePanel =
  | 'dashboard' | 'policies' | 'claims' | 'payments' | 'products'
  | 'clients' | 'staff' | 'reminders' | 'reports' | 'leads'
  | 'email' | 'tickets' | 'fraud' | 'profile' | 'mno_integration'
  | 'system_health' | 'notification_settings' | 'mass_messaging' | 'billing_reminders'
  | 'my_policies' | 'my_claims' | 'my_payments'

function AppInner() {
  const { user, loading } = useAuth()
  const [activePanel, setActivePanel] = useState<ActivePanel>(() =>
    user?.role === 'policyholder' ? 'my_policies' : 'dashboard'
  )

  useEffect(() => {
    const stop = startReminderEngine()
    return stop
  }, [])
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [toasts, setToasts] = useState<ToastMessage[]>([])

  // Stable references: 11 pages use `[showToast]` as a data-fetch effect
  // dependency. An inline function here would be recreated on every render
  // of AppInner (e.g. whenever ANY toast anywhere appears or auto-dismisses),
  // which would re-trigger every mounted page's fetch and silently overwrite
  // any not-yet-persisted local state — including a just-added item.
  const showToast = useCallback((type: ToastMessage['type'], message: string) => {
    const id = Date.now().toString()
    setToasts(prev => [...prev, { id, type, message }])
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000)
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
        showToast('warning', 'Could not reach the server — showing locally cached data. Some records may be out of date.')
      } else {
        if (now - lastWriteWarningAt < 8000) return
        lastWriteWarningAt = now
        showToast('warning', 'Could not reach the server — your change was saved locally only and has NOT synced yet.')
      }
    }
    window.addEventListener(DB_FALLBACK_EVENT, onFallback)
    return () => window.removeEventListener(DB_FALLBACK_EVENT, onFallback)
  }, [])

  if (loading || !user) return null

  const panelProps = { showToast, setActivePanel }

  const renderPanel = () => {
    switch (activePanel) {
      case 'dashboard': return <Dashboard {...panelProps} />
      case 'policies': return <Policies {...panelProps} />
      case 'claims': return <Claims {...panelProps} />
      case 'payments': return <Payments {...panelProps} />
      case 'products': return <Products {...panelProps} />
      case 'clients': return <Clients {...panelProps} />
      case 'staff': return <Staff {...panelProps} />
      case 'reminders': return <Reminders {...panelProps} />
      case 'reports': return <Reports {...panelProps} />
      case 'leads': return <Leads {...panelProps} />
      case 'email': return <Email {...panelProps} />
      case 'tickets': return <Tickets {...panelProps} />
      case 'fraud': return <Fraud {...panelProps} />
      case 'mno_integration': return <MnoIntegration {...panelProps} />
      case 'system_health': return <SystemHealthPage {...panelProps} />
      case 'notification_settings': return <NotificationSettings {...panelProps} />
      case 'mass_messaging': return <MassMessaging {...panelProps} />
      case 'billing_reminders': return <BillingReminders {...panelProps} />
      case 'profile': return <Profile {...panelProps} />
      case 'my_policies': return <MyPolicies {...panelProps} />
      case 'my_claims': return <MyClaims {...panelProps} />
      case 'my_payments': return <MyPayments {...panelProps} />
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
      <SystemHealth />
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
