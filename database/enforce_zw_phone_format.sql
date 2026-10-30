-- Enforce the Zimbabwean phone format at the database itself, so no
-- write path — portal, partner API, WhatsApp bot, CSV import, or a hand
-- edit — can store a number the rest of the system can't use:
--
--   "+263" followed by exactly 9 digits   (e.g. +263773909307)
--   10 digits starting with 0             (e.g. 0773909307)
--
-- Spaces and dashes are ignored when checking (the portal's phone input
-- stores "+263 77 123 4567"), so both written forms pass as the same
-- number — matching src/lib/validation.ts and api/_lib/zwFormats.ts.
--
-- The constraints are added NOT VALID: they reject every NEW write that
-- doesn't comply, but the check doesn't scan the table yet, so rows
-- written before this rule existed don't block the migration.
--
-- STEP 1 — audit. Run the SELECT below and fix what it lists (Edit
-- Client in the portal applies the same rule, so corrections are easy).
-- STEP 2 — once the audit is clean, run the VALIDATE CONSTRAINT lines
-- at the bottom to make the check cover existing rows too.

SELECT 'clients' AS tbl, id, phone FROM clients
  WHERE phone IS NOT NULL AND phone <> ''
    AND regexp_replace(phone, '[\s-]', '', 'g') !~ '^(\+263[0-9]{9}|0[0-9]{9})$'
UNION ALL
SELECT 'leads', id, phone FROM leads
  WHERE phone IS NOT NULL AND phone <> ''
    AND regexp_replace(phone, '[\s-]', '', 'g') !~ '^(\+263[0-9]{9}|0[0-9]{9})$'
UNION ALL
SELECT 'group_members', id, phone FROM group_members
  WHERE phone IS NOT NULL AND phone <> ''
    AND regexp_replace(phone, '[\s-]', '', 'g') !~ '^(\+263[0-9]{9}|0[0-9]{9})$'
UNION ALL
SELECT 'groups.org_phone', id, org_phone FROM groups
  WHERE org_phone IS NOT NULL AND org_phone <> ''
    AND regexp_replace(org_phone, '[\s-]', '', 'g') !~ '^(\+263[0-9]{9}|0[0-9]{9})$'
UNION ALL
SELECT 'groups.contact_phone', id, contact_phone FROM groups
  WHERE contact_phone IS NOT NULL AND contact_phone <> ''
    AND regexp_replace(contact_phone, '[\s-]', '', 'g') !~ '^(\+263[0-9]{9}|0[0-9]{9})$'
UNION ALL
SELECT 'profiles', id, phone FROM profiles
  WHERE phone IS NOT NULL AND phone <> ''
    AND regexp_replace(phone, '[\s-]', '', 'g') !~ '^(\+263[0-9]{9}|0[0-9]{9})$'
UNION ALL
SELECT 'agent_profiles.ecocash_number', profile_id::text, ecocash_number FROM agent_profiles
  WHERE ecocash_number IS NOT NULL AND ecocash_number <> ''
    AND regexp_replace(ecocash_number, '[\s-]', '', 'g') !~ '^(\+263[0-9]{9}|0[0-9]{9})$'
UNION ALL
SELECT 'marketing_contacts', id, phone FROM marketing_contacts
  WHERE phone IS NOT NULL AND phone <> ''
    AND regexp_replace(phone, '[\s-]', '', 'g') !~ '^(\+263[0-9]{9}|0[0-9]{9})$';

-- The constraint itself: phone is required on clients, so that table
-- gets the strict form; every other column is nullable and an empty
-- value is treated as "no number" rather than a bad one.
ALTER TABLE clients
  ADD CONSTRAINT clients_phone_zw CHECK (
    regexp_replace(phone, '[\s-]', '', 'g') ~ '^(\+263[0-9]{9}|0[0-9]{9})$'
  ) NOT VALID;

ALTER TABLE leads
  ADD CONSTRAINT leads_phone_zw CHECK (
    phone IS NULL OR phone = ''
    OR regexp_replace(phone, '[\s-]', '', 'g') ~ '^(\+263[0-9]{9}|0[0-9]{9})$'
  ) NOT VALID;

ALTER TABLE group_members
  ADD CONSTRAINT group_members_phone_zw CHECK (
    phone IS NULL OR phone = ''
    OR regexp_replace(phone, '[\s-]', '', 'g') ~ '^(\+263[0-9]{9}|0[0-9]{9})$'
  ) NOT VALID;

ALTER TABLE groups
  ADD CONSTRAINT groups_org_phone_zw CHECK (
    org_phone IS NULL OR org_phone = ''
    OR regexp_replace(org_phone, '[\s-]', '', 'g') ~ '^(\+263[0-9]{9}|0[0-9]{9})$'
  ) NOT VALID;

ALTER TABLE groups
  ADD CONSTRAINT groups_contact_phone_zw CHECK (
    contact_phone IS NULL OR contact_phone = ''
    OR regexp_replace(contact_phone, '[\s-]', '', 'g') ~ '^(\+263[0-9]{9}|0[0-9]{9})$'
  ) NOT VALID;

ALTER TABLE profiles
  ADD CONSTRAINT profiles_phone_zw CHECK (
    phone IS NULL OR phone = ''
    OR regexp_replace(phone, '[\s-]', '', 'g') ~ '^(\+263[0-9]{9}|0[0-9]{9})$'
  ) NOT VALID;

ALTER TABLE agent_profiles
  ADD CONSTRAINT agent_profiles_ecocash_number_zw CHECK (
    ecocash_number IS NULL OR ecocash_number = ''
    OR regexp_replace(ecocash_number, '[\s-]', '', 'g') ~ '^(\+263[0-9]{9}|0[0-9]{9})$'
  ) NOT VALID;

ALTER TABLE marketing_contacts
  ADD CONSTRAINT marketing_contacts_phone_zw CHECK (
    regexp_replace(phone, '[\s-]', '', 'g') ~ '^(\+263[0-9]{9}|0[0-9]{9})$'
  ) NOT VALID;

-- After the audit SELECT returns zero rows, promote each constraint so
-- the check also covers the rows that already existed:
--
-- ALTER TABLE clients            VALIDATE CONSTRAINT clients_phone_zw;
-- ALTER TABLE leads              VALIDATE CONSTRAINT leads_phone_zw;
-- ALTER TABLE group_members      VALIDATE CONSTRAINT group_members_phone_zw;
-- ALTER TABLE groups             VALIDATE CONSTRAINT groups_org_phone_zw;
-- ALTER TABLE groups             VALIDATE CONSTRAINT groups_contact_phone_zw;
-- ALTER TABLE profiles           VALIDATE CONSTRAINT profiles_phone_zw;
-- ALTER TABLE agent_profiles     VALIDATE CONSTRAINT agent_profiles_ecocash_number_zw;
-- ALTER TABLE marketing_contacts VALIDATE CONSTRAINT marketing_contacts_phone_zw;
