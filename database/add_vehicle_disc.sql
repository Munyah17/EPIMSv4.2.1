-- Zimbabwe law requires a motor vehicle to display three round discs on the
-- windscreen -- the ZINARA licence disc, the radio licence disc, and the
-- insurance disc -- cut from a printed sheet. This is the insurance one:
-- Motions both prints it and delivers it to the client, which is a stated
-- selling point, not just an operational detail.
--
-- Registration number lives on the policy itself, not only on a later claim
-- assessment (policy_assessments already had vehicle fields, but only ever
-- captured if and when an assessment happens) -- the disc has to be
-- printable the moment the policy is issued.
ALTER TABLE public.policies
  ADD COLUMN IF NOT EXISTS vehicle_registration_number TEXT,
  ADD COLUMN IF NOT EXISTS vehicle_make TEXT,
  ADD COLUMN IF NOT EXISTS vehicle_model TEXT,
  ADD COLUMN IF NOT EXISTS disc_status TEXT
    CHECK (disc_status IN ('not_required', 'pending', 'printed', 'dispatched', 'delivered')),
  ADD COLUMN IF NOT EXISTS disc_delivery_address TEXT,
  ADD COLUMN IF NOT EXISTS disc_printed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS disc_dispatched_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS disc_delivered_at TIMESTAMPTZ;

-- Existing rows: a motor policy starts needing a disc; everything else
-- never did. Category lives on products, not policies, so this joins across.
UPDATE public.policies p
   SET disc_status = 'pending'
  FROM public.products pr
 WHERE p.product_id = pr.id AND pr.category = 'motor' AND p.disc_status IS NULL;

UPDATE public.policies
   SET disc_status = 'not_required'
 WHERE disc_status IS NULL;

ALTER TABLE public.policies ALTER COLUMN disc_status SET DEFAULT 'not_required';
