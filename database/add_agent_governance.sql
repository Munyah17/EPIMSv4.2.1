-- Agent governance: duplicate-account approvals, agent merges, and
-- approved secondary-agent exceptions.
--
-- The app intentionally keeps the retired duplicate profile after a merge.
-- Deleting the auth user would cascade its profile and erase the audit
-- anchor; `merged_into` + `active=false` gives us one usable account while
-- preserving who the old row used to be.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS merged_into UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS merged_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS public.agent_governance_requests (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  request_type        TEXT NOT NULL CHECK (request_type IN ('duplicate_account','merge','client_agent')),
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','rejected','used','cancelled')),
  client_id           UUID REFERENCES public.clients(id) ON DELETE SET NULL,
  current_agent_id    UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  requested_agent_id  UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  merge_source_id     UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  merge_target_id     UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  payload             JSONB NOT NULL DEFAULT '{}'::jsonb,
  reason              TEXT,
  requested_by        UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  requested_by_name   TEXT,
  reviewed_by         UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_by_name    TEXT,
  reviewed_at         TIMESTAMPTZ,
  review_notes        TEXT,
  used_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_governance_status
  ON public.agent_governance_requests(status, request_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_governance_client
  ON public.agent_governance_requests(client_id);
CREATE INDEX IF NOT EXISTS idx_agent_governance_merge
  ON public.agent_governance_requests(merge_source_id, merge_target_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_agent_governance_pending_duplicate
  ON public.agent_governance_requests (request_type, ((payload->>'dedupe_key')))
  WHERE status = 'pending' AND request_type = 'duplicate_account';
CREATE UNIQUE INDEX IF NOT EXISTS ux_agent_governance_pending_client_agent
  ON public.agent_governance_requests (client_id, current_agent_id, requested_agent_id)
  WHERE status = 'pending' AND request_type = 'client_agent';
CREATE UNIQUE INDEX IF NOT EXISTS ux_agent_governance_pending_merge
  ON public.agent_governance_requests (
    (LEAST(merge_source_id::text, merge_target_id::text)),
    (GREATEST(merge_source_id::text, merge_target_id::text))
  )
  WHERE status = 'pending' AND request_type = 'merge';

CREATE TABLE IF NOT EXISTS public.client_agent_overrides (
  client_id    UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  agent_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  request_id   UUID REFERENCES public.agent_governance_requests(id) ON DELETE SET NULL,
  created_by   UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (client_id, agent_id)
);

ALTER TABLE public.agent_governance_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_agent_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_governance_requests_staff_read ON public.agent_governance_requests;
CREATE POLICY agent_governance_requests_staff_read ON public.agent_governance_requests
  FOR SELECT TO authenticated USING (public.is_staff());

DROP POLICY IF EXISTS agent_governance_requests_staff_insert ON public.agent_governance_requests;
CREATE POLICY agent_governance_requests_staff_insert ON public.agent_governance_requests
  FOR INSERT TO authenticated
  WITH CHECK (public.is_staff() AND status = 'pending' AND requested_by = auth.uid());

DROP POLICY IF EXISTS client_agent_overrides_staff_read ON public.client_agent_overrides;
CREATE POLICY client_agent_overrides_staff_read ON public.client_agent_overrides
  FOR SELECT TO authenticated USING (public.is_staff());

CREATE OR REPLACE FUNCTION public.set_agent_governance_requester()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  requester_name TEXT;
BEGIN
  IF NEW.requested_by IS NULL THEN
    NEW.requested_by := auth.uid();
  END IF;
  SELECT name INTO requester_name FROM public.profiles WHERE id = NEW.requested_by;
  NEW.requested_by_name := requester_name;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_governance_request_requester ON public.agent_governance_requests;
CREATE TRIGGER agent_governance_request_requester
  BEFORE INSERT ON public.agent_governance_requests
  FOR EACH ROW EXECUTE PROCEDURE public.set_agent_governance_requester();

DROP TRIGGER IF EXISTS agent_governance_requests_updated_at ON public.agent_governance_requests;
CREATE TRIGGER agent_governance_requests_updated_at
  BEFORE UPDATE ON public.agent_governance_requests
  FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

CREATE OR REPLACE FUNCTION public.client_agent_change_is_approved(
  p_client_id UUID,
  p_current_agent_id UUID,
  p_requested_agent_id UUID
)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.agent_governance_requests r
    WHERE r.status = 'approved'
      AND (
        (
          r.request_type = 'client_agent'
          AND r.client_id = p_client_id
          AND r.current_agent_id = p_current_agent_id
          AND r.requested_agent_id = p_requested_agent_id
          AND COALESCE(r.payload->>'mode', 'secondary') = 'reassign'
        )
        OR (
          r.request_type = 'merge'
          AND r.merge_source_id = p_current_agent_id
          AND r.merge_target_id = p_requested_agent_id
        )
      )
  )
$$;

CREATE OR REPLACE FUNCTION public.guard_client_agent_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.agent_id IS DISTINCT FROM OLD.agent_id
     AND OLD.agent_id IS NOT NULL
     AND NEW.agent_id IS NOT NULL
     AND NOT public.client_agent_change_is_approved(NEW.id, OLD.agent_id, NEW.agent_id) THEN
    RAISE EXCEPTION 'This client is already assigned to an agent. Create and approve an agent-assignment request before changing them.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS clients_agent_change_guard ON public.clients;
CREATE TRIGGER clients_agent_change_guard
  BEFORE UPDATE OF agent_id ON public.clients
  FOR EACH ROW EXECUTE PROCEDURE public.guard_client_agent_change();

CREATE OR REPLACE FUNCTION public.guard_policy_agent()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  primary_agent UUID;
BEGIN
  IF NEW.agent_id IS NULL OR NEW.client_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT agent_id INTO primary_agent
  FROM public.clients
  WHERE id = NEW.client_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Policy client was not found.';
  END IF;

  IF primary_agent IS NULL THEN
    UPDATE public.clients
    SET agent_id = NEW.agent_id
    WHERE id = NEW.client_id AND agent_id IS NULL;
    primary_agent := NEW.agent_id;
  END IF;

  IF primary_agent = NEW.agent_id THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.client_agent_overrides
    WHERE client_id = NEW.client_id AND agent_id = NEW.agent_id
  ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'This client is already assigned to another agent. A secondary-agent approval is required before writing this policy.';
END;
$$;

DROP TRIGGER IF EXISTS policies_agent_guard ON public.policies;
CREATE TRIGGER policies_agent_guard
  BEFORE INSERT OR UPDATE OF client_id, agent_id ON public.policies
  FOR EACH ROW EXECUTE PROCEDURE public.guard_policy_agent();

DO $$
BEGIN
  IF to_regclass('public.pending_policies') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS pending_policies_agent_guard ON public.pending_policies';
    EXECUTE 'CREATE TRIGGER pending_policies_agent_guard
      BEFORE INSERT OR UPDATE OF client_id, agent_id ON public.pending_policies
      FOR EACH ROW EXECUTE PROCEDURE public.guard_policy_agent()';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.review_agent_governance_request(
  request_id UUID,
  decision TEXT,
  review_notes TEXT DEFAULT NULL
)
RETURNS public.agent_governance_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  req public.agent_governance_requests%ROWTYPE;
  caller_role TEXT;
  caller_name TEXT;
  target_file public.agent_profiles%ROWTYPE;
  source_file public.agent_profiles%ROWTYPE;
  ref RECORD;
  moved INTEGER;
  total_moved INTEGER := 0;
  mode TEXT;
  actual_agent UUID;
  requested_role TEXT;
  requested_active BOOLEAN;
  target_active BOOLEAN;
  source_merged UUID;
BEGIN
  SELECT role, name INTO caller_role, caller_name
  FROM public.profiles
  WHERE id = auth.uid() AND active = TRUE;

  IF caller_role IS NULL OR caller_role NOT IN ('admin','super_admin') THEN
    RAISE EXCEPTION 'Only an active Admin or Super Admin can review agent governance requests.';
  END IF;

  IF decision NOT IN ('approved','rejected') THEN
    RAISE EXCEPTION 'Decision must be approved or rejected.';
  END IF;

  SELECT * INTO req
  FROM public.agent_governance_requests
  WHERE id = request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Agent governance request not found.';
  END IF;
  IF req.status <> 'pending' THEN
    RAISE EXCEPTION 'This request has already been reviewed.';
  END IF;

  UPDATE public.agent_governance_requests
  SET status = decision,
      reviewed_by = auth.uid(),
      reviewed_by_name = caller_name,
      reviewed_at = NOW(),
      review_notes = NULLIF(BTRIM(review_notes), '')
  WHERE id = req.id
  RETURNING * INTO req;

  IF decision <> 'approved' THEN
    RETURN req;
  END IF;

  IF req.request_type = 'client_agent' THEN
    IF req.client_id IS NULL OR req.requested_agent_id IS NULL THEN
      RAISE EXCEPTION 'Client-agent approval is missing its client or requested agent.';
    END IF;

    SELECT agent_id INTO actual_agent FROM public.clients WHERE id = req.client_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Client-agent approval client was not found.';
    END IF;
    IF actual_agent IS DISTINCT FROM req.current_agent_id THEN
      RAISE EXCEPTION 'The client''s primary agent changed after this request was created. Reject it and request a fresh review.';
    END IF;
    SELECT role, active INTO requested_role, requested_active
    FROM public.profiles WHERE id = req.requested_agent_id;
    IF requested_role <> 'agent' OR requested_active IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'The requested secondary agent is not an active agent.';
    END IF;

    mode := COALESCE(req.payload->>'mode', 'secondary');
    IF mode = 'reassign' THEN
      UPDATE public.clients
      SET agent_id = req.requested_agent_id
      WHERE id = req.client_id;
    ELSE
      INSERT INTO public.client_agent_overrides (client_id, agent_id, request_id, created_by)
      VALUES (req.client_id, req.requested_agent_id, req.id, auth.uid())
      ON CONFLICT (client_id, agent_id) DO NOTHING;
    END IF;

  ELSIF req.request_type = 'merge' THEN
    IF req.merge_source_id IS NULL OR req.merge_target_id IS NULL OR req.merge_source_id = req.merge_target_id THEN
      RAISE EXCEPTION 'Agent merge requires two different agent accounts.';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = req.merge_source_id AND role = 'agent')
       OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = req.merge_target_id AND role = 'agent') THEN
      RAISE EXCEPTION 'Both merge accounts must be agent profiles.';
    END IF;
    SELECT active INTO target_active FROM public.profiles WHERE id = req.merge_target_id;
    SELECT merged_into INTO source_merged FROM public.profiles WHERE id = req.merge_source_id;
    IF target_active IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'The surviving agent account must be active.';
    END IF;
    IF source_merged IS NOT NULL THEN
      RAISE EXCEPTION 'The source agent has already been merged into another account.';
    END IF;

    SELECT * INTO source_file FROM public.agent_profiles WHERE profile_id = req.merge_source_id;
    SELECT * INTO target_file FROM public.agent_profiles WHERE profile_id = req.merge_target_id;

    IF source_file.profile_id IS NOT NULL AND target_file.profile_id IS NULL THEN
      INSERT INTO public.agent_profiles (
        profile_id, national_id, territory, contract_start, commission_pct,
        bank_name, bank_account, ecocash_number, notes, created_at, updated_at
      )
      VALUES (
        req.merge_target_id, source_file.national_id, source_file.territory,
        source_file.contract_start, source_file.commission_pct, source_file.bank_name,
        source_file.bank_account, source_file.ecocash_number, source_file.notes,
        source_file.created_at, NOW()
      );
    ELSIF source_file.profile_id IS NOT NULL THEN
      UPDATE public.agent_profiles target
      SET national_id = COALESCE(target.national_id, source_file.national_id),
          territory = COALESCE(target.territory, source_file.territory),
          contract_start = COALESCE(target.contract_start, source_file.contract_start),
          commission_pct = COALESCE(target.commission_pct, source_file.commission_pct),
          bank_name = COALESCE(target.bank_name, source_file.bank_name),
          bank_account = COALESCE(target.bank_account, source_file.bank_account),
          ecocash_number = COALESCE(target.ecocash_number, source_file.ecocash_number),
          notes = CASE
            WHEN target.notes IS NULL OR target.notes = '' THEN source_file.notes
            WHEN source_file.notes IS NULL OR source_file.notes = '' OR POSITION(source_file.notes IN target.notes) > 0 THEN target.notes
            ELSE target.notes || E'\n\nMerged duplicate account notes:\n' || source_file.notes
          END,
          updated_at = NOW()
      WHERE target.profile_id = req.merge_target_id;
    END IF;

    -- Core book ownership moves in FK-safe order before the generic
    -- profile-reference sweep: client first, then policies/pending policies.
    UPDATE public.clients
    SET agent_id = req.merge_target_id
    WHERE agent_id = req.merge_source_id;

    UPDATE public.policies
    SET agent_id = req.merge_target_id
    WHERE agent_id = req.merge_source_id;

    IF to_regclass('public.pending_policies') IS NOT NULL THEN
      EXECUTE 'UPDATE public.pending_policies SET agent_id = $1 WHERE agent_id = $2'
      USING req.merge_target_id, req.merge_source_id;
    END IF;

    UPDATE public.claims
    SET agent_id = req.merge_target_id
    WHERE agent_id = req.merge_source_id;

    -- Profile identity (name/email/username) stays on the surviving login;
    -- non-identifying fields are reconciled so nothing useful is lost.
    UPDATE public.profiles target
    SET phone = COALESCE(target.phone, source.phone),
        department = COALESCE(NULLIF(target.department, ''), source.department),
        custom_role_id = COALESCE(target.custom_role_id, source.custom_role_id),
        permissions = COALESCE((
          SELECT array_agg(DISTINCT permission)
          FROM unnest(COALESCE(target.permissions, '{}') || COALESCE(source.permissions, '{}')) AS permission
        ), '{}'),
        last_login = NULLIF(GREATEST(COALESCE(target.last_login, '-infinity'::timestamptz), COALESCE(source.last_login, '-infinity'::timestamptz)), '-infinity'::timestamptz)
    FROM public.profiles source
    WHERE target.id = req.merge_target_id
      AND source.id = req.merge_source_id;

    FOR ref IN
      SELECT kcu.table_schema, kcu.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
       AND tc.table_name = kcu.table_name
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name
       AND tc.table_schema = ccu.constraint_schema
       AND tc.table_name = ccu.table_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND ccu.table_schema = 'public'
        AND ccu.table_name = 'profiles'
        AND ccu.column_name = 'id'
        AND kcu.table_schema = 'public'
        AND kcu.table_name NOT IN ('profiles','agent_profiles','agent_governance_requests','client_agent_overrides')
    LOOP
      EXECUTE format('UPDATE %I.%I SET %I = $1 WHERE %I = $2',
        ref.table_schema, ref.table_name, ref.column_name, ref.column_name)
      USING req.merge_target_id, req.merge_source_id;
      GET DIAGNOSTICS moved = ROW_COUNT;
      total_moved := total_moved + moved;
    END LOOP;

    INSERT INTO public.client_agent_overrides (client_id, agent_id, request_id, created_by)
    SELECT client_id, req.merge_target_id, req.id, auth.uid()
    FROM public.client_agent_overrides
    WHERE agent_id = req.merge_source_id
    ON CONFLICT (client_id, agent_id) DO NOTHING;
    DELETE FROM public.client_agent_overrides WHERE agent_id = req.merge_source_id;

    UPDATE public.profiles
    SET active = FALSE,
        merged_into = req.merge_target_id,
        merged_at = NOW()
    WHERE id = req.merge_source_id;

    UPDATE public.agent_governance_requests
    SET payload = payload || jsonb_build_object(
          'reassignedReferences', total_moved,
          'mergedAt', NOW()
        )
    WHERE id = req.id
    RETURNING * INTO req;
  END IF;

  RETURN req;
END;
$$;

REVOKE ALL ON FUNCTION public.review_agent_governance_request(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.review_agent_governance_request(UUID, TEXT, TEXT) TO authenticated;
