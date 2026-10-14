-- New policy lifecycle stage: defaulted. A policy that stays unpaid four
-- days past its due date is paused here — not lapsed outright — so paying
-- (or an Admin/Super Admin re-enable) brings it back through a fresh
-- waiting period instead of forcing a rewrite.
--
-- Without this, api/cron-reminders.ts's day-4 update fails CHECK constraint
-- and the policy stays "active" while the client is told it paused.
ALTER TABLE public.policies DROP CONSTRAINT IF EXISTS policies_status_check;
ALTER TABLE public.policies ADD CONSTRAINT policies_status_check CHECK (
  status IN ('active','waiting_period','lapsed','cancelled','pending','expired','defaulted')
);

