-- ================================================================
-- TARIQIFY IMS — Supabase Schema (without profiles table)
-- Run this AFTER create_profiles_first.sql
-- ================================================================

-- ----------------------------------------------------------------
-- 1. EXTENSIONS
-- ----------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ----------------------------------------------------------------
-- 2. TABLES (excluding profiles - already created)
-- ----------------------------------------------------------------

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

-- ----------------------------------------------------------------
-- 4. ROW LEVEL SECURITY
-- ----------------------------------------------------------------
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

-- Helper: get current user's role
CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid()
$$;

-- Helper: is current user a staff member?
CREATE OR REPLACE FUNCTION public.is_staff()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT role IN ('super_admin','admin','claims_officer','policy_admin','finance','client_relations')
  FROM public.profiles WHERE id = auth.uid()
$$;

-- Profiles: users can read all profiles (for assignment dropdowns); own profile for update
CREATE POLICY "profiles_select" ON public.profiles FOR SELECT TO authenticated USING (true);
CREATE POLICY "profiles_update_own" ON public.profiles FOR UPDATE TO authenticated USING (id = auth.uid());
CREATE POLICY "profiles_update_admin" ON public.profiles FOR UPDATE TO authenticated
  USING (current_user_role() IN ('super_admin','admin'));

-- Clients: staff read/write all; policyholders read only their own linked client
CREATE POLICY "clients_select_staff" ON public.clients FOR SELECT TO authenticated USING (is_staff());
CREATE POLICY "clients_select_own"   ON public.clients FOR SELECT TO authenticated
  USING (id IN (SELECT client_id FROM public.policies WHERE client_id = clients.id
                AND EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'policyholder')));
CREATE POLICY "clients_insert" ON public.clients FOR INSERT TO authenticated WITH CHECK (is_staff());
CREATE POLICY "clients_update" ON public.clients FOR UPDATE TO authenticated USING (is_staff());

-- Products: anyone authenticated can read; only admins write
CREATE POLICY "products_select" ON public.products FOR SELECT TO authenticated USING (true);
CREATE POLICY "products_write"  ON public.products FOR ALL TO authenticated
  USING (current_user_role() IN ('super_admin','admin','policy_admin'));

-- Policies: staff all; policyholders own only
CREATE POLICY "policies_select_staff" ON public.policies FOR SELECT TO authenticated USING (is_staff());
CREATE POLICY "policies_select_own"   ON public.policies FOR SELECT TO authenticated
  USING (client_id IN (SELECT c.id FROM public.clients c
    JOIN public.policies p ON p.client_id = c.id
    WHERE EXISTS (SELECT 1 FROM auth.users u WHERE u.id = auth.uid() AND u.email = c.email)));
CREATE POLICY "policies_write" ON public.policies FOR ALL TO authenticated
  USING (current_user_role() IN ('super_admin','admin','policy_admin','client_relations'));

-- Claims: staff all; policyholders own only
CREATE POLICY "claims_select_staff" ON public.claims FOR SELECT TO authenticated USING (is_staff());
CREATE POLICY "claims_write"        ON public.claims FOR ALL TO authenticated
  USING (current_user_role() IN ('super_admin','admin','claims_officer'));

-- Payments: staff all; policyholders own only
CREATE POLICY "payments_select_staff" ON public.payments FOR SELECT TO authenticated USING (is_staff());
CREATE POLICY "payments_write"        ON public.payments FOR ALL TO authenticated
  USING (current_user_role() IN ('super_admin','admin','finance'));

-- Tickets: staff all; client-facing read of own tickets handled in app
CREATE POLICY "tickets_select" ON public.tickets FOR SELECT TO authenticated USING (is_staff());
CREATE POLICY "tickets_write"  ON public.tickets FOR ALL TO authenticated
  USING (current_user_role() IN ('super_admin','admin','client_relations'));

-- Emails: staff only
CREATE POLICY "emails_select" ON public.emails FOR SELECT TO authenticated USING (is_staff());
CREATE POLICY "emails_write"  ON public.emails FOR ALL  TO authenticated USING (is_staff());

