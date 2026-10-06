-- Policy source tracking + short, product-prefixed policy numbers.
--
-- 1. policies.source records where the policy was sold/issued (staff web
--    app, motions website, WhatsApp chatbot, USSD, API partner, ...).
--    Free text rather than an enum so a future channel needs no migration.
-- 2. policy_sequences + next_policy_sequence(prefix) hand out one running
--    number per product prefix (FCP, HCP, MED, LEG, TOB, ...), so numbers
--    read FCP0001, FCP0002, ... instead of timestamp-derived strings.
--
-- Idempotent — safe to re-run.

ALTER TABLE public.policies ADD COLUMN IF NOT EXISTS source TEXT;

-- Attribute the rows that already exist from the number prefixes their
-- issuing channel used before this change.
UPDATE public.policies SET source = 'motions_website' WHERE source IS NULL AND policy_number LIKE 'WEB%';
UPDATE public.policies SET source = 'api_partner'     WHERE source IS NULL AND policy_number LIKE 'API%';
UPDATE public.policies SET source = 'web_app'         WHERE source IS NULL;

CREATE TABLE IF NOT EXISTS public.policy_sequences (
  prefix     TEXT PRIMARY KEY,
  last_value BIGINT NOT NULL DEFAULT 0
);

-- Nobody reads or writes the counters directly; the SECURITY DEFINER
-- function below is the only way in, so RLS stays on with no policies.
ALTER TABLE public.policy_sequences ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.next_policy_sequence(p_prefix TEXT)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_next BIGINT;
BEGIN
  INSERT INTO public.policy_sequences (prefix, last_value)
  VALUES (UPPER(p_prefix), 1)
  ON CONFLICT (prefix)
  DO UPDATE SET last_value = policy_sequences.last_value + 1
  RETURNING last_value INTO v_next;
  RETURN v_next;
END;
$$;

GRANT EXECUTE ON FUNCTION public.next_policy_sequence(TEXT) TO authenticated, service_role;
