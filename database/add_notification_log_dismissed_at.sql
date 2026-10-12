-- DISMISSED NOTIFICATION FAILURES — the dashboard counts failures it
-- hasn't seen yet. A cleared failure keeps status='failed' in the log
-- (the send still failed — the row stays for the delivery log) but
-- stops raising the banner.
alter table public.notification_log
  add column if not exists dismissed_at timestamptz;
