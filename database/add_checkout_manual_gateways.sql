-- Manual-payment gateways on motions.co.zw/apply: Bank Transfer and
-- EcoCash Merchant Pay collect money outside any gateway callback, so the
-- buyer uploads a proof of payment and a transaction reference and staff
-- verify it by hand before a policy is written.
--
-- 'pending_verification' = money claimed but not yet sighted by staff.
-- 'provisioning' was added by add_paynow_payment_method.sql; kept here.
ALTER TABLE public.checkout_sessions DROP CONSTRAINT IF EXISTS checkout_sessions_status_check;
ALTER TABLE public.checkout_sessions ADD CONSTRAINT checkout_sessions_status_check
  CHECK (status IN ('pending', 'pending_verification', 'provisioning', 'paid', 'failed', 'cancelled'));

ALTER TABLE public.checkout_sessions DROP CONSTRAINT IF EXISTS checkout_sessions_gateway_check;
ALTER TABLE public.checkout_sessions ADD CONSTRAINT checkout_sessions_gateway_check
  CHECK (gateway IN ('paynow', 'ecocash_instant', 'bank_transfer', 'ecocash_merchant'));

-- The proof of payment lands in the private 'documents' bucket under
-- pop/<session-id>/<filename>; only its path + name live on the row.
-- transaction_reference is the payer's own bank/EcoCash reference the
-- buyer typed on the form.
ALTER TABLE public.checkout_sessions
  ADD COLUMN IF NOT EXISTS pop_path TEXT,
  ADD COLUMN IF NOT EXISTS pop_filename TEXT,
  ADD COLUMN IF NOT EXISTS transaction_reference TEXT;

-- Staff verify/decline sessions from the IMS Payment Verifications page —
-- reads were already staff-only; the write for verification is the same
-- audience. The service-role Vercel functions are unaffected by RLS.
DROP POLICY IF EXISTS "checkout_sessions_update_staff" ON public.checkout_sessions;
CREATE POLICY "checkout_sessions_update_staff" ON public.checkout_sessions
  FOR UPDATE TO authenticated USING (is_staff()) WITH CHECK (is_staff());
