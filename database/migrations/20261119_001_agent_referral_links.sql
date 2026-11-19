-- Field-agent referral links.
--
-- The public identifier is a short, persistent code on agent_profiles. It is
-- deliberately not the profile UUID: it can be printed, dictated over the
-- phone and embedded in the public site's /apply?agent=... link without
-- exposing the account's auth id. A referral code is assigned to every
-- existing and future agent; merged/suspended agents keep their historical
-- code but are not resolved as active referrers by the website.

ALTER TABLE public.agent_profiles
  ADD COLUMN IF NOT EXISTS referral_code TEXT;

-- Every profiles row with role='agent' must have an agent file. Historical
-- agent accounts existed before agent_profiles was introduced, so backfill
-- the 1:1 file first and only then issue referral codes.
INSERT INTO public.agent_profiles (profile_id)
SELECT p.id
FROM public.profiles p
LEFT JOIN public.agent_profiles ap ON ap.profile_id = p.id
WHERE p.role = 'agent'
  AND ap.profile_id IS NULL;

-- Backfill missing codes. The deterministic md5 seed makes reruns stable;
-- the retry loop only runs in the practically-impossible collision case.
DO $$
DECLARE
  r RECORD;
  candidate TEXT;
BEGIN
  FOR r IN
    SELECT profile_id
    FROM public.agent_profiles
    WHERE referral_code IS NULL OR btrim(referral_code) = ''
  LOOP
    -- md5 gives hexadecimal deterministically; translate keeps the code in
    -- the app's unambiguous public alphabet (no 0/O or 1/I/L confusion).
    candidate := 'MOT-' || translate(
      upper(substr(md5(r.profile_id::text || ':motions-agent'), 1, 8)),
      '0123456789ABCDEF', '23456789ABCDEFGH'
    );
    WHILE EXISTS (
      SELECT 1
      FROM public.agent_profiles existing
      WHERE existing.referral_code = candidate
        AND existing.profile_id <> r.profile_id
    ) LOOP
      candidate := 'MOT-' || translate(
        upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8)),
        '0123456789ABCDEF', '23456789ABCDEFGH'
      );
    END LOOP;
    UPDATE public.agent_profiles
    SET referral_code = candidate,
        updated_at = now()
    WHERE profile_id = r.profile_id;
  END LOOP;
END $$;

ALTER TABLE public.agent_profiles
  ALTER COLUMN referral_code SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_agent_profiles_referral_code
  ON public.agent_profiles(referral_code);

-- Website checkouts remember the code the buyer arrived with and the agent
-- it resolved to. An invalid/stale code does not stop a purchase; it simply
-- leaves referral_agent_id NULL while preserving the supplied code for
-- support review.
ALTER TABLE public.checkout_sessions
  ADD COLUMN IF NOT EXISTS referral_code TEXT,
  ADD COLUMN IF NOT EXISTS referral_agent_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_checkout_sessions_referral_agent
  ON public.checkout_sessions(referral_agent_id);
