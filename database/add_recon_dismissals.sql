-- RECON DISMISSALS — the reconciliation card lists "money/record
-- happened, counterpart didn't" items that keep alerting until
-- someone checks them. A dismissal is an ACKNOWLEDGEMENT, not a
-- deletion: the client row, the paynow transaction and the pending
-- policy all keep their truth — they just stop re-raising the card.
-- New items after the dismiss are not dismissed and still alert.

create table if not exists public.recon_dismissals (
  kind         text not null,           -- 'orphaned_client' | 'stale_paynow' | 'paid_but_pending'
  ref          text not null,           -- client.id / paynow reference / policy id
  dismissed_at timestamptz not null default now(),
  dismissed_by uuid,
  primary key (kind, ref)
);

alter table public.recon_dismissals enable row level security;
alter table public.recon_dismissals force row level security;
-- Written and read only through /api/admin-recon (service role) — no
-- client policies needed; the table is invisible to the anon role.
