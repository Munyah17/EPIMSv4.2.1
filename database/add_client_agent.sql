-- Client → referring agent binding.
--
-- policies.agent_id already records which agent a policy is attributed to;
-- this adds the same FK on clients so staff can record "this client was
-- brought in by agent X" at registration time — before any policy exists —
-- and so a new policy created for that client can prefill its agent from it.
--
-- Nullable and optional on purpose: plenty of clients are direct walk-ins,
-- and SET NULL on profile delete mirrors policies.agent_id.
--
-- Idempotent — safe to re-run.

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_clients_agent ON public.clients(agent_id);
