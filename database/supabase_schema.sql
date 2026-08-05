-- ================================================================
-- TARIQIFY IMS — Supabase Schema + Seed
-- Run this entire file in your Supabase SQL Editor
-- Project: https://iovcahedkzxobdgfkdwg.supabase.co
-- ================================================================

-- ----------------------------------------------------------------
-- 1. EXTENSIONS
-- ----------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ----------------------------------------------------------------
-- 2. TABLES
-- ----------------------------------------------------------------

-- Profiles (extends auth.users — one row per authenticated user)
CREATE TABLE IF NOT EXISTS public.profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  email       TEXT,
  role        TEXT NOT NULL DEFAULT 'policy_admin'
                CHECK (role IN ('super_admin','admin','claims_officer','policy_admin','finance','client_relations','policyholder')),
  department  TEXT NOT NULL DEFAULT 'Administration',
  phone       TEXT,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  permissions TEXT[] NOT NULL DEFAULT '{}',
  last_login  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Clients (insured persons / policyholders)
CREATE TABLE IF NOT EXISTS public.clients (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        TEXT NOT NULL,
  email       TEXT,
  phone       TEXT NOT NULL,
  national_id TEXT NOT NULL UNIQUE,
  dob         DATE,
  address     TEXT,
  occupation  TEXT,
  insurer     TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Products (insurance products)
CREATE TABLE IF NOT EXISTS public.products (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                TEXT NOT NULL,
  code                TEXT NOT NULL UNIQUE,
  category            TEXT NOT NULL CHECK (category IN ('life','funeral','health','accident','motor','property')),
  premium             NUMERIC(10,2) NOT NULL,
  cover_amount        NUMERIC(14,2) NOT NULL,
  waiting_period_days INT NOT NULL DEFAULT 30,
  min_age             INT NOT NULL DEFAULT 18,
  max_age             INT NOT NULL DEFAULT 70,
  commission_pct      NUMERIC(5,2) NOT NULL DEFAULT 15,
  active              BOOLEAN NOT NULL DEFAULT TRUE,
  features            TEXT[] NOT NULL DEFAULT '{}',
  description         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Policies
CREATE TABLE IF NOT EXISTS public.policies (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  policy_number     TEXT NOT NULL UNIQUE,
  client_id         UUID NOT NULL REFERENCES public.clients(id) ON DELETE RESTRICT,
  product_id        UUID NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  premium           NUMERIC(10,2) NOT NULL,
  cover_amount      NUMERIC(14,2) NOT NULL,
  start_date        DATE NOT NULL,
  end_date          DATE NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','lapsed','cancelled','pending','expired')),
  beneficiaries     JSONB NOT NULL DEFAULT '[]',
  payment_method    TEXT NOT NULL,
  insurer           TEXT,
  agent_id          UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  next_payment_date DATE,
  last_payment_date DATE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Claims
CREATE TABLE IF NOT EXISTS public.claims (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  claim_number   TEXT NOT NULL UNIQUE,
  policy_id      UUID NOT NULL REFERENCES public.policies(id) ON DELETE RESTRICT,
  claim_type     TEXT NOT NULL,
  amount         NUMERIC(14,2) NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','under_review','approved','rejected','paid')),
  date_of_event  DATE NOT NULL,
  date_submitted DATE NOT NULL DEFAULT CURRENT_DATE,
  description    TEXT,
  fraud_score    INT NOT NULL DEFAULT 0 CHECK (fraud_score BETWEEN 0 AND 100),
  assigned_to    UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  documents      TEXT[] NOT NULL DEFAULT '{}',
  notes          TEXT,
  resolved_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Payments
CREATE TABLE IF NOT EXISTS public.payments (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reference      TEXT NOT NULL UNIQUE,
  policy_id      UUID NOT NULL REFERENCES public.policies(id) ON DELETE RESTRICT,
  amount         NUMERIC(10,2) NOT NULL,
  method         TEXT NOT NULL CHECK (method IN ('EcoCash','OneMoney','InnBucks','Bank Transfer','Cash','Debit Order')),
  status         TEXT NOT NULL DEFAULT 'completed'
                   CHECK (status IN ('completed','pending','failed','reversed')),
  payment_date   DATE NOT NULL DEFAULT CURRENT_DATE,
  split_payments JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tickets
CREATE TABLE IF NOT EXISTS public.tickets (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ticket_number TEXT NOT NULL UNIQUE,
  client_id     UUID NOT NULL REFERENCES public.clients(id) ON DELETE RESTRICT,
  subject       TEXT NOT NULL,
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','in_progress','resolved','closed')),
  priority      TEXT NOT NULL DEFAULT 'medium'
                  CHECK (priority IN ('low','medium','high','urgent')),
  category      TEXT NOT NULL DEFAULT 'General',
  assigned_to   UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  messages      JSONB NOT NULL DEFAULT '[]',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Emails (bi-directional email store)
CREATE TABLE IF NOT EXISTS public.emails (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  from_address TEXT NOT NULL,
  from_name    TEXT,
  to_address   TEXT NOT NULL,
  subject      TEXT NOT NULL,
  body         TEXT,
  read         BOOLEAN NOT NULL DEFAULT FALSE,
  folder       TEXT NOT NULL DEFAULT 'inbox' CHECK (folder IN ('inbox','sent','draft')),
  linked_to    TEXT,
  attachments  TEXT[] NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Leads
CREATE TABLE IF NOT EXISTS public.leads (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name             TEXT NOT NULL,
  email            TEXT,
  phone            TEXT NOT NULL,
  source           TEXT,
  product_interest TEXT,
  status           TEXT NOT NULL DEFAULT 'new'
                     CHECK (status IN ('new','contacted','qualified','proposal','converted','lost')),
  intent_score     INT NOT NULL DEFAULT 50 CHECK (intent_score BETWEEN 0 AND 100),
  assigned_to      UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  last_contact     DATE,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fraud Cases
CREATE TABLE IF NOT EXISTS public.fraud_cases (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  claim_id    UUID NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  fraud_score INT NOT NULL CHECK (fraud_score BETWEEN 0 AND 100),
  signals     TEXT[] NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','investigating','confirmed','cleared')),
  assigned_to UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  notes       TEXT,
  resolved_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Reminders
CREATE TABLE IF NOT EXISTS public.reminders (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  type          TEXT NOT NULL
                  CHECK (type IN ('payment_due','policy_renewal','claim_followup','birthday','document_expiry')),
  client_id     UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  policy_id     UUID REFERENCES public.policies(id) ON DELETE CASCADE,
  due_date      DATE NOT NULL,
  message       TEXT,
  sent          BOOLEAN NOT NULL DEFAULT FALSE,
  channel       TEXT NOT NULL CHECK (channel IN ('sms','whatsapp','email','ussd')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------
-- 3. INDEXES (for common queries)
-- ----------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_policies_client    ON public.policies(client_id);
CREATE INDEX IF NOT EXISTS idx_policies_status    ON public.policies(status);
CREATE INDEX IF NOT EXISTS idx_claims_policy      ON public.claims(policy_id);
CREATE INDEX IF NOT EXISTS idx_claims_status      ON public.claims(status);
CREATE INDEX IF NOT EXISTS idx_payments_policy    ON public.payments(policy_id);
CREATE INDEX IF NOT EXISTS idx_payments_date      ON public.payments(payment_date);
CREATE INDEX IF NOT EXISTS idx_leads_status       ON public.leads(status);
CREATE INDEX IF NOT EXISTS idx_tickets_status     ON public.tickets(status);
CREATE INDEX IF NOT EXISTS idx_fraud_cases_claim  ON public.fraud_cases(claim_id);
CREATE INDEX IF NOT EXISTS idx_policies_agent     ON public.policies(agent_id);
CREATE INDEX IF NOT EXISTS idx_claims_assigned    ON public.claims(assigned_to);
CREATE INDEX IF NOT EXISTS idx_leads_assigned     ON public.leads(assigned_to);
CREATE INDEX IF NOT EXISTS idx_tickets_client     ON public.tickets(client_id);
CREATE INDEX IF NOT EXISTS idx_profiles_role      ON public.profiles(role);
CREATE INDEX IF NOT EXISTS idx_profiles_active    ON public.profiles(active);

-- ----------------------------------------------------------------
-- 4. TRIGGERS — auto-create profile + auto-update timestamps
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Anonymous sign-ins (live chat visitors) have no email and don't need a
  -- staff/policyholder profile row.
  IF NEW.is_anonymous THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.profiles (id, name, role, department, email)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1)),
    COALESCE(NEW.raw_user_meta_data->>'role', 'policy_admin'),
    COALESCE(NEW.raw_user_meta_data->>'department', 'Administration'),
    NEW.email
  )
  ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- Keep profiles.email in sync if the auth email changes later.
CREATE OR REPLACE FUNCTION public.sync_profile_email()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    UPDATE public.profiles SET email = NEW.email WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_email_updated ON auth.users;
CREATE TRIGGER on_auth_user_email_updated
  AFTER UPDATE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.sync_profile_email();

-- Auto-update updated_at columns
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER clients_updated_at BEFORE UPDATE ON public.clients
  FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();
CREATE TRIGGER policies_updated_at BEFORE UPDATE ON public.policies
  FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();
CREATE TRIGGER tickets_updated_at BEFORE UPDATE ON public.tickets
  FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

-- ----------------------------------------------------------------
-- 5. ROW LEVEL SECURITY (v2 — improved for robustness)
-- ----------------------------------------------------------------
ALTER TABLE public.profiles    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clients     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.policies    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claims      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tickets     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.emails      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leads       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fraud_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reminders   ENABLE ROW LEVEL SECURITY;

-- Force RLS even for table owners
ALTER TABLE public.profiles    FORCE ROW LEVEL SECURITY;
ALTER TABLE public.clients     FORCE ROW LEVEL SECURITY;
ALTER TABLE public.products    FORCE ROW LEVEL SECURITY;
ALTER TABLE public.policies    FORCE ROW LEVEL SECURITY;
ALTER TABLE public.claims      FORCE ROW LEVEL SECURITY;
ALTER TABLE public.payments    FORCE ROW LEVEL SECURITY;
ALTER TABLE public.tickets     FORCE ROW LEVEL SECURITY;
ALTER TABLE public.emails      FORCE ROW LEVEL SECURITY;
ALTER TABLE public.leads       FORCE ROW LEVEL SECURITY;
ALTER TABLE public.fraud_cases FORCE ROW LEVEL SECURITY;
ALTER TABLE public.reminders   FORCE ROW LEVEL SECURITY;

-- Helper: get current user's role (safe default — never NULL)
CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT COALESCE(role, '') FROM public.profiles WHERE id = auth.uid()
$$;

-- Helper: is current user a staff member? (returns FALSE if no profile)
CREATE OR REPLACE FUNCTION public.is_staff()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT COALESCE(
    (SELECT role IN ('super_admin','admin','claims_officer','policy_admin','finance','client_relations')
     FROM public.profiles WHERE id = auth.uid()),
    FALSE
  )
$$;

-- Helper: is current user an admin?
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT COALESCE(
    (SELECT role IN ('super_admin','admin')
     FROM public.profiles WHERE id = auth.uid()),
    FALSE
  )
$$;

-- Current user's auth email. SECURITY DEFINER so RLS policies can compare
-- against it without needing a direct grant on auth.users (the
-- `authenticated` role has none — a plain policy querying auth.users
-- directly breaks every query that touches the policy's table).
CREATE OR REPLACE FUNCTION public.current_user_email()
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT email FROM auth.users WHERE id = auth.uid()
$$;

-- Helper: does current user own a specific policy?
CREATE OR REPLACE FUNCTION public.owns_policy(check_policy_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.policies p
    JOIN public.clients c ON c.id = p.client_id
    WHERE p.id = check_policy_id
      AND c.email = (SELECT email FROM auth.users WHERE id = auth.uid())
  )
$$;

-- Profiles
CREATE POLICY "profiles_select" ON public.profiles FOR SELECT TO authenticated USING (true);
CREATE POLICY "profiles_update_own" ON public.profiles FOR UPDATE TO authenticated USING (id = auth.uid());
CREATE POLICY "profiles_update_admin" ON public.profiles FOR UPDATE TO authenticated USING (is_admin());
CREATE POLICY "profiles_delete_super" ON public.profiles FOR DELETE TO authenticated USING (current_user_role() = 'super_admin');
CREATE POLICY "profiles_insert_trigger" ON public.profiles FOR INSERT TO authenticated WITH CHECK (true);

-- RLS only filters which ROWS a policy applies to, not which columns —
-- without this trigger, profiles_update_own would let any user change their
-- own role/active/permissions/department (privilege escalation). Self-edits
-- keep those fields locked; only an admin editing SOMEONE ELSE's row
-- (matched by profiles_update_admin) can change them.
CREATE OR REPLACE FUNCTION public.lock_privileged_profile_fields_on_self_update()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF auth.uid() = OLD.id THEN
    NEW.role        := OLD.role;
    NEW.active       := OLD.active;
    NEW.permissions  := OLD.permissions;
    NEW.department   := OLD.department;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lock_privileged_profile_fields ON public.profiles;
CREATE TRIGGER trg_lock_privileged_profile_fields
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.lock_privileged_profile_fields_on_self_update();

-- Clients
CREATE POLICY "clients_select_staff" ON public.clients FOR SELECT TO authenticated USING (is_staff());
CREATE POLICY "clients_select_own" ON public.clients FOR SELECT TO authenticated USING (
  email = public.current_user_email()
);
CREATE POLICY "clients_insert" ON public.clients FOR INSERT TO authenticated WITH CHECK (is_staff());
CREATE POLICY "clients_update" ON public.clients FOR UPDATE TO authenticated USING (is_staff());
CREATE POLICY "clients_delete_admin" ON public.clients FOR DELETE TO authenticated USING (is_admin());

-- Products
CREATE POLICY "products_select" ON public.products FOR SELECT TO authenticated USING (true);
CREATE POLICY "products_write" ON public.products FOR ALL TO authenticated USING (is_staff()) WITH CHECK (is_staff());

-- Policies
CREATE POLICY "policies_select_staff" ON public.policies FOR SELECT TO authenticated USING (is_staff());
CREATE POLICY "policies_select_own" ON public.policies FOR SELECT TO authenticated USING (
  EXISTS (
    SELECT 1 FROM public.clients c
    WHERE c.id = client_id
      AND c.email = public.current_user_email()
  )
);
CREATE POLICY "policies_write" ON public.policies FOR ALL TO authenticated USING (is_staff()) WITH CHECK (is_staff());
CREATE POLICY "policies_delete_admin" ON public.policies FOR DELETE TO authenticated USING (is_admin());

-- Claims
CREATE POLICY "claims_select_staff" ON public.claims FOR SELECT TO authenticated USING (is_staff());
CREATE POLICY "claims_write" ON public.claims FOR ALL TO authenticated
  USING (current_user_role() IN ('super_admin','admin','claims_officer'))
  WITH CHECK (current_user_role() IN ('super_admin','admin','claims_officer'));
CREATE POLICY "claims_delete_admin" ON public.claims FOR DELETE TO authenticated USING (is_admin());

-- Payments
CREATE POLICY "payments_select_staff" ON public.payments FOR SELECT TO authenticated USING (is_staff());
CREATE POLICY "payments_write" ON public.payments FOR ALL TO authenticated
  USING (current_user_role() IN ('super_admin','admin','finance'))
  WITH CHECK (current_user_role() IN ('super_admin','admin','finance'));
CREATE POLICY "payments_delete_admin" ON public.payments FOR DELETE TO authenticated USING (is_admin());

-- Tickets
CREATE POLICY "tickets_select" ON public.tickets FOR SELECT TO authenticated USING (is_staff());
CREATE POLICY "tickets_write" ON public.tickets FOR ALL TO authenticated
  USING (current_user_role() IN ('super_admin','admin','client_relations'))
  WITH CHECK (current_user_role() IN ('super_admin','admin','client_relations'));
CREATE POLICY "tickets_delete_admin" ON public.tickets FOR DELETE TO authenticated USING (is_admin());

-- Emails
CREATE POLICY "emails_select" ON public.emails FOR SELECT TO authenticated USING (is_staff());
CREATE POLICY "emails_write" ON public.emails FOR ALL TO authenticated USING (is_staff()) WITH CHECK (is_staff());
CREATE POLICY "emails_delete" ON public.emails FOR DELETE TO authenticated USING (is_staff());

-- Leads
CREATE POLICY "leads_select" ON public.leads FOR SELECT TO authenticated USING (is_staff());
CREATE POLICY "leads_write" ON public.leads FOR ALL TO authenticated USING (is_staff()) WITH CHECK (is_staff());
CREATE POLICY "leads_delete" ON public.leads FOR DELETE TO authenticated USING (is_staff());

-- Fraud Cases
CREATE POLICY "fraud_select" ON public.fraud_cases FOR SELECT TO authenticated
  USING (current_user_role() IN ('super_admin','admin','claims_officer'));
CREATE POLICY "fraud_write" ON public.fraud_cases FOR ALL TO authenticated
  USING (current_user_role() IN ('super_admin','admin','claims_officer'))
  WITH CHECK (current_user_role() IN ('super_admin','admin','claims_officer'));
CREATE POLICY "fraud_delete" ON public.fraud_cases FOR DELETE TO authenticated USING (is_admin());

-- Reminders
CREATE POLICY "reminders_select" ON public.reminders FOR SELECT TO authenticated USING (is_staff());
CREATE POLICY "reminders_write" ON public.reminders FOR ALL TO authenticated USING (is_staff()) WITH CHECK (is_staff());
CREATE POLICY "reminders_delete" ON public.reminders FOR DELETE TO authenticated USING (is_staff());

-- ================================================================
-- 6. SEED DATA (mirrors rebuild_database.sql v3)
-- Super Admin: hello@munya.co.zw / griezmann17
-- ================================================================

-- 6a. Auth users
INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token
) VALUES
('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','hello@munya.co.zw',
  crypt('griezmann17',gen_salt('bf')),NOW(),NOW(),NOW(),'{"provider":"email","providers":["email"]}','{"name":"Munyaradzi Choto","role":"super_admin","department":"Management"}',false,''),
('10000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','admin@tariqify.com',
  crypt('staff1234',gen_salt('bf')),NOW(),NOW(),NOW(),'{"provider":"email","providers":["email"]}','{"name":"Farai Mutasa","role":"admin","department":"Administration"}',false,''),
('10000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000000','authenticated','authenticated','claims@tariqify.com',
  crypt('staff1234',gen_salt('bf')),NOW(),NOW(),NOW(),'{"provider":"email","providers":["email"]}','{"name":"Rudo Chikwanda","role":"claims_officer","department":"Claims"}',false,''),
('10000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000000','authenticated','authenticated','policy@tariqify.com',
  crypt('staff1234',gen_salt('bf')),NOW(),NOW(),NOW(),'{"provider":"email","providers":["email"]}','{"name":"Blessing Moyo","role":"policy_admin","department":"Policy Administration"}',false,''),
('10000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000000','authenticated','authenticated','finance@tariqify.com',
  crypt('staff1234',gen_salt('bf')),NOW(),NOW(),NOW(),'{"provider":"email","providers":["email"]}','{"name":"Tendai Nhamo","role":"finance","department":"Finance"}',false,''),
('10000000-0000-0000-0000-000000000006','00000000-0000-0000-0000-000000000000','authenticated','authenticated','crm@tariqify.com',
  crypt('staff1234',gen_salt('bf')),NOW(),NOW(),NOW(),'{"provider":"email","providers":["email"]}','{"name":"Chipo Sibanda","role":"client_relations","department":"Client Relations"}',false,''),
('20000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','simba.dube@gmail.com',
  crypt('member1234',gen_salt('bf')),NOW(),NOW(),NOW(),'{"provider":"email","providers":["email"]}','{"name":"Simba Dube","role":"policyholder","department":"Client Portal"}',false,''),
('20000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','nomsa.ndlovu@gmail.com',
  crypt('member1234',gen_salt('bf')),NOW(),NOW(),NOW(),'{"provider":"email","providers":["email"]}','{"name":"Nomsa Ndlovu","role":"policyholder","department":"Client Portal"}',false,''),
('20000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000000','authenticated','authenticated','tafa.chirwa@gmail.com',
  crypt('member1234',gen_salt('bf')),NOW(),NOW(),NOW(),'{"provider":"email","providers":["email"]}','{"name":"Tafadzwa Chirwa","role":"policyholder","department":"Client Portal"}',false,''),
('20000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000000','authenticated','authenticated','patience.m@yahoo.com',
  crypt('member1234',gen_salt('bf')),NOW(),NOW(),NOW(),'{"provider":"email","providers":["email"]}','{"name":"Patience Mukamuri","role":"policyholder","department":"Client Portal"}',false,''),
('20000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000000','authenticated','authenticated','garikai.mhike@gmail.com',
  crypt('member1234',gen_salt('bf')),NOW(),NOW(),NOW(),'{"provider":"email","providers":["email"]}','{"name":"Garikai Mhike","role":"policyholder","department":"Client Portal"}',false,''),
('20000000-0000-0000-0000-000000000006','00000000-0000-0000-0000-000000000000','authenticated','authenticated','rutendo.z@gmail.com',
  crypt('member1234',gen_salt('bf')),NOW(),NOW(),NOW(),'{"provider":"email","providers":["email"]}','{"name":"Rutendo Zvobgo","role":"policyholder","department":"Client Portal"}',false,''),
('20000000-0000-0000-0000-000000000007','00000000-0000-0000-0000-000000000000','authenticated','authenticated','kuda.muzenda@gmail.com',
  crypt('member1234',gen_salt('bf')),NOW(),NOW(),NOW(),'{"provider":"email","providers":["email"]}','{"name":"Kudakwashe Muzenda","role":"policyholder","department":"Client Portal"}',false,''),
('20000000-0000-0000-0000-000000000008','00000000-0000-0000-0000-000000000000','authenticated','authenticated','chiedza.h@gmail.com',
  crypt('member1234',gen_salt('bf')),NOW(),NOW(),NOW(),'{"provider":"email","providers":["email"]}','{"name":"Chiedza Hove","role":"policyholder","department":"Client Portal"}',false,''),
('20000000-0000-0000-0000-000000000009','00000000-0000-0000-0000-000000000000','authenticated','authenticated','munya.gumbo@gmail.com',
  crypt('member1234',gen_salt('bf')),NOW(),NOW(),NOW(),'{"provider":"email","providers":["email"]}','{"name":"Munyaradzi Gumbo","role":"policyholder","department":"Client Portal"}',false,''),
('20000000-0000-0000-0000-000000000010','00000000-0000-0000-0000-000000000000','authenticated','authenticated','tsitsi.m@gmail.com',
  crypt('member1234',gen_salt('bf')),NOW(),NOW(),NOW(),'{"provider":"email","providers":["email"]}','{"name":"Tsitsi Manyonga","role":"policyholder","department":"Client Portal"}',false,'')
ON CONFLICT (id) DO NOTHING;

-- 6b. Update profiles
UPDATE public.profiles SET name='Munyaradzi Choto',  role='super_admin',      department='Management',            phone='+263 77 100 0001', active=true WHERE id='10000000-0000-0000-0000-000000000001';
UPDATE public.profiles SET name='Farai Mutasa',       role='admin',            department='Administration',        phone='+263 77 100 0002', active=true WHERE id='10000000-0000-0000-0000-000000000002';
UPDATE public.profiles SET name='Rudo Chikwanda',     role='claims_officer',   department='Claims',                phone='+263 77 100 0003', active=true WHERE id='10000000-0000-0000-0000-000000000003';
UPDATE public.profiles SET name='Blessing Moyo',      role='policy_admin',     department='Policy Administration', phone='+263 77 100 0004', active=true WHERE id='10000000-0000-0000-0000-000000000004';
UPDATE public.profiles SET name='Tendai Nhamo',       role='finance',          department='Finance',               phone='+263 77 100 0005', active=true WHERE id='10000000-0000-0000-0000-000000000005';
UPDATE public.profiles SET name='Chipo Sibanda',      role='client_relations', department='Client Relations',      phone='+263 77 100 0006', active=true WHERE id='10000000-0000-0000-0000-000000000006';
UPDATE public.profiles SET name='Simba Dube',         role='policyholder',     department='Client Portal',         phone='+263 71 201 0001', active=true WHERE id='20000000-0000-0000-0000-000000000001';
UPDATE public.profiles SET name='Nomsa Ndlovu',       role='policyholder',     department='Client Portal',         phone='+263 71 201 0002', active=true WHERE id='20000000-0000-0000-0000-000000000002';
UPDATE public.profiles SET name='Tafadzwa Chirwa',    role='policyholder',     department='Client Portal',         phone='+263 71 201 0003', active=true WHERE id='20000000-0000-0000-0000-000000000003';
UPDATE public.profiles SET name='Patience Mukamuri',  role='policyholder',     department='Client Portal',         phone='+263 71 201 0004', active=true WHERE id='20000000-0000-0000-0000-000000000004';
UPDATE public.profiles SET name='Garikai Mhike',      role='policyholder',     department='Client Portal',         phone='+263 71 201 0005', active=true WHERE id='20000000-0000-0000-0000-000000000005';
UPDATE public.profiles SET name='Rutendo Zvobgo',     role='policyholder',     department='Client Portal',         phone='+263 71 201 0006', active=true WHERE id='20000000-0000-0000-0000-000000000006';
UPDATE public.profiles SET name='Kudakwashe Muzenda', role='policyholder',     department='Client Portal',         phone='+263 71 201 0007', active=true WHERE id='20000000-0000-0000-0000-000000000007';
UPDATE public.profiles SET name='Chiedza Hove',       role='policyholder',     department='Client Portal',         phone='+263 71 201 0008', active=true WHERE id='20000000-0000-0000-0000-000000000008';
UPDATE public.profiles SET name='Munyaradzi Gumbo',   role='policyholder',     department='Client Portal',         phone='+263 71 201 0009', active=true WHERE id='20000000-0000-0000-0000-000000000009';
UPDATE public.profiles SET name='Tsitsi Manyonga',    role='policyholder',     department='Client Portal',         phone='+263 71 201 0010', active=true WHERE id='20000000-0000-0000-0000-000000000010';

-- 6c. Clients
INSERT INTO public.clients (id, name, email, phone, national_id, dob, address, occupation, insurer, status) VALUES
('aa000001-0000-0000-0000-000000000001','Simba Dube',         'simba.dube@gmail.com',   '+263 71 201 0001','63-1234567A00','1990-03-15','12 Borrowdale Rd, Harare',      'Engineer',      'EMA','active'),
('aa000001-0000-0000-0000-000000000002','Nomsa Ndlovu',       'nomsa.ndlovu@gmail.com', '+263 71 201 0002','78-2345678B00','1978-07-22','45 Bulawayo Ave, Bulawayo',     'Teacher',       'EMA','active'),
('aa000001-0000-0000-0000-000000000003','Tafadzwa Chirwa',    'tafa.chirwa@gmail.com',  '+263 71 201 0003','85-3456789C00','1985-11-08','7 Mutare Road, Mutare',         'Nurse',         'EMA','active'),
('aa000001-0000-0000-0000-000000000004','Patience Mukamuri',  'patience.m@yahoo.com',   '+263 71 201 0004','92-4567890D00','1992-05-30','23 Gweru Drive, Gweru',         'Accountant',    'EMA','active'),
('aa000001-0000-0000-0000-000000000005','Garikai Mhike',      'garikai.mhike@gmail.com','+263 71 201 0005','70-5678901E00','1970-09-14','89 Masvingo Road, Masvingo',    'Farmer',        'EMA','inactive'),
('aa000001-0000-0000-0000-000000000006','Rutendo Zvobgo',     'rutendo.z@gmail.com',    '+263 71 201 0006','88-6789012F00','1988-12-01','34 Harare Gardens, Harare',     'Lawyer',        'EMA','active'),
('aa000001-0000-0000-0000-000000000007','Kudakwashe Muzenda', 'kuda.muzenda@gmail.com', '+263 71 201 0007','95-7890123G00','1995-02-18','56 Zvishavane Way, Zvishavane', 'Miner',         'EMA','active'),
('aa000001-0000-0000-0000-000000000008','Chiedza Hove',       'chiedza.h@gmail.com',    '+263 71 201 0008','82-8901234H00','1982-08-25','12 Chitungwiza Ave, Chitungwiza','Social Worker', 'EMA','active'),
('aa000001-0000-0000-0000-000000000009','Munyaradzi Gumbo',   'munya.gumbo@gmail.com',  '+263 71 201 0009','75-9012345I00','1975-04-10','78 Chinhoyi Road, Chinhoyi',    'Driver',        'EMA','active'),
('aa000001-0000-0000-0000-000000000010','Tsitsi Manyonga',    'tsitsi.m@gmail.com',     '+263 71 201 0010','90-0123456J00','1990-06-15','5 Norton Heights, Norton',       'Business Owner','EMA','active')
ON CONFLICT (id) DO NOTHING;

-- 6d. Products
INSERT INTO public.products (id, name, code, category, premium, cover_amount, waiting_period_days, min_age, max_age, commission_pct, active, features, description) VALUES
('bb000001-0000-0000-0000-000000000001','Funeral Cover Basic',    'FUN-001','funeral', 5.00, 3000,30,18,75,15,true, ARRAY['Immediate payout','Up to 6 dependants','Repatriation cover','Transport allowance'],'Affordable funeral cover for individuals and families.'),
('bb000001-0000-0000-0000-000000000002','Funeral Cover Premium',  'FUN-002','funeral',12.00, 8000,30,18,75,15,true, ARRAY['Immediate payout','Unlimited dependants','Repatriation + Groceries allowance','Tombstone benefit'],'Comprehensive funeral cover with extended benefits.'),
('bb000001-0000-0000-0000-000000000003','Life Cover Essential',   'LIF-001','life',   10.00,10000,60,18,65,20,true, ARRAY['Death benefit','Terminal illness cover','Disability benefit','Premium waiver'],'Essential life cover protecting your family.'),
('bb000001-0000-0000-0000-000000000004','Hospital Cash Plan',     'HCP-001','health',  8.00,   50,14,18,70,12,true, ARRAY['$50/day hospital cash','ICU double benefit','Day 1 cover after waiting period'],'Daily hospital cash benefit while admitted.'),
('bb000001-0000-0000-0000-000000000005','Personal Accident Cover','PAC-001','accident',3.00, 5000, 0,18,70,10,true, ARRAY['Accidental death','Permanent disability','Temporary disability income','Medical expenses'],'24/7 accident protection.')
ON CONFLICT (id) DO NOTHING;

-- 6e. Policies
INSERT INTO public.policies (id, policy_number, client_id, product_id, premium, cover_amount, start_date, end_date, status, beneficiaries, payment_method, agent_id, next_payment_date, last_payment_date) VALUES
('cc000001-0000-0000-0000-000000000001','EMA-2024-001','aa000001-0000-0000-0000-000000000001','bb000001-0000-0000-0000-000000000001', 5.00, 3000,'2024-01-15','2027-01-15','active','[{"name":"Grace Dube","relationship":"Spouse","percentage":100}]','EcoCash','10000000-0000-0000-0000-000000000006','2026-06-15','2026-05-15'),
('cc000001-0000-0000-0000-000000000002','EMA-2024-002','aa000001-0000-0000-0000-000000000002','bb000001-0000-0000-0000-000000000002',12.00, 8000,'2024-02-10','2027-02-10','active','[{"name":"John Ndlovu","relationship":"Spouse","percentage":60},{"name":"Thabo Ndlovu","relationship":"Child","percentage":40}]','Bank Transfer','10000000-0000-0000-0000-000000000004','2026-06-10','2026-05-10'),
('cc000001-0000-0000-0000-000000000003','EMA-2024-003','aa000001-0000-0000-0000-000000000003','bb000001-0000-0000-0000-000000000003',10.00,10000,'2024-03-01','2027-03-01','active','[{"name":"Mary Chirwa","relationship":"Spouse","percentage":100}]','OneMoney','10000000-0000-0000-0000-000000000004','2026-06-01','2026-05-01'),
('cc000001-0000-0000-0000-000000000004','EMA-2024-004','aa000001-0000-0000-0000-000000000004','bb000001-0000-0000-0000-000000000001', 5.00, 3000,'2024-03-15','2027-03-15','active','[{"name":"Peter Mukamuri","relationship":"Spouse","percentage":100}]','EcoCash','10000000-0000-0000-0000-000000000006','2026-06-15','2026-05-15'),
('cc000001-0000-0000-0000-000000000005','EMA-2024-005','aa000001-0000-0000-0000-000000000005','bb000001-0000-0000-0000-000000000005', 3.00, 5000,'2024-04-01','2025-04-01','lapsed','[{"name":"Anna Mhike","relationship":"Spouse","percentage":100}]','Cash','10000000-0000-0000-0000-000000000006',NULL,'2026-01-01'),
('cc000001-0000-0000-0000-000000000006','EMA-2024-006','aa000001-0000-0000-0000-000000000006','bb000001-0000-0000-0000-000000000003',10.00,10000,'2024-04-20','2027-04-20','active','[{"name":"David Zvobgo","relationship":"Spouse","percentage":50},{"name":"Lisa Zvobgo","relationship":"Child","percentage":50}]','InnBucks','10000000-0000-0000-0000-000000000004','2026-06-20','2026-05-20'),
('cc000001-0000-0000-0000-000000000007','EMA-2024-007','aa000001-0000-0000-0000-000000000007','bb000001-0000-0000-0000-000000000004', 8.00,   50,'2024-05-05','2027-05-05','active','[{"name":"Fara Muzenda","relationship":"Spouse","percentage":100}]','EcoCash','10000000-0000-0000-0000-000000000006','2026-06-05','2026-05-05'),
('cc000001-0000-0000-0000-000000000008','EMA-2024-008','aa000001-0000-0000-0000-000000000008','bb000001-0000-0000-0000-000000000005', 3.00, 5000,'2024-05-22','2027-05-22','pending','[{"name":"James Hove","relationship":"Spouse","percentage":100}]','Bank Transfer','10000000-0000-0000-0000-000000000004',NULL,NULL),
('cc000001-0000-0000-0000-000000000009','EMA-2024-009','aa000001-0000-0000-0000-000000000009','bb000001-0000-0000-0000-000000000002',12.00, 8000,'2024-06-12','2027-06-12','active','[{"name":"Rose Gumbo","relationship":"Spouse","percentage":100}]','Debit Order','10000000-0000-0000-0000-000000000006','2026-06-12','2026-05-12'),
('cc000001-0000-0000-0000-000000000010','EMA-2024-010','aa000001-0000-0000-0000-000000000010','bb000001-0000-0000-0000-000000000001', 5.00, 3000,'2024-07-01','2027-07-01','active','[{"name":"Ben Manyonga","relationship":"Spouse","percentage":100}]','EcoCash','10000000-0000-0000-0000-000000000006','2026-06-01','2026-05-01')
ON CONFLICT (id) DO NOTHING;

-- 6f. Claims
INSERT INTO public.claims (id, claim_number, policy_id, claim_type, amount, status, date_of_event, date_submitted, description, fraud_score, assigned_to, documents, notes, resolved_at) VALUES
('dd000001-0000-0000-0000-000000000001','CLM-2026-001','cc000001-0000-0000-0000-000000000002','Death Benefit',  8000,'under_review','2026-04-28','2026-04-30','Policyholder''s mother passed away 28 April 2026.',12,'10000000-0000-0000-0000-000000000003',ARRAY['death_cert.pdf','id_copy.pdf'],'Documents verified. Awaiting next of kin confirmation.',NULL),
('dd000001-0000-0000-0000-000000000002','CLM-2026-002','cc000001-0000-0000-0000-000000000007','Hospitalisation',350,'approved','2026-04-15','2026-04-20','7 days hospitalisation at Parirenyatwa Hospital.',5,'10000000-0000-0000-0000-000000000003',ARRAY['hospital_letter.pdf','receipts.pdf'],'All documents verified. 7 days at $50/day.','2026-04-25'),
('dd000001-0000-0000-0000-000000000003','CLM-2026-003','cc000001-0000-0000-0000-000000000005','Accidental Injury',5000,'pending','2026-05-01','2026-05-03','Client involved in road traffic accident.',78,NULL,ARRAY['police_report.pdf'],'High fraud score flagged. Policy lapsed — under review.',NULL),
('dd000001-0000-0000-0000-000000000004','CLM-2026-004','cc000001-0000-0000-0000-000000000006','Disability Benefit',5000,'rejected','2026-03-10','2026-03-15','Claimed permanent disability after workplace accident.',62,'10000000-0000-0000-0000-000000000003',ARRAY['medical_cert.pdf'],'Rejected: certificate from unregistered practitioner.','2026-04-01'),
('dd000001-0000-0000-0000-000000000005','CLM-2026-005','cc000001-0000-0000-0000-000000000009','Death Benefit',  8000,'paid','2026-02-20','2026-02-22','Policyholder''s spouse passed away.',8,'10000000-0000-0000-0000-000000000003',ARRAY['death_cert.pdf','marriage_cert.pdf'],'Paid via EcoCash on 2026-03-05.','2026-03-05')
ON CONFLICT (id) DO NOTHING;

-- 6g. Payments
INSERT INTO public.payments (id, reference, policy_id, amount, method, status, payment_date) VALUES
('ee000001-0000-0000-0000-000000000001','PAY-20260501-001','cc000001-0000-0000-0000-000000000001', 5.00,'EcoCash',     'completed','2026-05-01'),
('ee000001-0000-0000-0000-000000000002','PAY-20260501-002','cc000001-0000-0000-0000-000000000002',12.00,'Bank Transfer','completed','2026-05-01'),
('ee000001-0000-0000-0000-000000000003','PAY-20260502-003','cc000001-0000-0000-0000-000000000003',10.00,'OneMoney',    'completed','2026-05-02'),
('ee000001-0000-0000-0000-000000000004','PAY-20260503-004','cc000001-0000-0000-0000-000000000004', 5.00,'EcoCash',     'completed','2026-05-03'),
('ee000001-0000-0000-0000-000000000005','PAY-20260504-005','cc000001-0000-0000-0000-000000000005', 3.00,'Cash',        'failed',   '2026-05-04'),
('ee000001-0000-0000-0000-000000000006','PAY-20260505-006','cc000001-0000-0000-0000-000000000006',10.00,'InnBucks',    'completed','2026-05-05'),
('ee000001-0000-0000-0000-000000000007','PAY-20260506-007','cc000001-0000-0000-0000-000000000007', 8.00,'EcoCash',     'completed','2026-05-06'),
('ee000001-0000-0000-0000-000000000008','PAY-20260507-008','cc000001-0000-0000-0000-000000000009',12.00,'Debit Order', 'completed','2026-05-07'),
('ee000001-0000-0000-0000-000000000009','PAY-20260508-009','cc000001-0000-0000-0000-000000000010', 5.00,'EcoCash',     'completed','2026-05-08'),
('ee000001-0000-0000-0000-000000000010','PAY-20260415-010','cc000001-0000-0000-0000-000000000003',10.00,'OneMoney',    'completed','2026-04-15')
ON CONFLICT (id) DO NOTHING;

-- 6h. Tickets
INSERT INTO public.tickets (id, ticket_number, client_id, subject, description, status, priority, category, assigned_to, messages) VALUES
('ff000001-0000-0000-0000-000000000001','TKT-2026-001','aa000001-0000-0000-0000-000000000001','Cannot access my policy documents','Link keeps failing.',
  'in_progress','medium','Technical','10000000-0000-0000-0000-000000000006',
  '[{"id":"m1","senderId":"aa000001-0000-0000-0000-000000000001","senderName":"Simba Dube","message":"I cannot download my policy documents.","timestamp":"2026-05-07T10:00:00Z","isStaff":false},{"id":"m2","senderId":"10000000-0000-0000-0000-000000000006","senderName":"Chipo Sibanda","message":"We are looking into the issue.","timestamp":"2026-05-08T09:00:00Z","isStaff":true}]'),
('ff000001-0000-0000-0000-000000000002','TKT-2026-002','aa000001-0000-0000-0000-000000000002','Claim payout not received','Claim approved but no payout.',
  'open','urgent','Claims',NULL,
  '[{"id":"m3","senderId":"aa000001-0000-0000-0000-000000000002","senderName":"Nomsa Ndlovu","message":"Please assist with my claim payout.","timestamp":"2026-05-09T08:30:00Z","isStaff":false}]'),
('ff000001-0000-0000-0000-000000000003','TKT-2026-003','aa000001-0000-0000-0000-000000000004','Update beneficiary details','Need to change beneficiary.',
  'resolved','low','Policy','10000000-0000-0000-0000-000000000004',
  '[{"id":"m4","senderId":"aa000001-0000-0000-0000-000000000004","senderName":"Patience Mukamuri","message":"Please help me update beneficiary details.","timestamp":"2026-04-20T14:00:00Z","isStaff":false},{"id":"m5","senderId":"10000000-0000-0000-0000-000000000004","senderName":"Blessing Moyo","message":"Your beneficiary details have been updated.","timestamp":"2026-04-22T11:00:00Z","isStaff":true}]')
ON CONFLICT (id) DO NOTHING;

-- 6i. Leads
INSERT INTO public.leads (id, name, email, phone, source, product_interest, status, intent_score, assigned_to) VALUES
('b1000001-0000-0000-0000-000000000001','Tanaka Mushore', 'tanaka.m@gmail.com','+263 77 100 2000','WhatsApp Chatbot','Funeral Cover Basic',    'new',      82,'10000000-0000-0000-0000-000000000006'),
('b1000001-0000-0000-0000-000000000002','Sekai Choto',    NULL,                '+263 73 200 3000','USSD *907#',      'Hospital Cash Plan',     'contacted',65,'10000000-0000-0000-0000-000000000006'),
('b1000001-0000-0000-0000-000000000003','Farai Madzima',  'farai.m@yahoo.com', '+263 78 300 4000','Referral',        'Life Cover Essential',   'qualified',91,'10000000-0000-0000-0000-000000000006'),
('b1000001-0000-0000-0000-000000000004','Nyasha Banda',   NULL,                '+263 71 400 5000','Facebook Ad',     'Personal Accident Cover','proposal', 55,'10000000-0000-0000-0000-000000000006'),
('b1000001-0000-0000-0000-000000000005','Tariro Mutumhe', 'tariro.m@gmail.com','+263 77 500 6000','Walk-in',         'Funeral Cover Premium',  'converted',95,'10000000-0000-0000-0000-000000000006')
ON CONFLICT (id) DO NOTHING;

-- 6j. Fraud Cases
INSERT INTO public.fraud_cases (id, claim_id, fraud_score, signals, status, assigned_to, notes, resolved_at) VALUES
('c1000001-0000-0000-0000-000000000001','dd000001-0000-0000-0000-000000000003',78,
  ARRAY['Policy lapsed at time of claim','Claim submitted within 3 days of reactivation attempt','Inconsistent accident details','No witness corroboration'],
  'open',NULL,NULL,NULL),
('c1000001-0000-0000-0000-000000000002','dd000001-0000-0000-0000-000000000004',62,
  ARRAY['Medical certificate from unregistered practitioner','Prior rejected claim history','No police report for workplace accident'],
  'confirmed','10000000-0000-0000-0000-000000000003','Claim rejected. Evidence submitted to police.','2026-04-01')
ON CONFLICT (id) DO NOTHING;

-- 6k. Reminders
INSERT INTO public.reminders (id, type, client_id, policy_id, due_date, message, sent, channel) VALUES
('d1000001-0000-0000-0000-000000000001','payment_due',   'aa000001-0000-0000-0000-000000000001','cc000001-0000-0000-0000-000000000001','2026-06-15','Your funeral cover premium of $5.00 is due on 15 June.',false,'whatsapp'),
('d1000001-0000-0000-0000-000000000002','payment_due',   'aa000001-0000-0000-0000-000000000002','cc000001-0000-0000-0000-000000000002','2026-06-10','Your premium of $12.00 is due on 10 June.',false,'sms'),
('d1000001-0000-0000-0000-000000000003','policy_renewal','aa000001-0000-0000-0000-000000000005','cc000001-0000-0000-0000-000000000005','2026-06-01','Your policy EMA-2024-005 has lapsed. Please contact us to reinstate.',false,'whatsapp'),
('d1000001-0000-0000-0000-000000000004','claim_followup','aa000001-0000-0000-0000-000000000002','cc000001-0000-0000-0000-000000000002','2026-05-15','Follow up on claim CLM-2026-001 — awaiting next of kin docs.',false,'email'),
('d1000001-0000-0000-0000-000000000005','birthday',      'aa000001-0000-0000-0000-000000000003',NULL,'2026-11-08','Happy birthday Tafadzwa Chirwa!',false,'sms')
ON CONFLICT (id) DO NOTHING;

-- ================================================================
-- DONE. All tables, RLS, triggers, and seed data created.
-- Login credentials:
-- Super Admin : hello@munya.co.zw  / griezmann17
-- Admin       : admin@tariqify.com / staff1234
-- Claims      : claims@tariqify.com / staff1234
-- Policy Admin: policy@tariqify.com / staff1234
-- Finance     : finance@tariqify.com / staff1234
-- Client Rel  : crm@tariqify.com / staff1234
-- Members     : (their email) / member1234
-- ================================================================

-- ----------------------------------------------------------------
-- LIVE CHAT (see database/add_live_chat.sql for the standalone migration)
-- ----------------------------------------------------------------
-- Live Chat Support: public pre-chat form (topic + name + phone + email) ->
-- queued session -> staff claims it -> real-time two-way chat.
--
-- Visitors are NOT required to have an account. They get a real (if
-- anonymous) Supabase Auth identity via supabase.auth.signInAnonymously(),
-- which gives us a genuine auth.uid() to scope RLS by — this is what makes
-- "only this visitor can read their own session" actually enforceable,
-- rather than relying on an unguessable-URL trust model.
--
-- Run this once in the Supabase SQL Editor against the live database.

CREATE TABLE IF NOT EXISTS public.chat_topics (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name       TEXT NOT NULL UNIQUE,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.chat_sessions (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  visitor_id     UUID NOT NULL,
  visitor_name   TEXT NOT NULL,
  visitor_phone  TEXT NOT NULL,
  visitor_email  TEXT NOT NULL,
  topic          TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','active','closed')),
  assigned_to    UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  queued_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at     TIMESTAMPTZ,
  closed_at      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.chat_messages (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id  UUID NOT NULL REFERENCES public.chat_sessions(id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('visitor','agent','system')),
  sender_name TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON public.chat_messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_status ON public.chat_sessions(status, queued_at);

ALTER TABLE public.chat_topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;

-- Topics: anyone (even anon, pre-chat form) can read active topics.
DROP POLICY IF EXISTS "chat_topics_select" ON public.chat_topics;
CREATE POLICY "chat_topics_select" ON public.chat_topics FOR SELECT TO anon, authenticated USING (active = true);
DROP POLICY IF EXISTS "chat_topics_write_admin" ON public.chat_topics;
CREATE POLICY "chat_topics_write_admin" ON public.chat_topics FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());

-- Sessions: a visitor can create/read/update only their own row (matched by
-- their anonymous auth uid); staff can read/update any (to run the queue).
DROP POLICY IF EXISTS "chat_sessions_insert" ON public.chat_sessions;
CREATE POLICY "chat_sessions_insert" ON public.chat_sessions FOR INSERT TO authenticated WITH CHECK (visitor_id = auth.uid());
DROP POLICY IF EXISTS "chat_sessions_select_own" ON public.chat_sessions;
CREATE POLICY "chat_sessions_select_own" ON public.chat_sessions FOR SELECT TO authenticated USING (visitor_id = auth.uid());
DROP POLICY IF EXISTS "chat_sessions_select_staff" ON public.chat_sessions;
CREATE POLICY "chat_sessions_select_staff" ON public.chat_sessions FOR SELECT TO authenticated USING (is_staff());
DROP POLICY IF EXISTS "chat_sessions_update_staff" ON public.chat_sessions;
CREATE POLICY "chat_sessions_update_staff" ON public.chat_sessions FOR UPDATE TO authenticated USING (is_staff());
DROP POLICY IF EXISTS "chat_sessions_update_own_close" ON public.chat_sessions;
CREATE POLICY "chat_sessions_update_own_close" ON public.chat_sessions FOR UPDATE TO authenticated USING (visitor_id = auth.uid());

-- Messages: visitor can read/send within their own session; staff can
-- read/send within any session (needed to triage/claim from the queue).
DROP POLICY IF EXISTS "chat_messages_select_own" ON public.chat_messages;
CREATE POLICY "chat_messages_select_own" ON public.chat_messages FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.chat_sessions s WHERE s.id = session_id AND s.visitor_id = auth.uid())
);
DROP POLICY IF EXISTS "chat_messages_select_staff" ON public.chat_messages;
CREATE POLICY "chat_messages_select_staff" ON public.chat_messages FOR SELECT TO authenticated USING (is_staff());
DROP POLICY IF EXISTS "chat_messages_insert_own" ON public.chat_messages;
CREATE POLICY "chat_messages_insert_own" ON public.chat_messages FOR INSERT TO authenticated WITH CHECK (
  sender_type IN ('visitor', 'system') AND EXISTS (SELECT 1 FROM public.chat_sessions s WHERE s.id = session_id AND s.visitor_id = auth.uid())
);
DROP POLICY IF EXISTS "chat_messages_insert_staff" ON public.chat_messages;
CREATE POLICY "chat_messages_insert_staff" ON public.chat_messages FOR INSERT TO authenticated WITH CHECK (
  sender_type = 'agent' AND is_staff()
);

-- How many sessions are ahead of this one in the queue (1-indexed position).
-- SECURITY DEFINER so a visitor can know their queue position without RLS
-- exposing other visitors' session rows to them.
CREATE OR REPLACE FUNCTION public.get_chat_queue_position(p_session_id UUID)
RETURNS INT LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT COUNT(*)::INT + 1 FROM public.chat_sessions
  WHERE status = 'queued'
    AND queued_at < (SELECT queued_at FROM public.chat_sessions WHERE id = p_session_id)
$$;

-- Realtime: push new messages and session status changes to subscribers.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'chat_messages') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_messages;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'chat_sessions') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_sessions;
  END IF;
END $$;

INSERT INTO public.chat_topics (name, sort_order) VALUES
  ('Buy a New Policy', 1),
  ('Existing Policy Question', 2),
  ('File or Track a Claim', 3),
  ('Billing & Payments', 4),
  ('Technical Support', 5),
  ('General Inquiry', 6)
ON CONFLICT DO NOTHING;

-- ================================================================
-- Caution Flags (moved from client-side localStorage to a real table
-- so a flag raised by one staff member's reminder-check run is visible
-- to every staff member, including whoever reviews claims)
-- ================================================================
CREATE TABLE IF NOT EXISTS public.caution_flags (
  policy_id        UUID PRIMARY KEY REFERENCES public.policies(id) ON DELETE CASCADE,
  policy_number    TEXT NOT NULL,
  client_id        UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name      TEXT NOT NULL,
  agent_id         UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  days_overdue     INTEGER NOT NULL DEFAULT 0,
  flagged_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  months_defaulted INTEGER NOT NULL DEFAULT 1,
  cleared          BOOLEAN NOT NULL DEFAULT FALSE,
  cleared_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_caution_flags_cleared ON public.caution_flags(cleared);

ALTER TABLE public.caution_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.caution_flags FORCE ROW LEVEL SECURITY;

CREATE POLICY "caution_flags_select" ON public.caution_flags FOR SELECT TO authenticated USING (is_staff());
CREATE POLICY "caution_flags_write"  ON public.caution_flags FOR ALL    TO authenticated USING (is_staff()) WITH CHECK (is_staff());

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'caution_flags') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.caution_flags;
  END IF;
END $$;
ALTER TABLE public.caution_flags REPLICA IDENTITY FULL;
