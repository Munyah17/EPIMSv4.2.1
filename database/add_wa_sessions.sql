-- WhatsApp chatbot conversation sessions.
--
-- One open session per phone number. `state` names the step the caller
-- is on (e.g. 'REG_POLICY_SELECTION'); `note` is the session's working
-- memory — every answer collected so far lives there until the flow
-- commits it to real tables or the session dies.
--
-- Server-side only: the bot runs inside api/whatsapp-webhook.ts with the
-- service role. No public/client policy — browsers have no business
-- reading other people's conversations.

CREATE TABLE IF NOT EXISTS wa_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number  text NOT NULL,           -- E.164 without '+', as WhatsApp reports it
  contact_type  text NOT NULL DEFAULT 'unknown',   -- 'agent' | 'client' | 'unknown'
  state         text NOT NULL,
  note          jsonb NOT NULL DEFAULT '{}',
  is_expired    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wa_sessions_phone_open
  ON wa_sessions (phone_number) WHERE NOT is_expired;

ALTER TABLE wa_sessions ENABLE ROW LEVEL SECURITY;

-- No anon/authenticated policies on purpose: every access goes through
-- the service-role key inside api/.
