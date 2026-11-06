import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import type { Policy } from '../../types'

vi.mock('../../lib/db', () => ({
  db: {
    products: { list: vi.fn() },
    payments: { list: vi.fn() },
    capturePayment: vi.fn(),
    clients: { get: vi.fn() },
  },
}))
vi.mock('../../lib/storage', () => ({ uploadDocument: vi.fn() }))
vi.mock('../../lib/notify', () => ({ serverReachable: vi.fn() }))
vi.mock('../../lib/activityLog', () => ({ recordActivity: vi.fn() }))
vi.mock('../../lib/signupNotifications', () => ({ notifyPaymentReceived: vi.fn() }))
vi.mock('../../lib/transactionId', () => ({ generateTransactionId: () => 'TXN' }))
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', name: 'Admin', role: 'super_admin' } }),
}))

import { db } from '../../lib/db'
import CapturePaymentModal from './CapturePaymentModal'

const policy: Policy = {
  id: 'pol1',
  policyNumber: 'EMA2026001',
  clientId: 'c1',
  clientName: 'Test Client',
  productId: 'prod-funeral',
  productName: 'Funeral Cash Plan',
  premium: 1,
  coverAmount: 1000,
  startDate: '2026-01-01',
  endDate: '2027-01-01',
  status: 'active',
  dependants: [
    { name: 'A', relationship: 'Spouse', dob: '1990-01-01', nationalId: '1', premium: 1 },
    { name: 'B', relationship: 'Child', dob: '2010-01-01', nationalId: '2', premium: 1 },
    { name: 'C', relationship: 'Child', dob: '2012-01-01', nationalId: '3', premium: 1 },
    { name: 'D', relationship: 'Child', dob: '2014-01-01', nationalId: '4', premium: 1 },
  ],
  paymentMethod: 'EcoCash',
  createdAt: '2026-01-01',
  nextPaymentDate: '2026-12-01',
  lastPaymentDate: '2026-11-03',
}

describe('CapturePaymentModal mid-cycle dependant upgrade', () => {
  beforeEach(() => {
    vi.mocked(db.products.list).mockResolvedValue({ data: [{ id: 'prod-funeral', category: 'funeral' }] } as never)
    vi.mocked(db.payments.list).mockResolvedValue({
      data: [{ policyId: 'pol1', amount: 1, date: '2026-11-03', status: 'completed' }],
    } as never)
  })

  it('defaults to the dependant top-up and keeps paid-until put on a $6 capture', async () => {
    render(
      <CapturePaymentModal
        policy={policy}
        onClose={() => {}}
        onCaptured={() => {}}
        showToast={() => {}}
      />,
    )

    await waitFor(() => {
      expect(screen.getByDisplayValue('4')).toBeInTheDocument()
    })
    expect(screen.getByText(/newly added dependants/i)).toBeInTheDocument()
    expect(screen.getByText('$4.00')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '6' } })

    await waitFor(() => {
      expect(screen.getByText(/leftover/i)).toBeInTheDocument()
      expect(screen.getByText('$2.00')).toBeInTheDocument()
    })
    expect(screen.getByText(/paid-up-to date stays put/i)).toBeInTheDocument()
    expect(screen.getAllByText('01-DEC-2026').length).toBeGreaterThan(0)
    expect(screen.getByDisplayValue('2026-12-01')).toBeInTheDocument()
  })
})
