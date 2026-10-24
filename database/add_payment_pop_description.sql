-- Free-text note captured alongside a proof of payment — the transaction
-- code, bank reference or staff comment typed in the PoP box at
-- registration or payment recording. Optional like pop_url: the app
-- probes it (hasColumn) so a database before this migration still reads
-- and writes payments fine, the note just isn't persisted until this runs.
alter table public.payments add column if not exists pop_description text;
