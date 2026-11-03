-- Fix: "Database error creating new user" when onboarding an agent.
--
-- That error is Supabase Auth's generic name for "the INSERT into auth.users
-- (including its on_auth_user_created trigger) failed and rolled back".
-- Two independent live-state problems can produce it — both fixed below,
-- idempotently:
--
--  1) profiles_role_check may still be missing 'agent' on live.
--     fix_profiles_role_check_missing_roles.sql documented exactly this
--     symptom: the trigger's profile INSERT violates the CHECK, the auth
--     transaction rolls back, and the caller sees the generic error.
--     Re-asserting the full role list is a no-op if that fix already ran.
--
--  2) handle_new_user() (redefined by fix_username_signin_names.sql) put
--     two non-essential extras on the critical path:
--       - NEW.is_anonymous — a hard record-field reference that throws if
--         the auth schema lacks the column, killing EVERY user creation.
--         Now read via to_jsonb(), which returns NULL for a missing key.
--       - the username assignment — a collision or schema surprise in it
--         should never roll back the whole signup. Moved to a best-effort
--         UPDATE inside an EXCEPTION guard; when it can't run, the account
--         still gets created and an admin assigns the sign-in name later
--         (Staff Management edit → the username field).
--
-- Run this once in the Supabase SQL Editor against the live database.

-- ── 1) Re-assert the complete role list ──────────────────────────────────
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('super_admin','admin','tech_support','claims_officer','policy_admin','finance','client_relations','agent','policyholder','api_partner'));

-- ── 2) Robust handle_new_user: profile row is essential, extras are not ──
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

  -- Primary insert: full detail from metadata. If that fails because the
  -- metadata itself is bad (a role outside the CHECK, a duplicate email),
  -- retry once with only guaranteed-valid values — the table's own
  -- role/department defaults — rather than rolling back the auth user. The
  -- trigger that ran for years only ever wrote these five columns, so
  -- anything beyond them must be optional.
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

  -- Best-effort username = real name. A name already claimed as someone's
  -- username is skipped; ANY other failure here (a schema drift, a race on
  -- the unique index) is swallowed so the account is never half-created.
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

-- ── Verify: the CHECK must list 'agent' among the allowed roles ──────────
SELECT pg_get_constraintdef(oid) AS profiles_role_check
FROM   pg_constraint
WHERE  conrelid = 'public.profiles'::regclass
  AND  conname  = 'profiles_role_check';

-- ── Diagnostic: every non-internal trigger on auth.users ─────────────────
-- Expected: on_auth_user_created (INSERT) and on_auth_user_email_updated
-- (UPDATE). If signups STILL fail after this file, a stray third trigger
-- listed here is the culprit — paste this output when reporting back.
SELECT tgname, tgenabled FROM pg_trigger
WHERE  tgrelid = 'auth.users'::regclass AND NOT tgisinternal;
