-- Exact payment timestamp + transaction ID on payments
-- ─────────────────────────────────────────────────────
-- payment_date stores the day; created_at already holds the exact
-- timestamp. This adds the transaction ID column: the gateway's own
-- reference when one was captured (EcoCash/Paynow), otherwise a
-- generated ID like LAM-CSH081020261649 (payer initials + method
-- abbreviation + DDMMYYYY + HHmm).
--
-- Safe to re-run. Run once in the Supabase SQL editor.

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS transaction_id TEXT;

CREATE INDEX IF NOT EXISTS idx_payments_transaction_id
  ON public.payments (transaction_id);
