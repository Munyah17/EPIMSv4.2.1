-- Extends the ZIMRA FDMS integration from a receipt log into the full
-- virtual-fiscalisation lifecycle (ZIMRA Option B — direct API interface):
--
--   * fdms_fiscal_days — the fiscal-day sessions ZIMRA requires every
--     device to OPEN before issuing documents and CLOSE at day's end (a
--     clean close with zero errors is part of test-environment approval).
--   * fdms_receipts gains: doc_type (FiscalInvoice / CreditNote /
--     DebitNote — all three document types are needed for the approval
--     sample pack), receipt_counter (per-day sequence), fiscal_day_id,
--     original_receipt_id + reason (credit/debit notes reference the
--     document they adjust).
--
-- RLS mirrors fdms_receipts: staff read, only the service-role API writes.

CREATE TABLE IF NOT EXISTS public.fdms_fiscal_days (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id       TEXT NOT NULL,
  fiscal_day_no   TEXT NOT NULL,           -- ZIMRA's day number when returned, else local D-NNN
  status          TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','closed','closed_with_errors')),
  opened_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  opened_by       TEXT,
  closed_at       TIMESTAMPTZ,
  closed_by       TEXT,
  receipt_counter INTEGER NOT NULL DEFAULT 0,  -- last receiptCounter issued this day
  docs_count      INTEGER NOT NULL DEFAULT 0,
  upstream_error  TEXT,                       -- last FDMS round-trip failure, if any
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fdms_days_status ON public.fdms_fiscal_days(status);

ALTER TABLE public.fdms_fiscal_days ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fdms_fiscal_days_staff_read" ON public.fdms_fiscal_days FOR SELECT TO authenticated
  USING (is_staff());

ALTER TABLE public.fdms_receipts
  ADD COLUMN IF NOT EXISTS doc_type            TEXT NOT NULL DEFAULT 'FiscalInvoice'
                                             CHECK (doc_type IN ('FiscalInvoice','CreditNote','DebitNote')),
  ADD COLUMN IF NOT EXISTS receipt_counter     INTEGER,
  ADD COLUMN IF NOT EXISTS fiscal_day_id       UUID REFERENCES public.fdms_fiscal_days(id),
  ADD COLUMN IF NOT EXISTS original_receipt_id UUID REFERENCES public.fdms_receipts(id),
  ADD COLUMN IF NOT EXISTS reason              TEXT;

CREATE INDEX IF NOT EXISTS idx_fdms_receipts_day      ON public.fdms_receipts(fiscal_day_id);
CREATE INDEX IF NOT EXISTS idx_fdms_receipts_original ON public.fdms_receipts(original_receipt_id);
