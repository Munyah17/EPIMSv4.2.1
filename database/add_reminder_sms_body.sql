-- The sent-reminders log needs to show the actual SMS text that went out,
-- not just the internal stage tag. sms_body holds the verbatim message
-- delivered to the client's phone — the most important channel of them
-- all is the one that gets a real audit trail.
ALTER TABLE public.reminders ADD COLUMN IF NOT EXISTS sms_body TEXT;
