-- Proof of payment attached to a recorded payment.
--
-- pop_url stores the Storage PATH (not a public URL) inside the private
-- 'documents' bucket under policies/<client-id>/… — the existing folder
-- RLS already lets the paying client read their own receipt and staff
-- read everything, so no new storage policy is needed.
alter table public.payments add column if not exists pop_url text;

-- PoP arrives in whatever format the payer's phone produces — HEIC
-- photos, WhatsApp exports, scans. The private bucket no longer
-- whitelists mime types; staff-only writes (RLS) are the control,
-- not file extensions.
update storage.buckets set allowed_mime_types = null where id = 'documents';
