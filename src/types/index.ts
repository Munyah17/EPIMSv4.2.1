export type UserRole =
  | 'super_admin'
  | 'admin'
  | 'claims_officer'
  | 'policy_admin'
  | 'finance'
  | 'client_relations'
  | 'policyholder'

export type Insurer = 'Motions' | 'CBZ Life' | 'EcoSure' | 'ZB Life' | 'Nyaradzo Funeral' | 'Doves'

export interface AppUser {
  id: string
  name: string
  /** Short, self-chosen nickname used for username login — distinct from `name`. */
  username?: string
  email: string
  role: UserRole
  department: string
  phone?: string
  active: boolean
  permissions: string[]
  /** A Super Admin-defined named permission bundle assigned on top of the
   *  base role above — see src/lib/permissions.ts. Assigning one snapshots
   *  its permission list into `permissions`; further per-user tweaks via
   *  PermissionsModal are still possible and will diverge from the role. */
  customRoleId?: string
  customRoleName?: string
  lastLogin?: string
  password?: string
}

export interface CustomRole {
  id: string
  name: string
  description?: string
  permissions: string[]
  createdBy?: string
  createdAt: string
}

export interface Client {
  id: string
  name: string
  email: string
  phone: string
  nationalId: string
  dob: string
  address: string
  occupation?: string
  insurer?: Insurer
  createdAt: string
  policyCount: number
  status: 'active' | 'inactive'
}

/** A person the policyholder carries on their policy and pays cover for
 *  independently — not a payout-share beneficiary. Each dependant is tied
 *  to their own chosen plan/premium (never more than the policyholder's
 *  own premium); the policyholder's plan does not automatically cover
 *  them. Optional — a policy can have zero dependants. */
export interface Dependant {
  name: string
  relationship: string
  dob: string
  /** ID number for a dependant 16+; a birth record/entry number is
   *  accepted for younger dependants (not every birth certificate carries
   *  a future national ID number). */
  nationalId: string
  productId?: string
  productName?: string
  premium?: number
  coverAmount?: number
  phone?: string
}

export type PolicyStatus = 'active' | 'lapsed' | 'cancelled' | 'pending' | 'expired'

export interface Policy {
  id: string
  policyNumber: string
  clientId: string
  clientName: string
  productId: string
  productName: string
  premium: number
  coverAmount: number
  startDate: string
  endDate: string
  status: PolicyStatus
  dependants: Dependant[]
  paymentMethod: string
  insurer?: Insurer
  /** Agriculture policies only — the grower's registration number with the insurer. */
  growerNumber?: string
  agentId?: string
  agentName?: string
  createdAt: string
  nextPaymentDate?: string
  lastPaymentDate?: string
}

export interface Product {
  id: string
  name: string
  code: string
  category: 'life' | 'funeral' | 'health' | 'accident' | 'motor' | 'property' | 'agriculture'
  premium: number
  coverAmount: number
  waitingPeriodDays: number
  maxAge: number
  minAge: number
  commissionPct: number
  active: boolean
  features: string[]
  description: string
  policiesCount: number
}

export type ClaimStatus = 'pending' | 'under_review' | 'approved' | 'rejected' | 'paid'

export interface Claim {
  id: string
  claimNumber: string
  policyId: string
  policyNumber: string
  clientId: string
  clientName: string
  productName: string
  claimType: string
  amount: number
  status: ClaimStatus
  dateOfEvent: string
  dateSubmitted: string
  description: string
  fraudScore: number
  assignedTo?: string
  documents: string[]
  notes?: string
  resolvedAt?: string
}

export type PaymentMethod = 'OneMoney' | 'InnBucks' | 'Airtime Balance' | 'Bank Transfer' | 'Cash' | 'Debit Order' | 'Stop Order' | 'Paynow' | 'Zipit' | 'EcoCash'

export type PaymentStatus = 'completed' | 'pending' | 'failed' | 'reversed'

export interface SplitPayment {
  method: PaymentMethod
  amount: number
}

export interface Payment {
  id: string
  reference: string
  policyId: string
  policyNumber: string
  clientName: string
  amount: number
  method: PaymentMethod
  status: PaymentStatus
  date: string
  splitPayments?: SplitPayment[]
}

