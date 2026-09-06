-- The float an API-integrated partner (a "Digital Agent" -- same standing
-- as an on-the-ground agent, just selling through their own app instead of
-- a human at a desk) keeps with us. Unlike a human agent, a Digital Agent
-- collects money themselves and settles with the company separately, so a
-- policy can only ever be issued against money already on deposit here --
-- never on the strength of a sale they merely claim to have made.
--
-- Agriculture is the deliberate exception: it is billed once a year via
-- Stop Order (paid only once the grower sells their crop), so it is never
-- funded from the float at all. Because that means real cover is issued on
-- our name with no money in hand yet, it is off by default and must be
-- switched on per developer by a Super Admin -- exactly the fraud surface
-- this whole wallet exists to close everywhere else.
ALTER TABLE public.api_developers
  ADD COLUMN IF NOT EXISTS wallet_balance NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (wallet_balance >= 0),
  ADD COLUMN IF NOT EXISTS agriculture_enabled BOOLEAN NOT NULL DEFAULT false;

-- Every movement of the float, both directions: a top-up (Super Admin,
-- after money actually arrives from the partner's own settlement) and a
-- debit (the API automatically, the instant a non-agriculture policy is
-- issued against it). Kept as an append-only ledger rather than just the
-- running balance column, so "why does this partner have this balance" is
-- always answerable from the record itself, not from memory.
CREATE TABLE IF NOT EXISTS public.api_wallet_transactions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  developer_id  UUID NOT NULL REFERENCES public.api_developers(id) ON DELETE CASCADE,
  type          TEXT NOT NULL CHECK (type IN ('topup', 'policy_debit', 'adjustment')),
  amount        NUMERIC(12,2) NOT NULL,
  balance_after NUMERIC(12,2) NOT NULL,
  policy_id     UUID REFERENCES public.policies(id) ON DELETE SET NULL,
  note          TEXT,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS api_wallet_transactions_developer_idx
  ON public.api_wallet_transactions(developer_id, created_at DESC);

ALTER TABLE public.api_wallet_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_wallet_transactions FORCE ROW LEVEL SECURITY;

-- Staff can read the ledger (the same audience that already manages
-- developers/keys on the Developers & API page); every write happens
-- through the service-role key in api/v1.ts (debits) and the staff admin
-- action (top-ups), never directly from a client.
DROP POLICY IF EXISTS "api_wallet_transactions_select_staff" ON public.api_wallet_transactions;
CREATE POLICY "api_wallet_transactions_select_staff" ON public.api_wallet_transactions
  FOR SELECT TO authenticated USING (public.is_staff());