-- Leads: staff only
CREATE POLICY "leads_select" ON public.leads FOR SELECT TO authenticated USING (is_staff());
CREATE POLICY "leads_write"  ON public.leads FOR ALL  TO authenticated USING (is_staff());

-- Fraud: claims officers + admins
CREATE POLICY "fraud_select" ON public.fraud_cases FOR SELECT TO authenticated
  USING (current_user_role() IN ('super_admin','admin','claims_officer'));
CREATE POLICY "fraud_write"  ON public.fraud_cases FOR ALL TO authenticated
  USING (current_user_role() IN ('super_admin','admin','claims_officer'));

-- Reminders: staff only
CREATE POLICY "reminders_select" ON public.reminders FOR SELECT TO authenticated USING (is_staff());
CREATE POLICY "reminders_write"  ON public.reminders FOR ALL TO authenticated USING (is_staff());

-- ----------------------------------------------------------------
-- 5. SEED DATA
-- ----------------------------------------------------------------

-- 5a. Auth users (the trigger will create matching profile rows)
INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token
) VALUES
(
  '11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'admin@tariqify.com',
  crypt('admin1234', gen_salt('bf')), NOW(), NOW(), NOW(),
  '{"provider":"email","providers":["email"]}',
  '{"name":"Tariq Musa","role":"super_admin","department":"Management"}',
  false, ''
),
(
  '22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'claims@tariqify.com',
  crypt('staff1234', gen_salt('bf')), NOW(), NOW(), NOW(),
  '{"provider":"email","providers":["email"]}',
  '{"name":"Rudo Chikwanda","role":"claims_officer","department":"Claims"}',
  false, ''
),
(
  '33333333-3333-3333-3333-333333333333', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'policy@tariqify.com',
  crypt('staff1234', gen_salt('bf')), NOW(), NOW(), NOW(),
  '{"provider":"email","providers":["email"]}',
  '{"name":"Blessing Moyo","role":"policy_admin","department":"Policy Administration"}',
  false, ''
),
(
  '44444444-4444-4444-4444-444444444444', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'finance@tariqify.com',
  crypt('staff1234', gen_salt('bf')), NOW(), NOW(), NOW(),
  '{"provider":"email","providers":["email"]}',
  '{"name":"Tendai Nhamo","role":"finance","department":"Finance"}',
  false, ''
),
(
  '55555555-5555-5555-5555-555555555555', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'crm@tariqify.com',
  crypt('staff1234', gen_salt('bf')), NOW(), NOW(), NOW(),
  '{"provider":"email","providers":["email"]}',
  '{"name":"Chipo Sibanda","role":"client_relations","department":"Client Relations"}',
  false, ''
),
(
  '66666666-6666-6666-6666-666666666666', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'client@example.com',
  crypt('client1234', gen_salt('bf')), NOW(), NOW(), NOW(),
  '{"provider":"email","providers":["email"]}',
  '{"name":"Simba Dube","role":"policyholder","department":"Client Portal"}',
  false, ''
),
(
  '77777777-7777-7777-7777-777777777777', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'admin2@tariqify.com',
  crypt('staff1234', gen_salt('bf')), NOW(), NOW(), NOW(),
  '{"provider":"email","providers":["email"]}',
  '{"name":"Farai Mutasa","role":"admin","department":"Administration"}',
  false, ''
)
ON CONFLICT (id) DO NOTHING;

