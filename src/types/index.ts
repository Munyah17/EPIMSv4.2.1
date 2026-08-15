/** super_admin/admin/tech_support are SYSTEM access roles — managed on the
 *  System Access Roles page, Super Admin only. Everything else is a WORK
 *  role — managed on Staff Management. */
export type UserRole =
  | 'super_admin'
  | 'admin'
  | 'tech_support'
  | 'claims_officer'
  | 'policy_admin'
  | 'finance'
  | 'client_relations'
  | 'agent'
  | 'policyholder'

export const SYSTEM_ROLES: UserRole[] = ['super_admin', 'admin', 'tech_support']

/** Seniority ranking used to gate task delegation (Tickets) — a staff
 *  member can delegate to their own rank or below, not upward. Peers
 *  (the four work roles) share a rank since none outranks another. */
export const ROLE_RANK: Record<UserRole, number> = {
  super_admin: 6,
  admin: 5,
  tech_support: 5,
  claims_officer: 3,
  policy_admin: 3,
  finance: 3,
  client_relations: 3,
  agent: 2,
  policyholder: 0,
}

/** No longer a fixed union — insurer partners are now managed records (see
 *  InsurerRecord/Insurer Management page) rather than a hardcoded list
 *  duplicated across every client/policy modal. */
export type Insurer = string

export interface InsurerRecord {
  id: string
  name: string
  contactEmail?: string
  contactPhone?: string
  address?: string
  regNumber?: string
  commissionPercent?: number
  status: 'active' | 'inactive'
  notes?: string
  createdAt: string
}

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

// pending = awaiting admin approval; waiting_period = approved (or created
// directly) but not yet claims-eligible — lifted to active either after the
// standard 90-day wait (non-agriculture) or instantly on first payment
// (agriculture); lapsed = a missed payment reinstates to waiting_period, not
// straight back to active.
export type PolicyStatus = 'active' | 'waiting_period' | 'lapsed' | 'cancelled' | 'pending' | 'expired'

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
  /** Farm/field location, captured at registration or via the pre-loss
   *  assessment — agriculture policies only. */
  gpsLat?: number
  gpsLng?: number
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

/** Where the claim currently sits in the receiver → processor → final
 *  reviewer pipeline. `status` is the outcome; `stage` is who owns it next. */
export type ClaimStage = 'intake' | 'assessment' | 'final_review' | 'closed'

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
  stage: ClaimStage
  /** Denormalized from the policy's product at claim creation — lets the UI
   *  know it's an agriculture claim (and therefore needs a physical
   *  assessment before final review) without an extra product lookup. */
  category?: string
  dateOfEvent: string
  dateSubmitted: string
  description: string
  fraudScore: number
  /** Whoever needs to act next — the intake receiver, then the processor,
   *  then the final reviewer, reassigned at each handoff. */
  assignedTo?: string
  assignedName?: string
  /** The staff member the underlying policy is attributed to — carried onto
   *  the claim so their portal reflects the outcome without being notified. */
  agentId?: string
  agentName?: string
  assessmentNotes?: string
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
  /** Denormalized from the underlying claim — lets the Fraud page break
   *  down cases by category (e.g. agriculture) without a second lookup. */
  category?: string
  amount?: number
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

/** A single photo captured during an assessment, plus whatever we could
 *  determine about when it was actually taken — the core of the "must
 *  never be more than 3 days old" fraud check. */
export interface AssessmentPhoto {
  path: string
  label: string
  /** From the file's EXIF DateTimeOriginal, when readable. */
  exifDate?: string
  /** A visible burned-in date stamp the AI read off the image itself
   *  (common on camera apps that overlay a date on the photo). */
  visibleDateStamp?: string
  /** Freeform note from the AI vision pass — content match, staging
   *  concerns, inconsistencies between EXIF/visible date and today. */
  aiNote?: string
  aiFlagged?: boolean
  capturedAt: string
}

export type AssessmentSyncStatus = 'synced' | 'pending_sync'

/** Post-loss physical assessment — an Assessor's site visit for an
 *  agriculture claim, required before it can be escalated to final review.
 *  Captured largely offline-first (see src/lib/offlineQueue.ts) since
 *  assessors are often on farms with no signal. */
export interface ClaimAssessment {
  id: string
  claimId: string
  claimNumber: string
  assessorId: string
  assessorName: string
  descriptionOfLoss: string
  photos: AssessmentPhoto[]
  assessorComments: string
  gpsLat?: number
  gpsLng?: number
  cropPopulation?: string
  cropStage?: string
  barnCapacity?: string
  farmerSignature?: string
  assessorSignature?: string
  farmerSelfie?: string
  submittedAt?: string
  syncStatus: AssessmentSyncStatus
  createdAt: string
}

/** Pre-loss baseline captured when an agriculture policy is registered —
 *  establishes what's actually on the farm before any claim exists, so a
 *  later claim can be checked against it (a claim for a crop that was
 *  never recorded as planted is an obvious red flag). */
export interface PolicyAssessment {
  id: string
  policyId: string
  policyNumber: string
  /** Only populated by listAll() (the cross-policy management view) — per-
   *  policy fetches already have the client in view via the policy page. */
  clientName?: string
  assessorId: string
  assessorName: string
  cropType: string
  cropPopulation?: string
  plantDate?: string
  photos: AssessmentPhoto[]
  notes: string
  gpsLat?: number
  gpsLng?: number
  syncStatus: AssessmentSyncStatus
  createdAt: string
}
