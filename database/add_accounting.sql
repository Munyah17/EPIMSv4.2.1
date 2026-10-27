-- Accounting module: quotations, requisitions, float ledger, petty-cash
-- imprest, and the ZIMRA FDMS fiscalised-document log.
--
-- All five tables follow the billing pattern (add_invoices.sql): staff
-- manage them through the app, RLS gates every operation to is_staff().
-- Document numbers run per month (QUO-202611-001, REQ-202611-001, …) with
-- unique indexes closing the same-twin-submit race invoices already have.

-- ── Quotations ────────────────────────────────────────────────────────
-- A price quoted before any cover exists. client_id links to the
-- register when the prospect is already a client; a brand-new prospect
-- just carries client_name.
CREATE TABLE IF NOT EXISTS public.quotations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quotation_number TEXT NOT NULL,
  client_id        UUID REFERENCES public.clients(id),
  client_name      TEXT NOT NULL,
  product_id       UUID REFERENCES public.products(id),
  product_name     TEXT NOT NULL DEFAULT '',
  premium          NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (premium >= 0),
  cover_amount     NUMERIC(14,2) CHECK (cover_amount IS NULL OR cover_amount >= 0),
  status           TEXT NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','sent','accepted','declined','expired')),
  valid_until      DATE,
  notes            TEXT,
  created_by       UUID REFERENCES public.profiles(id),
  created_by_name  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS quotations_number_unique
  ON public.quotations(quotation_number);
CREATE INDEX IF NOT EXISTS idx_quotations_status ON public.quotations(status);
CREATE INDEX IF NOT EXISTS idx_quotations_client ON public.quotations(client_id);

ALTER TABLE public.quotations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "quotations_staff_all" ON public.quotations FOR ALL TO authenticated
  USING (is_staff()) WITH CHECK (is_staff());

-- ── Requisitions ──────────────────────────────────────────────────────
-- Staff ask for money out; finance/admin approve, then mark paid. The
-- lifecycle is a status column, not separate tables — one row tells the
-- whole story of a request.
CREATE TABLE IF NOT EXISTS public.requisitions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requisition_number TEXT NOT NULL,
  payee              TEXT NOT NULL,
  purpose            TEXT NOT NULL,
  category           TEXT NOT NULL DEFAULT 'General',
  amount             NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','approved','rejected','paid')),
  requested_by       UUID REFERENCES public.profiles(id),
  requested_by_name  TEXT,
  approved_by        UUID REFERENCES public.profiles(id),
  approved_by_name   TEXT,
  approved_at        TIMESTAMPTZ,
  paid_at            TIMESTAMPTZ,
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS requisitions_number_unique
  ON public.requisitions(requisition_number);
CREATE INDEX IF NOT EXISTS idx_requisitions_status ON public.requisitions(status);

ALTER TABLE public.requisitions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "requisitions_staff_all" ON public.requisitions FOR ALL TO authenticated
  USING (is_staff()) WITH CHECK (is_staff());

-- ── Float ledger ──────────────────────────────────────────────────────
-- Cash advanced to a staff member or agent to spend on the
-- organisation's behalf. A ledger, never an editable balance — the
-- running figure is derived: issues − spends − returns, so the audit
-- trail is the record.
CREATE TABLE IF NOT EXISTS public.float_entries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  holder_id       UUID REFERENCES public.profiles(id),
  holder_name     TEXT NOT NULL,
  entry_type      TEXT NOT NULL
                  CHECK (entry_type IN ('issue','spend','return')),
  amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  description     TEXT NOT NULL,
  recorded_by     UUID REFERENCES public.profiles(id),
  recorded_by_name TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_float_entries_holder ON public.float_entries(holder_name);
CREATE INDEX IF NOT EXISTS idx_float_entries_type ON public.float_entries(entry_type);

ALTER TABLE public.float_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "float_entries_staff_all" ON public.float_entries FOR ALL TO authenticated
  USING (is_staff()) WITH CHECK (is_staff());

-- ── Petty cash ────────────────────────────────────────────────────────
-- The office imprest: 'replenish' tops the box up, 'expense' draws it
-- down. Same ledger-as-truth principle as the float — the balance is a
-- sum, not a column anyone can edit.
CREATE TABLE IF NOT EXISTS public.petty_cash_entries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_type      TEXT NOT NULL
                  CHECK (entry_type IN ('expense','replenish')),
  category        TEXT NOT NULL DEFAULT 'General',
  payee           TEXT,
  description     TEXT NOT NULL,
  amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  receipt_ref     TEXT,
  recorded_by     UUID REFERENCES public.profiles(id),
  recorded_by_name TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_petty_cash_type ON public.petty_cash_entries(entry_type);

ALTER TABLE public.petty_cash_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "petty_cash_staff_all" ON public.petty_cash_entries FOR ALL TO authenticated
  USING (is_staff()) WITH CHECK (is_staff());

-- ── ZIMRA FDMS receipts ───────────────────────────────────────────────
-- One row per document submitted to ZIMRA's Fiscalisation Device
-- Management System. Written by the /api/fdms server endpoint (service
-- role), read by staff — RLS keeps the table staff-visible but only the
-- server writes, because the service role bypasses RLS.
CREATE TABLE IF NOT EXISTS public.fdms_receipts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id        UUID REFERENCES public.invoices(id),
  receipt_number    TEXT NOT NULL,        -- the invoice/receipt number submitted
  client_name       TEXT NOT NULL DEFAULT '',
  amount            NUMERIC(14,2) NOT NULL,
  vat_amount        NUMERIC(14,2),
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','fiscalised','failed')),
  device_id         TEXT,
  fiscal_day        TEXT,
  global_no         BIGINT,               -- ZIMRA receiptGlobalNo
  verification_code TEXT,                 -- ZIMRA receiptVerificationCode
  qr_data           TEXT,                 -- ZIMRA verification QR payload
  error             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fdms_receipts_invoice ON public.fdms_receipts(invoice_id);
CREATE INDEX IF NOT EXISTS idx_fdms_receipts_status ON public.fdms_receipts(status);

ALTER TABLE public.fdms_receipts ENABLE ROW LEVEL SECURITY;
-- Staff read; writes come from the service-role API endpoint, which
-- bypasses RLS entirely — no INSERT/UPDATE policy means no client can
-- fabricate a "fiscalised" row.
CREATE POLICY "fdms_receipts_staff_read" ON public.fdms_receipts FOR SELECT TO authenticated
  USING (is_staff());
