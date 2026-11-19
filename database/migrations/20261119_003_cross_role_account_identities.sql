-- Cross-role account identities.
--
-- One person may be a customer and an agent/staff member. profiles.email must
-- stay equal to auth.users.email for resolve_login_email; a shared personal
-- address therefore belongs in contact_email on the secondary account. The
-- internal auth address stays hidden from the staff list.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS contact_email TEXT;
CREATE INDEX IF NOT EXISTS idx_profiles_contact_email
  ON public.profiles(contact_email);

-- Older placeholder-auth accounts had profiles.email cleared so the internal
-- address would not display. That also broke name-based sign-in because
-- resolve_login_email reads profiles.email. Restore the auth mirror here;
-- the app hides *.motions.local values in staff lists.
UPDATE public.profiles p
SET email = u.email
FROM auth.users u
WHERE p.id = u.id
  AND p.email IS NULL
  AND u.email LIKE '%.motions.local';

-- Backfill sign-in names for account rows left NULL when a cross-role
-- display name was already taken. Aliases stay role-scoped so
-- "Justice Choga" and "Justice Choga (Agent)" can coexist safely.
DO $$
DECLARE
  r RECORD;
  suffix TEXT;
  base TEXT;
  candidate TEXT;
  i INT;
BEGIN
  FOR r IN
    SELECT id, name, role
    FROM public.profiles
    WHERE username IS NULL
      AND btrim(coalesce(name, '')) <> ''
  LOOP
    suffix := CASE
      WHEN r.role = 'agent' THEN 'Agent'
      WHEN r.role = 'policyholder' THEN 'Client'
      WHEN r.role IN ('super_admin', 'admin', 'tech_support') THEN 'Admin'
      ELSE 'Staff'
    END;
    candidate := btrim(r.name);
    IF EXISTS (SELECT 1 FROM public.profiles q WHERE q.id <> r.id AND lower(q.username) = lower(candidate)) THEN
      base := btrim(r.name) || ' (' || suffix || ')';
      candidate := base;
      i := 2;
      WHILE EXISTS (SELECT 1 FROM public.profiles q WHERE q.id <> r.id AND lower(q.username) = lower(candidate)) LOOP
        candidate := base || ' ' || i;
        i := i + 1;
      END LOOP;
    END IF;
    UPDATE public.profiles SET username = candidate WHERE id = r.id;
  END LOOP;
END $$;
