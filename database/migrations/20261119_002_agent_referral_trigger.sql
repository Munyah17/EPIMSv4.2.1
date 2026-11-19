-- Make agent referral codes compulsory below the API layer as well.
--
-- create-account/api/agent-referrals are the normal issuers. This trigger is
-- the guardrail for a future agent-profile insert/update that forgets one:
-- every row lands with a stable MOT-XXXXXXXX code, and the format cannot be
-- written as a UUID or an ambiguous hand-typed value.
CREATE OR REPLACE FUNCTION public.agent_profiles_assign_referral_code()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  candidate TEXT;
BEGIN
  IF NEW.referral_code IS NOT NULL AND btrim(NEW.referral_code) <> '' THEN
    NEW.referral_code := upper(btrim(NEW.referral_code));
    RETURN NEW;
  END IF;

  candidate := 'MOT-' || translate(
    upper(substr(md5(NEW.profile_id::text || ':motions-agent'), 1, 8)),
    '0123456789ABCDEF', '23456789ABCDEFGH'
  );
  WHILE EXISTS (
    SELECT 1
    FROM public.agent_profiles existing
    WHERE existing.referral_code = candidate
      AND existing.profile_id <> NEW.profile_id
  ) LOOP
    candidate := 'MOT-' || translate(
      upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8)),
      '0123456789ABCDEF', '23456789ABCDEFGH'
    );
  END LOOP;

  NEW.referral_code := candidate;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_profiles_assign_referral_code
  ON public.agent_profiles;
CREATE TRIGGER agent_profiles_assign_referral_code
  BEFORE INSERT OR UPDATE OF referral_code ON public.agent_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.agent_profiles_assign_referral_code();

ALTER TABLE public.agent_profiles
  DROP CONSTRAINT IF EXISTS chk_agent_profiles_referral_code;
ALTER TABLE public.agent_profiles
  ADD CONSTRAINT chk_agent_profiles_referral_code
  CHECK (referral_code ~ '^MOT-[2-9A-HJKMNP-Z]{8}$');
