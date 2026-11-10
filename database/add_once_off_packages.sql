-- Once-off insurance packages (school tours, events, short-term group
-- cover) ride the group-cover machinery but are NOT monthly policies:
-- the organisation is the policyholder, participants are billed per
-- negotiated term, and the row archives when its end_date passes.
--
-- Requires database/add_group_cover.sql first (groups, group_members,
-- policies.group_id / cover_scope / team_activity). cover_scope stays
-- about WHO is covered; once_off is the finite-term billing lifecycle.

ALTER TABLE public.policies
  ADD COLUMN IF NOT EXISTS once_off boolean NOT NULL DEFAULT false;

ALTER TABLE public.policies DROP CONSTRAINT IF EXISTS policies_once_off_package_check;
ALTER TABLE public.policies ADD CONSTRAINT policies_once_off_package_check
  CHECK (
    NOT once_off
    OR (
      group_id IS NOT NULL
      AND cover_scope IN ('corporate','group','team')
      AND start_date IS NOT NULL
      AND end_date IS NOT NULL
      AND end_date > start_date
      AND next_payment_date IS NULL
    )
  );

-- The old one-live-policy-per-product index is right for recurring cover
-- but wrong for packages: the same school can hold two different trips on
-- the same product in one year, and an archived package must not block a
-- restored/new term. Recurring scopes keep the guard; packages get their
-- own guard keyed on the actual term instead.
DROP INDEX IF EXISTS public.policies_one_live_per_client_product;
CREATE UNIQUE INDEX policies_one_live_per_client_product
  ON public.policies (client_id, product_id)
  WHERE status IN ('active', 'waiting_period')
    AND COALESCE(once_off, false) = false;

CREATE UNIQUE INDEX IF NOT EXISTS policies_one_live_package_term
  ON public.policies (group_id, product_id, start_date, end_date)
  WHERE status IN ('active', 'waiting_period')
    AND once_off = true;

CREATE INDEX IF NOT EXISTS policies_once_off_end_date_idx
  ON public.policies (end_date)
  WHERE once_off = true;