-- 5b. Update profiles (trigger already created them; update with full data)
UPDATE public.profiles SET role='super_admin',  department='Management',              phone='+263 77 123 4567', active=true WHERE id='11111111-1111-1111-1111-111111111111';
UPDATE public.profiles SET role='claims_officer',department='Claims',                phone='+263 71 234 5678', active=true WHERE id='22222222-2222-2222-2222-222222222222';
UPDATE public.profiles SET role='policy_admin', department='Policy Administration',   phone='+263 73 345 6789', active=true WHERE id='33333333-3333-3333-3333-333333333333';
UPDATE public.profiles SET role='finance',      department='Finance',                phone='+263 78 456 7890', active=true WHERE id='44444444-4444-4444-4444-444444444444';
UPDATE public.profiles SET role='client_relations',department='Client Relations',    phone='+263 77 567 8901', active=true WHERE id='55555555-5555-5555-5555-555555555555';
UPDATE public.profiles SET role='policyholder', department='Client Portal',          phone='+263 71 678 9012', active=true WHERE id='66666666-6666-6666-6666-666666666666';
UPDATE public.profiles SET role='admin',        department='Administration',          phone='+263 73 789 0123', active=true WHERE id='77777777-7777-7777-7777-777777777777';

-- 5c. Clients
INSERT INTO public.clients (id, name, email, phone, national_id, dob, address, occupation, status) VALUES
('aa000001-0000-0000-0000-000000000001','Simba Dube',          'simba.dube@gmail.com',      '+263 71 678 9012','63-1234567A00','1990-03-15','12 Borrowdale Rd, Harare','Engineer',    'active'),
('aa000001-0000-0000-0000-000000000002','Nomsa Ndlovu',        'nomsa.ndlovu@gmail.com',    '+263 77 234 5678','78-2345678B00','1978-07-22','45 Bulawayo Ave, Bulawayo','Teacher',    'active'),
('aa000001-0000-0000-0000-000000000003','Tafadzwa Chirwa',     'tafa.chirwa@gmail.com',     '+263 73 345 6789','85-3456789C00','1985-11-08','7 Mutare Road, Mutare','Nurse',         'active'),
('aa000001-0000-0000-0000-000000000004','Patience Mukamuri',   'patience.m@yahoo.com',      '+263 78 456 7890','92-4567890D00','1992-05-30','23 Gweru Drive, Gweru','Accountant',    'active'),
('aa000001-0000-0000-0000-000000000005','Garikai Mhike',       'garikai.mhike@gmail.com',   '+263 71 567 8901','70-5678901E00','1970-09-14','89 Masvingo Road, Masvingo','Farmer',   'inactive'),
('aa000001-0000-0000-0000-000000000006','Rutendo Zvobgo',      'rutendo.z@gmail.com',       '+263 77 678 9012','88-6789012F00','1988-12-01','34 Harare Gardens, Harare','Lawyer',     'active'),
('aa000001-0000-0000-0000-000000000007','Kudakwashe Muzenda',  'kuda.muzenda@gmail.com',    '+263 73 789 0123','95-7890123G00','1995-02-18','56 Zvishavane Way, Zvishavane','Miner', 'active'),
('aa000001-0000-0000-0000-000000000008','Chiedza Hove',        'chiedza.h@gmail.com',       '+263 78 890 1234','82-8901234H00','1982-08-25','12 Chitungwiza Ave, Chitungwiza','Social Worker','active'),
('aa000001-0000-0000-0000-000000000009','Munyaradzi Gumbo',    'munya.gumbo@gmail.com',     '+263 71 901 2345','75-9012345I00','1975-04-10','78 Chinhoyi Road, Chinhoyi','Driver',    'active'),
('aa000001-0000-0000-0000-000000000010','Tsitsi Manyonga',     'tsitsi.m@gmail.com',        '+263 77 012 3456','90-0123456J00','1990-06-15','5 Norton Heights, Norton','Business Owner','active')
ON CONFLICT (id) DO NOTHING;

