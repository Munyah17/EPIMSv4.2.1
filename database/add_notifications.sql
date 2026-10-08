-- Notification delivery audit + WhatsApp outbox.
--
-- Every notification the platform attempts — SMS, email, WhatsApp — is
-- recorded here with its real outcome, so "the client never got the
-- confirmation" is a row to look up, not a mystery. The dashboard reads
-- the failures and banners them to admins.
--
-- status meanings:
--   sent     — the channel confirmed dispatch
--   failed   — attempted, channel returned an error (detail holds why)
--   queued   — WhatsApp with no Business API configured: parked for a
--              staff member to send via the wa.me link in `link`
--   skipped  — deliberately not sent (e.g. agriculture payment notices)
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS public.notification_log (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event      TEXT NOT NULL,            -- registration | payment | renewal | claim | ticket | system
  channel    TEXT NOT NULL,            -- sms | email | whatsapp
  recipient  TEXT NOT NULL,            -- phone or address it went to
  ref        TEXT,                     -- policy/claim/ticket number for tracing
  status     TEXT NOT NULL CHECK (status IN ('sent','failed','queued','skipped')),
  detail     TEXT,                     -- provider message / error / wa.me link
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_log_created ON public.notification_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_log_status ON public.notification_log(status, created_at DESC);

ALTER TABLE public.notification_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_log FORCE ROW LEVEL SECURITY;

-- Staff read the log (dashboard alerts, audit); writes go through the
-- service-role API (/api/notify), so no insert policy is needed.
DROP POLICY IF EXISTS "notification_log_select" ON public.notification_log;
CREATE POLICY "notification_log_select" ON public.notification_log FOR SELECT TO authenticated USING (is_staff());
