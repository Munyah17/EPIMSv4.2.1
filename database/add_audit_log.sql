-- audit_log: a persistent record of administrative edits and changes.
-- Super admins and authorised staff must be able to edit anything on a client
-- or policy, but every change is logged for accountability and traceability.
-- This table survives database restores and gives a clear trail of who changed
-- what, when, and the before/after values.

CREATE TABLE IF NOT EXISTS public.audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),

  -- Who made the change. References profiles (the actual login identity).
  operator_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE SET NULL,

  -- What was changed: the entity type and its database ID.
  entity_type text NOT NULL CHECK (entity_type IN ('client', 'policy', 'policy_dependant', 'product', 'staff', 'agent', 'system')),
  entity_id uuid NOT NULL,

  -- A readable description of what changed (e.g. "Edited client phone").
  action text NOT NULL,

  -- The before/after JSON values. For simple field edits, this is
  -- { fieldName: { old: ..., new: ... } }. For more complex changes,
  -- it captures the relevant subset of the row before and after.
  changes jsonb NOT NULL,

  -- Where the change originated (web portal, API, bot, system job, etc.).
  source text NOT NULL DEFAULT 'web' CHECK (source IN ('web', 'api', 'bot', 'system', 'import')),

  -- Optional context notes (e.g. "Client request via phone").
  notes text
);

-- Index for quick lookups by entity (e.g. "show all changes to this client").
CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON public.audit_log(entity_type, entity_id, created_at DESC);

-- Index for operator audit trails (e.g. "show all changes made by this user").
CREATE INDEX IF NOT EXISTS audit_log_operator_idx ON public.audit_log(operator_id, created_at DESC);

-- Enable RLS: staff can read audit logs but only super_admin/admin can write.
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

-- Staff with system roles can read audit logs for their entities.
CREATE POLICY "Staff can read audit logs"
  ON public.audit_log FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('super_admin', 'admin', 'tech_support', 'claims_officer', 'policy_admin', 'finance', 'client_relations', 'agent')
    )
  );

-- Only super_admin and admin can write audit logs (writes happen server-side
-- via auditLog() in api/_lib/audit.ts; this policy is a safety net).
CREATE POLICY "Only super_admin and admin can write audit logs"
  ON public.audit_log FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('super_admin', 'admin')
    )
  );