-- 5d. Products
INSERT INTO public.products (id, name, code, category, premium, cover_amount, waiting_period_days, min_age, max_age, commission_pct, active, features, description) VALUES
('bb000001-0000-0000-0000-000000000001','Funeral Cover Basic',   'FUN-001','funeral',  5.00,  3000,30,18,75,15,true, ARRAY['Immediate payout','Up to 6 dependants','Repatriation cover','Transport allowance'],'Affordable funeral cover for individuals and families.'),
('bb000001-0000-0000-0000-000000000002','Funeral Cover Premium', 'FUN-002','funeral', 12.00,  8000,30,18,75,15,true, ARRAY['Immediate payout','Unlimited dependants','Repatriation cover','Transport + Groceries allowance','Tombstone benefit'],'Comprehensive funeral cover with extended benefits.'),
('bb000001-0000-0000-0000-000000000003','Life Cover Essential',  'LIF-001','life',    10.00, 10000,60,18,65,20,true, ARRAY['Death benefit','Terminal illness cover','Disability benefit','Premium waiver'],'Essential life cover protecting your family.'),
('bb000001-0000-0000-0000-000000000004','Hospital Cash Plan',    'HCP-001','health',   8.00,    50,14,18,70,12,true, ARRAY['$50/day hospital cash','ICU double benefit','Day 1 cover after waiting period'],'Daily hospital cash benefit.'),
('bb000001-0000-0000-0000-000000000005','Personal Accident Cover','PAC-001','accident', 3.00, 5000, 0,18,70,10,true, ARRAY['Accidental death','Permanent disability','Temporary disability income','Medical expenses'],'24/7 accident protection.'),
('bb000001-0000-0000-0000-000000000006','Group Funeral Scheme',  'GFS-001','funeral',  3.50,  4000,30,18,80,10,false,ARRAY['Group pricing','Employer facilitated','Payroll deduction'],'Group funeral scheme for employers.')
ON CONFLICT (id) DO NOTHING;

-- 5e. Policies
INSERT INTO public.policies (id, policy_number, client_id, product_id, premium, cover_amount, start_date, end_date, status, beneficiaries, payment_method, agent_id, next_payment_date, last_payment_date) VALUES
('cc000001-0000-0000-0000-000000000001','EMA-2024-001','aa000001-0000-0000-0000-000000000001','bb000001-0000-0000-0000-000000000001', 5,'3000','2024-01-15','2025-01-15','active','[{"name":"Grace Dube","relationship":"Spouse","percentage":100}]','EcoCash','55555555-5555-5555-5555-555555555555','2026-05-15','2026-04-15'),
('cc000001-0000-0000-0000-000000000002','EMA-2024-002','aa000001-0000-0000-0000-000000000001','bb000001-0000-0000-0000-000000000004', 8,  '50','2024-02-01','2025-02-01','active','[{"name":"Grace Dube","relationship":"Spouse","percentage":100}]','EcoCash','55555555-5555-5555-5555-555555555555','2026-05-01','2026-04-01'),
('cc000001-0000-0000-0000-000000000003','EMA-2024-003','aa000001-0000-0000-0000-000000000002','bb000001-0000-0000-0000-000000000002',12,'8000','2024-02-10','2025-02-10','active','[{"name":"John Ndlovu","relationship":"Spouse","percentage":60},{"name":"Thabo Ndlovu","relationship":"Child","percentage":40}]','Bank Transfer','33333333-3333-3333-3333-333333333333','2026-05-10','2026-04-10'),
('cc000001-0000-0000-0000-000000000004','EMA-2024-004','aa000001-0000-0000-0000-000000000003','bb000001-0000-0000-0000-000000000003',10,'10000','2024-03-01','2025-03-01','active','[{"name":"Mary Chirwa","relationship":"Spouse","percentage":100}]','OneMoney','33333333-3333-3333-3333-333333333333','2026-06-01','2026-05-01'),
('cc000001-0000-0000-0000-000000000005','EMA-2024-005','aa000001-0000-0000-0000-000000000004','bb000001-0000-0000-0000-000000000001', 5,'3000','2024-03-15','2025-03-15','active','[{"name":"Peter Mukamuri","relationship":"Spouse","percentage":100}]','EcoCash','55555555-5555-5555-5555-555555555555','2026-05-15','2026-04-15'),
('cc000001-0000-0000-0000-000000000006','EMA-2024-006','aa000001-0000-0000-0000-000000000005','bb000001-0000-0000-0000-000000000005', 3,'5000','2024-04-01','2025-04-01','lapsed','[{"name":"Anna Mhike","relationship":"Spouse","percentage":100}]','Cash','55555555-5555-5555-5555-555555555555',NULL,'2026-01-01'),
('cc000001-0000-0000-0000-000000000007','EMA-2024-007','aa000001-0000-0000-0000-000000000006','bb000001-0000-0000-0000-000000000003',10,'10000','2024-04-20','2025-04-20','active','[{"name":"David Zvobgo","relationship":"Spouse","percentage":50},{"name":"Lisa Zvobgo","relationship":"Child","percentage":50}]','InnBucks','33333333-3333-3333-3333-333333333333','2026-05-20','2026-04-20'),
('cc000001-0000-0000-0000-000000000008','EMA-2024-008','aa000001-0000-0000-0000-000000000007','bb000001-0000-0000-0000-000000000004', 8,  '50','2024-05-05','2025-05-05','active','[{"name":"Fara Muzenda","relationship":"Spouse","percentage":100}]','EcoCash','55555555-5555-5555-5555-555555555555','2026-06-05','2026-05-05'),
('cc000001-0000-0000-0000-000000000009','EMA-2024-009','aa000001-0000-0000-0000-000000000008','bb000001-0000-0000-0000-000000000005', 3,'5000','2024-05-22','2025-05-22','pending','[{"name":"James Hove","relationship":"Spouse","percentage":100}]','Bank Transfer','33333333-3333-3333-3333-333333333333',NULL,NULL),
('cc000001-0000-0000-0000-000000000010','EMA-2024-010','aa000001-0000-0000-0000-000000000009','bb000001-0000-0000-0000-000000000002',12,'8000','2024-06-12','2025-06-12','active','[{"name":"Rose Gumbo","relationship":"Spouse","percentage":100}]','Debit Order','55555555-5555-5555-5555-555555555555','2026-06-12','2026-05-12')
ON CONFLICT (id) DO NOTHING;

