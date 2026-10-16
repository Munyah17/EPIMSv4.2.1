-- ================================================================
-- MARKETING MODULE - SMS & Email Campaigns
-- Adds marketing contacts, campaigns, and message templates
-- ================================================================

-- ----------------------------------------------------------------
-- 1. MARKETING CONTACTS
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.marketing_contacts (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            TEXT NOT NULL,
  phone           TEXT NOT NULL,
  normalized_phone TEXT NOT NULL,
  email           TEXT,
  insurance_interest TEXT,
  source          TEXT,
  marketing_permission BOOLEAN NOT NULL DEFAULT true,
  opted_out       BOOLEAN NOT NULL DEFAULT false,
  opted_out_at    TIMESTAMPTZ,
  opt_out_reason  TEXT,
  opt_out_channel TEXT, -- 'sms' or 'email'
  lead_id         UUID REFERENCES public.leads(id) ON DELETE SET NULL,
  notes           TEXT,
  created_by      UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique constraint on normalized phone (only for active contacts)
CREATE UNIQUE INDEX IF NOT EXISTS idx_marketing_contacts_phone 
  ON public.marketing_contacts(normalized_phone) WHERE opted_out = false;

-- Indexes for filtering
CREATE INDEX IF NOT EXISTS idx_marketing_contacts_interest ON public.marketing_contacts(insurance_interest);
CREATE INDEX IF NOT EXISTS idx_marketing_contacts_opted_out ON public.marketing_contacts(opted_out);
CREATE INDEX IF NOT EXISTS idx_marketing_contacts_source ON public.marketing_contacts(source);

-- ----------------------------------------------------------------
-- 2. MESSAGE TEMPLATES
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.marketing_templates (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            TEXT NOT NULL,
  title           TEXT,
  description     TEXT NOT NULL,
  category        TEXT, -- e.g., 'welcome', 'promotion', 'reminder'
  active          BOOLEAN NOT NULL DEFAULT true,
  created_by      UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_marketing_templates_active ON public.marketing_templates(active);

-- ----------------------------------------------------------------
-- 3. SMS & EMAIL CAMPAIGNS
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.marketing_campaigns (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            TEXT NOT NULL,
  title           TEXT,
  description     TEXT NOT NULL,
  channel         TEXT NOT NULL CHECK (channel IN ('sms','email','both')),
  recipient_count INT NOT NULL,
  sms_segment_count INT NOT NULL DEFAULT 0,
  estimated_sms_cost NUMERIC(10,2),
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','scheduled','sending','completed','cancelled')),
  scheduled_for   TIMESTAMPTZ,
  sent_at         TIMESTAMPTZ,
  created_by      UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_marketing_campaigns_status ON public.marketing_campaigns(status);

-- ----------------------------------------------------------------
-- 4. CAMPAIGN RECIPIENTS (delivery tracking)
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.marketing_campaign_recipients (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  campaign_id     UUID NOT NULL REFERENCES public.marketing_campaigns(id) ON DELETE CASCADE,
  contact_id      UUID NOT NULL REFERENCES public.marketing_contacts(id) ON DELETE CASCADE,
  phone           TEXT,
  email           TEXT,
  sms_status      TEXT CHECK (sms_status IN ('pending','queued','sent','delivered','failed','opted_out')),
  email_status    TEXT CHECK (email_status IN ('pending','queued','sent','delivered','failed','opted_out')),
  sms_message_id  TEXT,
  email_message_id TEXT,
  error_message   TEXT,
  sent_at         TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_marketing_campaign_recipients_campaign ON public.marketing_campaign_recipients(campaign_id);
CREATE INDEX IF NOT EXISTS idx_marketing_campaign_recipients_status ON public.marketing_campaign_recipients(sms_status, email_status);

-- ----------------------------------------------------------------
-- 5. ROW LEVEL SECURITY
-- ----------------------------------------------------------------
ALTER TABLE public.marketing_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_campaign_recipients ENABLE ROW LEVEL SECURITY;

-- Marketing contacts: staff can read/write, super_admin can delete
CREATE POLICY "marketing_contacts_select" ON public.marketing_contacts FOR SELECT TO authenticated USING (is_staff());
CREATE POLICY "marketing_contacts_write" ON public.marketing_contacts FOR ALL TO authenticated USING (is_staff()) WITH CHECK (is_staff());
CREATE POLICY "marketing_contacts_delete" ON public.marketing_contacts FOR DELETE TO authenticated USING (current_user_role() = 'super_admin');

-- Templates: staff can read/write, super_admin can delete
CREATE POLICY "marketing_templates_select" ON public.marketing_templates FOR SELECT TO authenticated USING (is_staff());
CREATE POLICY "marketing_templates_write" ON public.marketing_templates FOR ALL TO authenticated USING (is_staff()) WITH CHECK (is_staff());
CREATE POLICY "marketing_templates_delete" ON public.marketing_templates FOR DELETE TO authenticated USING (current_user_role() = 'super_admin');

-- Campaigns: staff can read/write, super_admin can delete
CREATE POLICY "marketing_campaigns_select" ON public.marketing_campaigns FOR SELECT TO authenticated USING (is_staff());
CREATE POLICY "marketing_campaigns_write" ON public.marketing_campaigns FOR ALL TO authenticated USING (is_staff()) WITH CHECK (is_staff());
CREATE POLICY "marketing_campaigns_delete" ON public.marketing_campaigns FOR DELETE TO authenticated USING (current_user_role() = 'super_admin');

-- Campaign recipients: staff can read/write
CREATE POLICY "marketing_campaign_recipients_select" ON public.marketing_campaign_recipients FOR SELECT TO authenticated USING (is_staff());
CREATE POLICY "marketing_campaign_recipients_write" ON public.marketing_campaign_recipients FOR ALL TO authenticated USING (is_staff()) WITH CHECK (is_staff());

-- ----------------------------------------------------------------
-- 6. TRIGGERS
-- ----------------------------------------------------------------
CREATE TRIGGER marketing_contacts_updated_at BEFORE UPDATE ON public.marketing_contacts
  FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

CREATE TRIGGER marketing_templates_updated_at BEFORE UPDATE ON public.marketing_templates
  FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

CREATE TRIGGER marketing_campaigns_updated_at BEFORE UPDATE ON public.marketing_campaigns
  FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

-- ----------------------------------------------------------------
-- 7. SEED TEMPLATES
-- ----------------------------------------------------------------
INSERT INTO public.marketing_templates (name, title, description, category) VALUES
('Welcome Message', 'Welcome to Motions Microinsurance', 'Dear {name}, welcome to Motions Microinsurance! We offer affordable insurance solutions for you and your family. Reply YES to learn more about our products.', 'welcome'),
('Promotion - Funeral', 'Affordable Funeral Cover', 'Dear {name}, protect your family with our affordable funeral cover starting from just $X/month. No medical tests required. Call us today!', 'promotion'),
('Promotion - Agriculture', 'Crop Insurance for Farmers', 'Dear {name}, safeguard your harvest with our crop insurance. Covers hail, fire, and drought. Contact us for a quote.', 'promotion'),
('Reminder - Payment', 'Premium Payment Reminder', 'Dear {name}, this is a friendly reminder that your insurance premium is due. Please pay to maintain your active cover.', 'reminder')
ON CONFLICT DO NOTHING;

-- ================================================================
-- DONE
-- ================================================================
