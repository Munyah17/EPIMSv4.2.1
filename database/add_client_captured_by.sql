-- Who captured the client — the staff member at the desk who registered
-- them in Client Management, as distinct from agent_id (the field
-- officer/agent who sourced the business). Mirrors policies.captured_by
-- (add_policy_captured_by.sql) so staff can see who added a client with
-- or without a policy. Nullable: bot/website self-registrations have no
-- staff capturer.
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS captured_by uuid REFERENCES public.profiles(id);
