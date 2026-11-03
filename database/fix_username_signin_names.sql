-- Fix: name-based sign-in for accounts whose `username` is not their real
-- full name.
--
-- resolve_login_email() authenticates "name" logins by matching
-- profiles.username — not profiles.name. Three populations fail that match:
--   1. Backfilled accounts — add_username_field.sql and
--      reset_default_usernames.sql stamped generated usernames
--      ("Admin 1", "Agent 1", "User 1"), so typing the real name resolves
--      nothing and every sign-in fails regardless of password. (This was the
--      reported "password reset succeeds but doesn't take effect" symptom:
--      the reset lands on auth.users, but the name never resolves.)
--   2. username IS NULL — handle_new_user() never wrote a username, so every
--      auth user created through a trigger-only path (website self-signup via
--      motions-website's provision.ts) has no sign-in name at all.
--   3. Drifted rows — any profile edited outside db.staff.update's
--      username=name sync.
--
-- Fix: set username = name wherever they differ (case-insensitive). Rows are
-- SKIPPED, not broken, when the name is empty/NULL, already claimed as
-- another profile's username, or shared by another person's profile — the
-- unique index on lower(username) would reject those anyway, and two people
-- who genuinely share a name can't both use it as a sign-in. The report
-- queries at the bottom list every skipped row for manual assignment.
--
-- handle_new_user() is redefined so NEW accounts get username = name at
-- creation — the upstream leak that produced population 2.
--
-- Run this once in the Supabase SQL Editor against the live database.
-- Safe to re-run: already-matching rows are untouched, so a second run only
-- updates whatever is still mismatched.

-- ── Preview: rows the UPDATE below will SKIP (need a hand-picked username) ──
SELECT p.id, p.name, p.username, p.role,
       CASE WHEN btrim(coalesce(p.name,'')) = '' THEN 'empty name'
            ELSE 'name/username collision' END AS skip_reason
FROM   public.profiles p
WHERE  (p.username IS NULL OR lower(p.username) <> lower(btrim(coalesce(p.name,''))))
  AND  (
         btrim(coalesce(p.name,'')) = ''
         OR EXISTS (
           SELECT 1 FROM public.profiles q
           WHERE  q.id <> p.id
             AND  ( lower(btrim(coalesce(q.name,''))) = lower(btrim(p.name))
                 OR lower(coalesce(q.username,''))  = lower(btrim(p.name)) )
         )
       )
ORDER BY p.role, p.name;

-- ── The fix: username = real name for every unambiguous row ────────────────
UPDATE public.profiles p
SET    username = btrim(p.name)
WHERE  btrim(coalesce(p.name,'')) <> ''
  AND  (p.username IS NULL OR lower(p.username) <> lower(btrim(p.name)))
  AND  NOT EXISTS (
         SELECT 1 FROM public.profiles q
         WHERE  q.id <> p.id
           AND  ( lower(btrim(coalesce(q.name,''))) = lower(btrim(p.name))
               OR lower(coalesce(q.username,''))  = lower(btrim(p.name)) )
       );

-- ── Upstream leak: new auth users must get username = name at creation ─────
-- Robust version — same as fix_agent_onboarding_db_error.sql. The profile
-- row is essential and stays strict; the extras (is_anonymous check,
-- username assignment) are best-effort so they can never roll back a signup.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_name TEXT;
BEGIN
  -- Anonymous sign-ins (live chat visitors) have no email and don't need a
  -- staff/policyholder profile row. Read through to_jsonb() rather than
  -- NEW.is_anonymous directly so an auth.users table without that column
  -- can't take down user creation.
  IF COALESCE((to_jsonb(NEW) ->> 'is_anonymous')::boolean, false) THEN
    RETURN NEW;
  END IF;
  -- profiles.name is NOT NULL: phone-only signups (no email, no name
  -- metadata) used to crash here — a 'New User' placeholder beats a
  -- rolled-back account.
  v_name := COALESCE(NULLIF(btrim(NEW.raw_user_meta_data->>'name'), ''),
                     NULLIF(split_part(COALESCE(NEW.email, ''), '@', 1), ''),
                     'New User');

  -- If the metadata itself is bad (a role outside the CHECK, a duplicate
  -- email) retry once with only guaranteed-valid values rather than
  -- rolling back the auth user.
  BEGIN
    INSERT INTO public.profiles (id, name, role, department, email)
    VALUES (
      NEW.id,
      v_name,
      COALESCE(NEW.raw_user_meta_data->>'role', 'policy_admin'),
      COALESCE(NEW.raw_user_meta_data->>'department', 'Administration'),
      NEW.email
    )
    ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.profiles (id, name, email)
    VALUES (NEW.id, v_name, NEW.email)
    ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email;
  END;

  -- Best-effort username = real name. A claimed name is skipped; any other
  -- failure is swallowed so the account is never half-created.
  BEGIN
    IF v_name <> '' AND NOT EXISTS (
      SELECT 1 FROM public.profiles q WHERE lower(q.username) = lower(v_name)
    ) THEN
      UPDATE public.profiles SET username = v_name WHERE id = NEW.id;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN NEW;
END;
$$;

-- ── Verify: only the collisions listed in the preview should remain ────────
SELECT id, name, username, role
FROM   public.profiles
WHERE  username IS NULL
   OR  lower(username) <> lower(btrim(coalesce(name,'')))
ORDER BY role, name;
