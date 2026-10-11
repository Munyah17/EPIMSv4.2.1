-- Gender on clients.
--
-- Free text, not an enum: 'male'/'female' cover most, but the WhatsApp
-- bot offers an 'Other' option that stores whatever the client types —
-- a CHECK constraint would reject exactly the values that option exists
-- to capture. Dependant gender lives inside policies.dependants JSONB
-- and needs no column.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS gender text;
