-- Currency on a Paynow transaction.
--
-- Paynow settles a transaction in the currency of the integration that
-- created it, so the amount sent to Paynow is not always the amount the
-- policy is billed in. Three columns keep those separate:
--
--   currency         what Paynow charged in
--   expected_amount  the amount sent to Paynow, in that currency
--   usd_amount       the billed amount, always USD -- this is what a policy
--                    is credited with
--   rate             units of `currency` per 1 USD at initiate time
--
-- The rate is stored per transaction, not read back from settings at
-- reconciliation time: a rate that changes between initiating and settling
-- must not retroactively change what a payment was worth.
ALTER TABLE public.paynow_transactions
  ADD COLUMN IF NOT EXISTS currency   TEXT NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD', 'ZWG')),
  ADD COLUMN IF NOT EXISTS usd_amount NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS rate       NUMERIC(18,6);

-- Existing rows predate this and were all USD at a rate of 1.
UPDATE public.paynow_transactions
   SET usd_amount = expected_amount, rate = 1
 WHERE usd_amount IS NULL;

ALTER TABLE public.paynow_transactions
  ALTER COLUMN usd_amount SET NOT NULL,
  ALTER COLUMN rate SET NOT NULL;

ALTER TABLE public.paynow_transactions
  DROP CONSTRAINT IF EXISTS paynow_transactions_usd_amount_check;
ALTER TABLE public.paynow_transactions
  ADD CONSTRAINT paynow_transactions_usd_amount_check CHECK (usd_amount > 0);

ALTER TABLE public.paynow_transactions
  DROP CONSTRAINT IF EXISTS paynow_transactions_rate_check;
ALTER TABLE public.paynow_transactions
  ADD CONSTRAINT paynow_transactions_rate_check CHECK (rate > 0);
