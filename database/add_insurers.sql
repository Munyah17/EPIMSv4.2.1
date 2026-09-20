-- Insurer records — previously "insurer" was just a free-text
-- column on clients/policies backed by an identical hardcoded array
-- duplicated across four modals (EditClientModal, EditPolicyModal,
-- NewPolicyModal, RegisterClientModal). This table backs the insurer value
-- stored on client/policy records.
--
-- Motions Microinsurance is the ONLY insurer this system underwrites for.
-- The seed below inserts exactly one row; do not add further rows here.

CREATE TABLE IF NOT EXISTS public.insurers (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                  TEXT NOT NULL UNIQUE,
  contact_email         TEXT,
  contact_phone         TEXT,
  address               TEXT,
  reg_number            TEXT,
  commission_percent    NUMERIC(5,2),
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.insurers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.insurers FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "insurers_select_staff" ON public.insurers;
CREATE POLICY "insurers_select_staff" ON public.insurers FOR SELECT TO authenticated USING (is_staff());
DROP POLICY IF EXISTS "insurers_write_admin" ON public.insurers;
CREATE POLICY "insurers_write_admin" ON public.insurers FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());

-- Seed with the sole insurer this system underwrites for.
INSERT INTO public.insurers (name, status) VALUES
  ('Motions Microinsurance', 'active')
ON CONFLICT (name) DO NOTHING;
