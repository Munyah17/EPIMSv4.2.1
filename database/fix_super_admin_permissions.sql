-- Every super_admin account must carry all permissions.
--
-- /api/create-account already writes ['all'] for NEW super_admins, but
-- older accounts and PermissionsModal edits left some profiles with
-- divergent arrays — those accounts lost gated features (Add Product
-- etc.). Two layers:
--
--  1. Backfill: any super_admin missing the 'all' sentinel gets it.
--  2. Enforce: a BEFORE INSERT/UPDATE trigger keeps permissions = '{all}'
--     for every super_admin row, so no future write path (modal, SQL,
--     promotion) can strip it again. The client also normalizes on read
--     (db.toProfile) and short-circuits in hasPermission — this trigger
--     is the storage-level guarantee.

UPDATE public.profiles
SET permissions = '{all}'
WHERE role = 'super_admin'
  AND (permissions IS NULL OR NOT ('all' = ANY(permissions)));

CREATE OR REPLACE FUNCTION public.enforce_super_admin_permissions()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role = 'super_admin' THEN
    NEW.permissions := '{all}';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_super_admin_permissions ON public.profiles;
CREATE TRIGGER trg_super_admin_permissions
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_super_admin_permissions();
