-- paynow_transactions.policy_id references policies(id), but website
-- signups are tracked against pending_policies rows until payment
-- finalizes them — the FK rejects those ids, so api/_lib/paynowInitiate.ts's
-- tracking insert fails silently for every website-initiated Paynow
-- transaction. The webhook then has no row to reconcile against.
--
-- policy_id legitimately points at EITHER table depending on the channel
-- (portal/bot payments -> policies, website checkout -> pending_policies),
-- so the constraint cannot name a single target. The column is app-
-- validated (UUID checked at initiate; webhook resolves both tables), so
-- the FK is dropped rather than replaced.
ALTER TABLE public.paynow_transactions
  DROP CONSTRAINT IF EXISTS paynow_transactions_policy_id_fkey;
