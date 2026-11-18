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

-- Exactly one live conversation per phone number. Meta can deliver two
-- messages (or a retry) at the same moment; without this both requests can
-- read "no session" and create parallel flows. Existing duplicate open
-- sessions are transient state, so keep the newest before indexing.
DELETE FROM public.wa_sessions older
USING public.wa_sessions newer
WHERE older.phone_number = newer.phone_number
  AND NOT older.is_expired AND NOT newer.is_expired
  AND older.created_at < newer.created_at;

CREATE UNIQUE INDEX IF NOT EXISTS wa_sessions_phone_open_unique
  ON wa_sessions (phone_number) WHERE NOT is_expired;

-- Idempotency ledger for Meta delivery retries. The webhook inserts each
-- inbound message id before dispatching; a retried POST hits the primary
-- key and is acknowledged without replaying a payment or registration step.
CREATE TABLE IF NOT EXISTS wa_inbound_events (
  message_id   text PRIMARY KEY,             -- Meta message id, e.g. wamid.…
  phone_number text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wa_inbound_events_received_at
  ON wa_inbound_events (received_at DESC);

ALTER TABLE wa_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE wa_inbound_events ENABLE ROW LEVEL SECURITY;

-- No anon/authenticated policies on purpose: every access goes through
-- the service-role key inside api/.