export type TicketStatus = 'open' | 'in_progress' | 'resolved' | 'closed'
export type TicketPriority = 'low' | 'medium' | 'high' | 'urgent'

export interface TicketMessage {
  id: string
  senderId: string
  senderName: string
  message: string
  timestamp: string
  isStaff: boolean
}

export interface Ticket {
  id: string
  ticketNumber: string
  clientId: string
  clientName: string
  subject: string
  description: string
  status: TicketStatus
  priority: TicketPriority
  category: string
  assignedTo?: string
  assignedName?: string
  createdAt: string
  updatedAt: string
  messages: TicketMessage[]
}

export interface EmailMessage {
  id: string
  from: string
  fromName: string
  to: string
  cc?: string
  subject: string
  body: string
  timestamp: string
  read: boolean
  starred?: boolean
  folder: 'inbox' | 'sent' | 'draft' | 'claims'
  linkedTo?: string
  attachments?: string[]
}

export type LeadStatus = 'new' | 'contacted' | 'qualified' | 'proposal' | 'converted' | 'lost'

export interface Lead {
  id: string
  name: string
  email?: string
  phone: string
  source: string
  productInterest: string
  status: LeadStatus
  intentScore: number
  createdAt: string
  lastContact?: string
  notes?: string
  assignedTo?: string
}

export type FraudCaseStatus = 'open' | 'investigating' | 'confirmed' | 'cleared'

export interface FraudCase {
  id: string
  claimId: string
  claimNumber: string
  policyNumber: string
  clientName: string
  fraudScore: number
  signals: string[]
  status: FraudCaseStatus
  assignedTo?: string
  createdAt: string
  resolvedAt?: string
  notes?: string
}

export interface Reminder {
  id: string
  type: 'payment_due' | 'policy_renewal' | 'claim_followup' | 'birthday' | 'document_expiry'
  clientId: string
  clientName: string
  policyId?: string
  policyNumber?: string
  dueDate: string
  message: string
  sent: boolean
  channel: 'sms' | 'whatsapp' | 'email' | 'ussd'
}

export interface CautionFlag {
  policyId: string
  policyNumber: string
  clientId: string
  clientName: string
  agentId?: string
  daysOverdue: number
  flaggedAt: string
  monthsDefaulted: number
  cleared: boolean
  clearedAt?: string
}

export interface GatewaySettings {
  ecocashMerchantCode: string
  ecocashMerchantPin: string
  ecocashMerchantPhone: string
  ecocashApiUrl: string
  paynowIntegrationId: string
  paynowIntegrationKey: string
  paynowReturnUrl: string
  paynowResultUrl: string
  zipitBankName: string
  zipitAccountName: string
  zipitAccountNumber: string
  zipitBranchCode: string
  smsApiKey: string
  smsUsername: string
  smsSenderId: string
  smsSandbox: boolean
  smtpHost: string
  smtpPort: number
  smtpUser: string
  smtpPass: string
  smtpFrom: string
  smtpFromName: string
}

export interface ToastMessage {
  id: string
  type: 'success' | 'error' | 'warning' | 'info'
  message: string
}

export interface DashboardStats {
  activePolicies: number
  totalPremiumsThisMonth: number
  pendingClaims: number
  newLeadsThisWeek: number
  openTickets: number
  renewalsThisWeek: number
  fraudAlerts: number
  lapseRate: number
}

export interface ChatTopic {
  id: string
  name: string
  active: boolean
  sortOrder: number
}

export type ChatSessionStatus = 'queued' | 'active' | 'closed'

export interface ChatSession {
  id: string
  visitorId: string
  visitorName: string
  visitorPhone: string
  visitorEmail: string
  topic: string
  status: ChatSessionStatus
  assignedTo?: string
  assignedName?: string
  queuedAt: string
  startedAt?: string
  closedAt?: string
}

export interface ChatMessage {
  id: string
  sessionId: string
  senderType: 'visitor' | 'agent' | 'system'
  senderName: string
  body: string
  createdAt: string
}
