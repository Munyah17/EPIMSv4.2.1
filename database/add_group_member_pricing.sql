-- GROUP MEMBER PRICING — group insurance is negotiated: each roster
-- member carries their OWN agreed premium and sum assured, never the
-- product's defaults. The roster sync copies these into the policy's
-- dependants, so invoices bill what was actually negotiated.
alter table public.group_members
  add column if not exists premium      numeric(10,2),
  add column if not exists cover_amount numeric(12,2);
