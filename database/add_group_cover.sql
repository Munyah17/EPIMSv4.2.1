-- Corporate & Group cover.
--
-- A company, church, union, sports club or similar organisation is
-- registered once as a "group", maintains a roster of members
-- (employees / members), and is issued ONE policy covering the whole
-- roster. Billing stays per head — but the organisation itself is the
-- policyholder, so it is NOT a billed head; only the roster members are
-- charged. That is why the roster lives in its own table rather than
-- being another dependant on a person's policy.
--
-- policies.cover_scope records which kind of policy it is:
--   individual  — the default; the named client is the policyholder and
--                 a billed head, dependants bill on top (unchanged);
--   corporate   — policyholder is an organisation (policies.group_id),
--                 roster members bill per head, documents say EMPLOYEES;
--   group       — same billing as corporate with non-corporate wording
--                 (church/union/club member schemes).
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS public.groups (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT NOT NULL,
  group_type          TEXT NOT NULL CHECK (group_type IN ('company','church','union','sports','club','society','other')),
  registration_number TEXT,
  contact_name        TEXT,
  contact_email       TEXT,
  contact_phone       TEXT,
  address             TEXT,
  active              BOOLEAN NOT NULL DEFAULT true,
  created_by          UUID REFERENCES public.profiles(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.group_members (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  full_name   TEXT NOT NULL,
  national_id TEXT,
  dob         DATE,
  phone       TEXT,
  position    TEXT,               -- job title (corporate) or role in the group
  member_no   TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.policies
  ADD COLUMN IF NOT EXISTS group_id uuid REFERENCES public.groups(id),
  ADD COLUMN IF NOT EXISTS cover_scope text NOT NULL DEFAULT 'individual'
    CHECK (cover_scope IN ('individual','corporate','group'));

CREATE INDEX IF NOT EXISTS idx_group_members_group ON public.group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_policies_group ON public.policies(group_id);

ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.groups FORCE ROW LEVEL SECURITY;
ALTER TABLE public.group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_members FORCE ROW LEVEL SECURITY;

-- Staff-only in v1. The organisation is the policyholder, but portal
-- access for a group contact (viewing the roster, downloading the group
-- certificate) is not built yet — so there are deliberately no
-- *_select_own policies here, and a policyholder login sees nothing.
DROP POLICY IF EXISTS "groups_select" ON public.groups;
CREATE POLICY "groups_select" ON public.groups FOR SELECT TO authenticated USING (is_staff());
DROP POLICY IF EXISTS "groups_write" ON public.groups;
CREATE POLICY "groups_write" ON public.groups FOR ALL TO authenticated USING (is_staff()) WITH CHECK (is_staff());

DROP POLICY IF EXISTS "group_members_select" ON public.group_members;
CREATE POLICY "group_members_select" ON public.group_members FOR SELECT TO authenticated USING (is_staff());
DROP POLICY IF EXISTS "group_members_write" ON public.group_members;
CREATE POLICY "group_members_write" ON public.group_members FOR ALL TO authenticated USING (is_staff()) WITH CHECK (is_staff());