-- 5f. Claims
INSERT INTO public.claims (id, claim_number, policy_id, claim_type, amount, status, date_of_event, date_submitted, description, fraud_score, assigned_to, documents, notes, resolved_at) VALUES
('dd000001-0000-0000-0000-000000000001','CLM-2026-001','cc000001-0000-0000-0000-000000000003','Death Benefit',  8000,'under_review','2026-04-28','2026-04-30','Policyholder''s mother passed away on 28 April 2026.',12,'22222222-2222-2222-2222-222222222222',ARRAY['death_cert.pdf','id_copy.pdf'],'Documents verified. Awaiting next of kin confirmation.',NULL),
('dd000001-0000-0000-0000-000000000002','CLM-2026-002','cc000001-0000-0000-0000-000000000002','Hospitalisation',350,'approved','2026-04-15','2026-04-20','7 days hospitalisation at Parirenyatwa Hospital.',5,'22222222-2222-2222-2222-222222222222',ARRAY['hospital_letter.pdf','receipts.pdf'],'All documents verified. 7 days at $50/day.','2026-04-25'),
('dd000001-0000-0000-0000-000000000003','CLM-2026-003','cc000001-0000-0000-0000-000000000006','Accidental Injury',5000,'pending','2026-05-01','2026-05-03','Client involved in road traffic accident.',78,NULL,ARRAY['police_report.pdf'],'High fraud score flagged. Policy lapsed — under review.',NULL),
('dd000001-0000-0000-0000-000000000004','CLM-2026-004','cc000001-0000-0000-0000-000000000007','Disability Benefit',5000,'rejected','2026-03-10','2026-03-15','Claimed permanent disability after workplace accident.',62,'22222222-2222-2222-2222-222222222222',ARRAY['medical_cert.pdf'],'Rejected: certificate from unregistered practitioner.','2026-04-01'),
('dd000001-0000-0000-0000-000000000005','CLM-2026-005','cc000001-0000-0000-0000-000000000010','Death Benefit',  8000,'paid','2026-02-20','2026-02-22','Policyholder''s spouse passed away.',8,'22222222-2222-2222-2222-222222222222',ARRAY['death_cert.pdf','marriage_cert.pdf'],'Paid via EcoCash on 2026-03-05.','2026-03-05')
ON CONFLICT (id) DO NOTHING;

