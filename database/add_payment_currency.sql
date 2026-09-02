-- Currency on a payment.
--
-- USD is the base currency: every price is held in USD, and a ZiG price is
-- worked out from it at the rate on record. A payment, though, is recorded
-- in the currency it was actually made in -- a ZiG payment stays a ZiG
-- payment, and is never converted back into a dollar figure.
--
-- amount_usd and amount_zwg are generated from amount and currency rather
-- than written alongside them, so the two can never disagree. Totals per
-- currency come from summing the column, and rows of the other currency
-- contribute nothing rather than being silently added at some rate.
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USD'
    CHECK (currency IN ('USD', 'ZWG'));

ALTER TABLE public.payments
  DROP COLUMN IF EXISTS amount_usd,
  DROP COLUMN IF EXISTS amount_zwg;

ALTER TABLE public.payments
  ADD COLUMN amount_usd NUMERIC(12,2)
    GENERATED ALWAYS AS (CASE WHEN currency = 'USD' THEN amount END) STORED,
  ADD COLUMN amount_zwg NUMERIC(12,2)
    GENERATED ALWAYS AS (CASE WHEN currency = 'ZWG' THEN amount END) STORED;

CREATE INDEX IF NOT EXISTS payments_currency_idx ON public.payments(currency);

-- The rate a ZiG figure was worked out at, kept on the payment so the price
-- the client was quoted stays reconstructable after the rate moves on.
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS rate NUMERIC(18,6);
