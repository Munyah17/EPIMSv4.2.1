-- Who captured the policy — the staff member at the desk, as distinct
-- from agent_id (the field officer/agent who sourced the business).
-- The two people are often different; the document now shows both.
-- Nullable: bot/website/policyholder policies have no staff capturer.
ALTER TABLE public.policies
  ADD COLUMN IF NOT EXISTS captured_by uuid REFERENCES public.profiles(id);
