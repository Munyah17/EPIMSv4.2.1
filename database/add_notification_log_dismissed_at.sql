-- DISMISSED NOTIFICATION FAILURES — the dashboard counts failures it
-- hasn't seen yet. A cleared failure keeps status='failed' in the log
-- (the send still failed — the row stays for the delivery log) but
-- stops raising the banner.
alter table public.notification_log
  add column if not exists dismissed_at timestamptz;

-- FORCE RLS with only a SELECT policy means the Clear button's UPDATE
-- is silently blocked — staff need an update policy to stamp rows.
DROP POLICY IF EXISTS "notification_log_update" ON public.notification_log;
CREATE POLICY "notification_log_update" ON public.notification_log
  FOR UPDATE TO authenticated
  USING (is_staff())
  WITH CHECK (is_staff());
