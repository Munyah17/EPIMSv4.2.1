-- Agriculture policies: the contractor the grower is contracted to
-- (the tobacco merchant buying the crop — TIMB context). Captured at
-- registration, printed beside the grower number on the policy document.

ALTER TABLE public.policies
  ADD COLUMN IF NOT EXISTS contractor text;
