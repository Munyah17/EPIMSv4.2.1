-- AGENT PROFILES — the agent file.
--
-- Agents are NOT employees: they are commission-paid intermediaries
-- onboarded on contract (IPEC-regulated distribution in Zimbabwe).
-- An employee needs a department; an agent needs KYC, a territory, a
-- contract start, and payout rails. Keeping that on one profiles row
-- would mean NULL columns for half the staff table, so the agent file
-- is its own row, keyed 1:1 to the login profile.
create table if not exists public.agent_profiles (
  profile_id     uuid primary key references public.profiles(id) on delete cascade,
  national_id    text,
  territory      text,        -- the field area the agent works
  contract_start date,        -- onboarded-from
  commission_pct numeric(5,2),-- agreed override; blank = product default
  bank_name      text,
  bank_account   text,
  ecocash_number text,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table public.agent_profiles enable row level security;

-- Staff read/write the agent file; an agent reads their own (for the
-- payout/contract detail on their dashboard later).
drop policy if exists "agent_profiles_staff" on public.agent_profiles;
create policy "agent_profiles_staff" on public.agent_profiles for all
  using (public.is_staff()) with check (public.is_staff());
drop policy if exists "agent_profiles_own_read" on public.agent_profiles;
create policy "agent_profiles_own_read" on public.agent_profiles for select
  using (profile_id = auth.uid());
