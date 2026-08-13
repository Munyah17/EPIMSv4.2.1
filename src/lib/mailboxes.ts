/**
 * The 9 role mailboxes hosted on the company's own mail server
 * (c3.my-control-panel.com — a cPanel host). Routes each automated email
 * from the address a recipient would actually expect it from, following
 * common insurance-industry practice: transactional/system mail from a
 * no-reply address, claim correspondence from the claims desk, billing
 * asks from the desk that owns collections, etc.
 */
export const MAILBOXES = {
  /** Automated, non-interactive mail — policy issued, payment receipt,
   *  renewal/billing reminders, password resets. Never expects a reply. */
  noreply: 'noreply@enpassent.co.zw',
  /** Claim submitted, status changes, claim resolution correspondence. */
  claims: 'claims@enpassent.co.zw',
  /** Internal staff/admin notifications (new staff account, staff password
   *  reset) and anything without a more specific home. */
  admin: 'admin@enpassent.co.zw',
  /** Promotional/marketing mass messaging campaigns. */
  marketing: 'marketing@enpassent.co.zw',
  /** Policy eligibility / underwriting queries and decisions. */
  underwriting: 'underwriting@enpassent.co.zw',
  /** Ticket replies and general support correspondence. */
  customerService: 'customerservice@enpassent.co.zw',
  /** Agent/staff recruitment inquiries. */
  recruitment: 'recruitment@enpassent.co.zw',
  /** New leads, quotes, and sales follow-up. */
  sales: 'sales@enpassent.co.zw',
  /** General inbound inquiries with no clearer home. */
  info: 'info@enpassent.co.zw',
} as const
