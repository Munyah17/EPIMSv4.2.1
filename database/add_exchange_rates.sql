-- Exchange rates, set by hand and kept as history.
--
-- `rate` is units of `currency` per 1 USD. The row with the newest
-- effective_date is the one in force; older rows are never edited or
-- deleted, so what a past transaction was converted at stays reconstructable
-- and the trend can be charted.
CREATE TABLE IF NOT EXISTS public.exchange_rates (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  currency        TEXT NOT NULL DEFAULT 'ZWG' CHECK (currency IN ('ZWG')),
  rate            NUMERIC(18,6) NOT NULL CHECK (rate > 0),
  effective_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  -- 'manual' is a figure someone entered. 'estimate' means it was seeded
  -- from a suggestion and should not be treated as an official rate.
  source          TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'estimate')),
  note            TEXT,
  set_by          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (currency, effective_date)
);

CREATE INDEX IF NOT EXISTS exchange_rates_currency_date_idx
  ON public.exchange_rates(currency, effective_date DESC);

ALTER TABLE public.exchange_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exchange_rates FORCE ROW LEVEL SECURITY;

-- Any staff member can read the rate in force -- it is needed wherever an
-- amount is shown. Only a super admin can set one.
DROP POLICY IF EXISTS "exchange_rates_select_staff" ON public.exchange_rates;
CREATE POLICY "exchange_rates_select_staff" ON public.exchange_rates
  FOR SELECT TO authenticated USING (public.is_staff());

DROP POLICY IF EXISTS "exchange_rates_insert_super_admin" ON public.exchange_rates;
CREATE POLICY "exchange_rates_insert_super_admin" ON public.exchange_rates
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.profiles p
     WHERE p.id = auth.uid() AND p.active AND p.role = 'super_admin'
  ));

DROP POLICY IF EXISTS "exchange_rates_update_super_admin" ON public.exchange_rates;
CREATE POLICY "exchange_rates_update_super_admin" ON public.exchange_rates
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles p
     WHERE p.id = auth.uid() AND p.active AND p.role = 'super_admin'
  ));