-- 5g. Payments
INSERT INTO public.payments (id, reference, policy_id, amount, method, status, payment_date) VALUES
('ee000001-0000-0000-0000-000000000001','PAY-20260501-001','cc000001-0000-0000-0000-000000000001', 5,'EcoCash',     'completed','2026-05-01'),
('ee000001-0000-0000-0000-000000000002','PAY-20260501-002','cc000001-0000-0000-0000-000000000002', 8,'EcoCash',     'completed','2026-05-01'),
('ee000001-0000-0000-0000-000000000003','PAY-20260502-003','cc000001-0000-0000-0000-000000000003',12,'Bank Transfer','completed','2026-05-02'),
('ee000001-0000-0000-0000-000000000004','PAY-20260503-004','cc000001-0000-0000-0000-000000000004',10,'OneMoney',    'completed','2026-05-03'),
('ee000001-0000-0000-0000-000000000005','PAY-20260504-005','cc000001-0000-0000-0000-000000000005', 5,'EcoCash',     'completed','2026-05-04'),
('ee000001-0000-0000-0000-000000000006','PAY-20260505-006','cc000001-0000-0000-0000-000000000006', 3,'Cash',        'failed',   '2026-05-05'),
('ee000001-0000-0000-0000-000000000007','PAY-20260506-007','cc000001-0000-0000-0000-000000000007',10,'InnBucks',    'completed','2026-05-06'),
('ee000001-0000-0000-0000-000000000008','PAY-20260507-008','cc000001-0000-0000-0000-000000000008', 8,'EcoCash',     'completed','2026-05-07'),
('ee000001-0000-0000-0000-000000000009','PAY-20260508-009','cc000001-0000-0000-0000-000000000010',12,'Debit Order', 'completed','2026-05-08'),
('ee000001-0000-0000-0000-000000000010','PAY-20260509-010','cc000001-0000-0000-0000-000000000004',10,'OneMoney',    'pending',  '2026-05-09'),
('ee000001-0000-0000-0000-000000000011','PAY-20260415-011','cc000001-0000-0000-0000-000000000001', 5,'EcoCash',     'completed','2026-04-15'),
('ee000001-0000-0000-0000-000000000012','PAY-20260410-012','cc000001-0000-0000-0000-000000000003',12,'Bank Transfer','completed','2026-04-10')
ON CONFLICT (id) DO NOTHING;

-- 5h. Tickets
INSERT INTO public.tickets (id, ticket_number, client_id, subject, description, status, priority, category, assigned_to, messages) VALUES
('ff000001-0000-0000-0000-000000000001','TKT-2026-001','aa000001-0000-0000-0000-000000000001',
 'Cannot access my policy documents','I have been trying to download my policy schedule but the link keeps failing.',
 'in_progress','medium','Technical','55555555-5555-5555-5555-555555555555',
 '[{"id":"m1","senderId":"aa000001-0000-0000-0000-000000000001","senderName":"Simba Dube","message":"I cannot download my policy documents.","timestamp":"2026-05-07T10:00:00Z","isStaff":false},{"id":"m2","senderId":"55555555-5555-5555-5555-555555555555","senderName":"Chipo Sibanda","message":"We are looking into the issue.","timestamp":"2026-05-08T09:00:00Z","isStaff":true}]'),
('ff000001-0000-0000-0000-000000000002','TKT-2026-002','aa000001-0000-0000-0000-000000000002',
 'Claim payout not received','My claim CLM-2026-002 was approved but I have not received the payout.',
 'open','urgent','Claims',NULL,
 '[{"id":"m3","senderId":"aa000001-0000-0000-0000-000000000002","senderName":"Nomsa Ndlovu","message":"Please assist with my claim payout.","timestamp":"2026-05-09T08:30:00Z","isStaff":false}]'),
