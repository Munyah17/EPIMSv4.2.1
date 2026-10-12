-- SYSTEM FIXES LOG — every automatic repair the AI system checker
-- applies is recorded here: what it was, how many rows it touched, who
-- ran the check and when. The point of the checker is that a person on
-- support duty can lean on it — this table is how a senior person
-- later reviews what the machine did on their behalf.

create table if not exists public.system_fixes (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null,             -- 'phone_normalized' | ...
  detail     text not null,             -- what the fix did, in words
  records    int not null default 0,    -- how many rows it touched
  applied_by uuid,                      -- the staff user who ran the check
  applied_at timestamptz not null default now()
);

alter table public.system_fixes enable row level security;
alter table public.system_fixes force row level security;

-- Staff read the log through the System Health page; the checker writes
-- with the service role.
DROP POLICY IF EXISTS "system_fixes_staff_select" ON public.system_fixes;
CREATE POLICY "system_fixes_staff_select" ON public.system_fixes
  FOR SELECT USING (is_staff());
