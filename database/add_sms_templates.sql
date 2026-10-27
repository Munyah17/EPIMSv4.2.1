-- Staff-editable SMS notification templates (Bulk SMS → Templates tab).
--
-- Each row overrides the built-in text for one notification type, either
-- for every product (product_id IS NULL — the "All products" default) or
-- for one product specifically. Resolution at send time:
--   product's own template  →  type-wide (NULL product) template  →
--   built-in wording in src/lib/smsText.ts.
-- Bodies carry {placeholders} (e.g. {clientName}, {policyNumber},
-- {premium}) that are substituted per send — see src/lib/smsTemplates.ts.
--
-- Reads: any staff member (templates are needed to SEND as well as to
-- edit — a staff browser composes texts with them). Writes: admin only,
-- same tier as app_settings, because this is client-facing wording.

CREATE TABLE IF NOT EXISTS public.sms_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type  TEXT NOT NULL CHECK (event_type IN (
                'registration_confirmation',
                'client_registered',
                'group_registered',
                'payment_received',
                'payment_failed',
                'premium_reminder',
                'policy_lapsed',
                'invoice_issued',
                'claim_update',
                'ticket_update'
              )),
  product_id  UUID REFERENCES public.products(id) ON DELETE CASCADE,
  body        TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by  UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One template per (type, product); the NULL-product "all products" row
-- counts as one product for uniqueness purposes (NULLs never collide in
-- a plain unique constraint, so the COALESCE is required).
CREATE UNIQUE INDEX IF NOT EXISTS sms_templates_event_product_uq
  ON public.sms_templates (event_type, COALESCE(product_id, '00000000-0000-0000-0000-000000000000'::uuid));

ALTER TABLE public.sms_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_templates FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sms_templates_select_staff" ON public.sms_templates;
CREATE POLICY "sms_templates_select_staff" ON public.sms_templates
  FOR SELECT TO authenticated USING (is_staff());

DROP POLICY IF EXISTS "sms_templates_write_admin" ON public.sms_templates;
CREATE POLICY "sms_templates_write_admin" ON public.sms_templates
  FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());

-- Scrub banned wording from any template saved before the REG ban.
-- The send border (api/_lib/smsCanon.ts stripBannedText) rewrites
-- outgoing text anyway — this keeps the STORED body matching what
-- actually goes out so staff aren't editing ghosts. Idempotent.
--   "reg no."/"reg number" kept via the CHR(1) placeholder (PG
--   regex has no lookahead), then:
--   " reg."/"registered."  -> "."
--   bare "reg"/"regs"      -> removed (incl. "REG:" envelope bits)
--   "registration(s)"     -> "signup"
UPDATE public.sms_templates SET body = trim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
    regexp_replace(body, '\mreg\M(\s+(?:no\.?|number)\M)', chr(1) || '\1', 'gi'),
    '\mreg(?:istered)?\.{1,2}', '.', 'gi'),
    '\mregs?\M\s*[:.\-—–|]?', '', 'gi'),
    '\mregistrations?\M', 'signup', 'gi'),
    '\s+([.,!?;:])', '\1', 'g'),
  '\s{2,}', ' ', 'g'))
WHERE body ~* '\mreg';
UPDATE public.sms_templates SET body = replace(body, chr(1), 'reg')
WHERE position(chr(1) in body) > 0;
