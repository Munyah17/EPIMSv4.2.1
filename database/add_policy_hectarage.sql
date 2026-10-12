-- TOBACCO HECTARAGE — the planted area, captured as a fixed-value
-- select in the portal (0.5/1/1.5/2/2.5/3 ha — never free text, so
-- values stay consistent). numeric, not text: a report can sum it.
alter table public.policies
  add column if not exists hectarage numeric(5,2);
