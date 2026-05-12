import { useState, useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { startReminderEngine } from './lib/reminderEngine'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import LoginScreen from './components/Auth/LoginScreen'
import SuperAdminLogin from './components/Auth/SuperAdminLogin'
import AdminLogin from './components/Auth/AdminLogin'
import Sidebar from './components/Layout/Sidebar'
import TopBar from './components/Layout/TopBar'
import Toast from './components/ui/Toast'
import Dashboard from './pages/Dashboard'
import Policies from './pages/Policies'
import Claims from './pages/Claims'
import Payments from './pages/Payments'
import Products from './pages/Products'
import Clients from './pages/Clients'
import Staff from './pages/Staff'
import Reminders from './pages/Reminders'
import Reports from './pages/Reports'
import Leads from './pages/Leads'
import Email from './pages/Email'
import Tickets from './pages/Tickets'
import Fraud from './pages/Fraud'
import Profile from './pages/Profile'
import MnoIntegration from './pages/MnoIntegration'
import SystemHealthPage from './pages/SystemHealthPage'
import NotificationSettings from './pages/NotificationSettings'
import MassMessaging from './pages/MassMessaging'
import BillingReminders from './pages/BillingReminders'
import MyPolicies from './pages/policyholder/MyPolicies'
import MyClaims from './pages/policyholder/MyClaims'
import MyPayments from './pages/policyholder/MyPayments'
import SystemHealth from './components/ui/SystemHealth'
import type { ToastMessage } from './types'

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

  const showToast = (type: ToastMessage['type'], message: string) => {
    const id = Date.now().toString()
    setToasts(prev => [...prev, { id, type, message }])
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000)
  }

  const dismissToast = (id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }

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
          {renderPanel()}
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
