-- Super Admin login unlocks.
--
-- is_login_locked() intentionally leaves login_attempts readable only to
-- staff, so the unlock action has to run through a checked RPC instead of
-- granting DELETE on the audit table. Clearing failed rows releases the
-- lock while preserving successful sign-ins; the unlock itself is written
-- to activity_log.

CREATE OR REPLACE FUNCTION public.list_locked_logins()
RETURNS TABLE (
  email TEXT,
  profile_id UUID,
  name TEXT,
  role TEXT,
  active BOOLEAN,
  failed_attempts INTEGER,
  last_attempt TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  caller_role TEXT;
BEGIN
  SELECT p.role INTO caller_role
  FROM public.profiles p
  WHERE p.id = auth.uid() AND p.active = TRUE;

  IF caller_role <> 'super_admin' THEN
    RAISE EXCEPTION 'Only an active Super Admin can view locked logins.';
  END IF;

  RETURN QUERY
  WITH recent AS (
    SELECT la.email, la.success, la.ts,
           ROW_NUMBER() OVER (PARTITION BY la.email ORDER BY la.ts DESC) AS attempt_position
    FROM public.login_attempts la
  ), locked AS (
    SELECT r.email,
           COUNT(*) FILTER (WHERE NOT r.success)::INTEGER AS failed_attempts,
           MAX(r.ts) AS last_attempt
    FROM recent r
    WHERE r.attempt_position <= 5
    GROUP BY r.email
    HAVING COUNT(*) = 5 AND BOOL_AND(NOT r.success)
  )
  SELECT l.email, p.id, p.name, p.role, p.active,
         l.failed_attempts, l.last_attempt
  FROM locked l
  LEFT JOIN LATERAL (
    SELECT pr.id, pr.name, pr.role, pr.active
    FROM public.profiles pr
    WHERE lower(pr.email) = l.email
    ORDER BY pr.created_at DESC NULLS LAST
    LIMIT 1
  ) p ON TRUE
  ORDER BY l.last_attempt DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.unlock_login(p_email TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  caller_role TEXT;
  caller_name TEXT;
  normalized TEXT;
  cleared INTEGER;
BEGIN
  SELECT p.role, p.name INTO caller_role, caller_name
  FROM public.profiles p
  WHERE p.id = auth.uid() AND p.active = TRUE;

  IF caller_role <> 'super_admin' THEN
    RAISE EXCEPTION 'Only an active Super Admin can unlock logins.';
  END IF;

  normalized := lower(btrim(COALESCE(p_email, '')));
  IF normalized = '' THEN
    RAISE EXCEPTION 'An account email is required.';
  END IF;

  IF NOT public.is_login_locked(normalized) THEN
    RAISE EXCEPTION 'This account is not currently locked.';
  END IF;

  DELETE FROM public.login_attempts
  WHERE email = normalized AND success = FALSE;
  GET DIAGNOSTICS cleared = ROW_COUNT;

  INSERT INTO public.activity_log (
    actor_id, actor_name, actor_role, action,
    entity_type, entity_id, entity_label, detail, severity
  ) VALUES (
    auth.uid(), caller_name, caller_role, 'login_unlock',
    'account', normalized, normalized,
    'Cleared ' || cleared || ' failed sign-in attempt' || CASE WHEN cleared = 1 THEN '' ELSE 's' END || ' and released the login lock.',
    'notice'
  );

  RETURN cleared;
END;
$$;

REVOKE ALL ON FUNCTION public.list_locked_logins() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.unlock_login(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_locked_logins() TO authenticated;
GRANT EXECUTE ON FUNCTION public.unlock_login(TEXT) TO authenticated;
