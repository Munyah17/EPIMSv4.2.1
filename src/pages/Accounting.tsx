import { useState } from 'react'
import type { ToastMessage } from '../types'
import InvoicingPanel from '../components/accounting/InvoicingPanel'
import QuotationsPanel from '../components/accounting/QuotationsPanel'
import RequisitionsPanel from '../components/accounting/RequisitionsPanel'
import FloatPanel from '../components/accounting/FloatPanel'
import PettyCashPanel from '../components/accounting/PettyCashPanel'
import FdmsPanel from '../components/accounting/FdmsPanel'
import MoneyReportsPanel from '../components/accounting/MoneyReportsPanel'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
}

type Tab = 'invoicing' | 'quotations' | 'requisitions' | 'float' | 'petty_cash' | 'fdms' | 'money_reports'

const TABS: { id: Tab; label: string }[] = [
  { id: 'invoicing', label: 'Invoicing' },
  { id: 'quotations', label: 'Quotations' },
  { id: 'requisitions', label: 'Requisitions' },
  { id: 'float', label: 'Float' },
  { id: 'petty_cash', label: 'Petty Cash' },
  { id: 'fdms', label: 'ZIMRA FDMS' },
  { id: 'money_reports', label: 'Money Reports' },
]

/** Money management: bills out (invoices, quotations), approvals and spend
 *  (requisitions, float, petty cash), and what ZIMRA requires (FDMS
 *  fiscalisation) plus the money reports that tie it together. */
export default function Accounting({ showToast }: Props) {
  const [tab, setTab] = useState<Tab>('invoicing')

  return (
    <div className="panel">
      <div className="tabs">
        {TABS.map(t => (
          <button key={t.id} className={`tab${tab === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'invoicing' && <InvoicingPanel showToast={showToast} />}
      {tab === 'quotations' && <QuotationsPanel showToast={showToast} />}
      {tab === 'requisitions' && <RequisitionsPanel showToast={showToast} />}
      {tab === 'float' && <FloatPanel showToast={showToast} />}
      {tab === 'petty_cash' && <PettyCashPanel showToast={showToast} />}
      {tab === 'fdms' && <FdmsPanel showToast={showToast} />}
      {tab === 'money_reports' && <MoneyReportsPanel showToast={showToast} />}
    </div>
  )
}
