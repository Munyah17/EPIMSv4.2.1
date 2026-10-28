-- Monthly invoices for group-cover policies.
--
-- One invoice per policy per billing period, enforced by the unique index
-- on (policy_id, period) — the cron run and the manual "generate" button
-- can race or retry all they like; the second attempt is simply refused
-- instead of issuing the same invoice twice.
--
-- The organisation holds the policy but the invoice points at the
-- policyholder client record (the account-holder contact), and group_id
-- keeps which organisation it bills.

CREATE TABLE IF NOT EXISTS public.invoices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number  TEXT NOT NULL,
  policy_id       UUID NOT NULL REFERENCES public.policies(id) ON DELETE RESTRICT,
  client_id       UUID NOT NULL REFERENCES public.clients(id),
  -- FK is required, not decorative: PostgREST resolves the
  -- groups!group_id(name) embed in invoice reads through it — without
  -- the constraint every INVOICE_SELECT errors out.
  group_id        UUID REFERENCES public.groups(id),
  period          TEXT NOT NULL,            -- 'YYYY-MM'
  heads           INT NOT NULL DEFAULT 0,   -- billed members on the roster
  amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  status          TEXT NOT NULL DEFAULT 'issued'
                  CHECK (status IN ('issued','paid','cancelled')),
  due_date        DATE,
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at         TIMESTAMPTZ,
  created_by      TEXT,                     -- 'cron' or a staff member's name
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS invoices_number_unique
  ON public.invoices(invoice_number);

-- One live invoice per policy per month — a cancelled invoice frees the
-- slot so it can be re-issued, an issued/paid one cannot be duplicated.
CREATE UNIQUE INDEX IF NOT EXISTS invoices_policy_period_unique
  ON public.invoices(policy_id, period)
  WHERE status <> 'cancelled';

CREATE INDEX IF NOT EXISTS idx_invoices_policy ON public.invoices(policy_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON public.invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_period ON public.invoices(period);

ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

-- Staff manage invoices — same is_staff() pattern as the rest of the
-- billing tables. Clients receive their invoice by SMS/email, not by
-- querying this table.
CREATE POLICY "invoices_staff_all" ON public.invoices FOR ALL TO authenticated
  USING (is_staff()) WITH CHECK (is_staff());
