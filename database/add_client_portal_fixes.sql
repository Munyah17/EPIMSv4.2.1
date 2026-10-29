-- Client portal fixes, two parts:
--
-- 1. profiles.client_id — a STABLE link from a policyholder login to its
--    client record. RLS still binds reads by email equality
--    (clients_select_own / owns_policy), which means every change of the
--    client's email silently orphans the account until it is re-bound.
--    The provisioning endpoint (api/client-portal-account.ts) uses this
--    column to find the account that must be re-bound after an email
--    change — matching by name would guess wrong whenever two clients
--    share one.
--
-- 2. Per-user notification preferences — Profile > Notifications is shown
--    to policyholders too, but app_settings was staff-select/admin-write
--    only, so a client's save was silently rejected. These policies let any
--    signed-in user read/write ONLY their own notif_prefs_<their-uid> key;
--    the broader staff policies are untouched.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES public.clients(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_profiles_client_id
  ON public.profiles (client_id) WHERE client_id IS NOT NULL;

-- client_id is bookkeeping for re-binding — a policyholder editing their
-- own row must not be able to point it at someone else's client record.
CREATE OR REPLACE FUNCTION public.lock_privileged_profile_fields_on_self_update()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF auth.uid() = OLD.id THEN
    NEW.role        := OLD.role;
    NEW.active      := OLD.active;
    NEW.permissions := OLD.permissions;
    NEW.department  := OLD.department;
    NEW.client_id   := OLD.client_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lock_privileged_profile_fields ON public.profiles;
CREATE TRIGGER trg_lock_privileged_profile_fields
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.lock_privileged_profile_fields_on_self_update();

CREATE POLICY "app_settings_prefs_own_select" ON public.app_settings
  FOR SELECT TO authenticated
  USING (key = 'notif_prefs_' || auth.uid()::text);

CREATE POLICY "app_settings_prefs_own_write" ON public.app_settings
  FOR ALL TO authenticated
  USING (key = 'notif_prefs_' || auth.uid()::text)
  WITH CHECK (key = 'notif_prefs_' || auth.uid()::text);