('ff000001-0000-0000-0000-000000000003','TKT-2026-003','aa000001-0000-0000-0000-000000000004',
 'Update beneficiary details','I need to change my beneficiary.',
 'resolved','low','Policy','33333333-3333-3333-3333-333333333333',
 '[{"id":"m4","senderId":"aa000001-0000-0000-0000-000000000004","senderName":"Patience Mukamuri","message":"Please help me update beneficiary details.","timestamp":"2026-04-20T14:00:00Z","isStaff":false},{"id":"m5","senderId":"33333333-3333-3333-3333-333333333333","senderName":"Blessing Moyo","message":"Your beneficiary details have been updated.","timestamp":"2026-04-22T11:00:00Z","isStaff":true}]')
ON CONFLICT (id) DO NOTHING;

-- 5i. Emails
INSERT INTO public.emails (id, from_address, from_name, to_address, subject, body, read, folder, linked_to) VALUES
('a1000001-0000-0000-0000-000000000001','nomsa.ndlovu@gmail.com','Nomsa Ndlovu','info@tariqify.com','Re: Claim CLM-2026-001 - Documents submitted','Dear Tariqify Team,\n\nPlease find attached the required documents for my claim CLM-2026-001.\n\nKindly confirm receipt.\n\nRegards,\nNomsa Ndlovu',false,'inbox','CLM-2026-001'),
('a1000001-0000-0000-0000-000000000002','info@tariqify.com','Tariqify IMS','simba.dube@gmail.com','Your policy EMA-2024-001 premium reminder','Dear Simba Dube,\n\nThis is a friendly reminder that your funeral cover premium of $5.00 is due on 15 May 2026.\n\nRegards,\nEnpassent Multiple Agents',true,'sent','EMA-2024-001'),
('a1000001-0000-0000-0000-000000000003','garikai.mhike@gmail.com','Garikai Mhike','info@tariqify.com','Policy reinstatement request','Good morning,\n\nI would like to reinstate my policy EMA-2024-006.\n\nGarikai Mhike',true,'inbox',NULL),
('a1000001-0000-0000-0000-000000000004','info@tariqify.com','Tariqify IMS','tafa.chirwa@gmail.com','Welcome to Tariqify IMS - Policy EMA-2024-004','Dear Tafadzwa Chirwa,\n\nWelcome to Enpassent Multiple Agents! Your Life Cover Essential policy is now active.\n\nEnpassent Multiple Agents',true,'sent','EMA-2024-004')
ON CONFLICT (id) DO NOTHING;

-- 5j. Leads
INSERT INTO public.leads (id, name, email, phone, source, product_interest, status, intent_score, assigned_to) VALUES
('b1000001-0000-0000-0000-000000000001','Tanaka Mushore',  'tanaka.m@gmail.com', '+263 77 100 2000','WhatsApp Chatbot','Funeral Cover Basic',  'new',       82,'55555555-5555-5555-5555-555555555555'),
('b1000001-0000-0000-0000-000000000002','Sekai Choto',     NULL,                 '+263 73 200 3000','USSD *907#',       'Hospital Cash Plan',   'contacted', 65,'55555555-5555-5555-5555-555555555555'),
('b1000001-0000-0000-0000-000000000003','Farai Madzima',   'farai.m@yahoo.com',  '+263 78 300 4000','Referral',         'Life Cover Essential', 'qualified', 91,'55555555-5555-5555-5555-555555555555'),
('b1000001-0000-0000-0000-000000000004','Nyasha Banda',    NULL,                 '+263 71 400 5000','Facebook Ad',      'Personal Accident Cover','proposal', 55,'55555555-5555-5555-5555-555555555555'),
('b1000001-0000-0000-0000-000000000005','Tariro Mutumhe',  'tariro.m@gmail.com', '+263 77 500 6000','Walk-in',          'Funeral Cover Premium','converted', 95,'55555555-5555-5555-5555-555555555555')
ON CONFLICT (id) DO NOTHING;
