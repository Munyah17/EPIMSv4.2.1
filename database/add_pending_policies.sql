-- ================================================================
-- PENDING POLICIES TABLE
-- Holds policy data during payment collection phase.
-- Only successfully paid policies are moved to the main policies table.
-- Failed or stale pending policies are automatically cleaned up.
-- ================================================================

CREATE TABLE IF NOT EXISTS public.pending_policies (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  policy_number     TEXT NOT NULL UNIQUE,
  client_id         UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  product_id        UUID NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  premium           NUMERIC(10,2) NOT NULL,
  cover_amount      NUMERIC(14,2) NOT NULL,
  start_date        DATE NOT NULL,
  end_date          DATE NOT NULL,
  dependants        JSONB NOT NULL DEFAULT '[]',
  payment_method    TEXT NOT NULL,
  source            TEXT NOT NULL DEFAULT 'portal',
  grower_number     TEXT,
  contractor        TEXT,
  hectarage         NUMERIC(10,2),
  agent_id          UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  group_name        TEXT,
  group_type        TEXT,
  cover_scope       TEXT CHECK (cover_scope IN ('individual','group','corporate','team')),
  team_activity     TEXT,
  has_chronic_illness BOOLEAN,
  chronic_illness_details TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_pending_policies_client ON public.pending_policies(client_id);
CREATE INDEX IF NOT EXISTS idx_pending_policies_status ON public.pending_policies(created_at);
CREATE INDEX IF NOT EXISTS idx_pending_policies_reference ON public.pending_policies(policy_number);

-- RLS - only service role should write, staff can read for debugging
ALTER TABLE public.pending_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pending_policies FORCE ROW LEVEL SECURITY;

CREATE POLICY "pending_policies_select_staff" ON public.pending_policies FOR SELECT TO authenticated USING (is_staff());
CREATE POLICY "pending_policies_write_service" ON public.pending_policies FOR ALL TO authenticated
  USING (current_user_role() = 'super_admin')
  WITH CHECK (current_user_role() = 'super_admin');

-- Auto-update updated_at
CREATE TRIGGER pending_policies_updated_at BEFORE UPDATE ON public.pending_policies
  FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

-- Function to move a pending policy to the main policies table
CREATE OR REPLACE FUNCTION public.finalize_pending_policy(pending_id UUID)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  new_policy_id UUID;
BEGIN
  -- Insert into main policies table
  INSERT INTO public.policies (
    policy_number, client_id, product_id, premium, cover_amount,
    start_date, end_date, dependants, payment_method, source,
    grower_number, agent_id, status, created_at, updated_at
  )
  SELECT 
    policy_number, client_id, product_id, premium, cover_amount,
    start_date, end_date, dependants, payment_method, source,
    grower_number, agent_id, 'active', NOW(), NOW()
  FROM public.pending_policies
  WHERE id = pending_id
  RETURNING id INTO new_policy_id;

  -- Delete from pending_policies
  DELETE FROM public.pending_policies WHERE id = pending_id;

  RETURN new_policy_id;
END;
$$;

-- Function to clean up stale pending policies (older than 24 hours)
CREATE OR REPLACE FUNCTION public.cleanup_stale_pending_policies()
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  deleted_count INT;
BEGIN
  DELETE FROM public.pending_policies 
  WHERE created_at < NOW() - INTERVAL '24 hours';
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

-- Grant execute permissions
REVOKE ALL ON FUNCTION public.finalize_pending_policy(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_pending_policy(UUID) TO authenticated;

REVOKE ALL ON FUNCTION public.cleanup_stale_pending_policies() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cleanup_stale_pending_policies() TO authenticated;
