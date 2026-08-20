-- payments.method rejected three methods the app can actually produce, so
-- those payments failed at the database instead of being recorded:
--
--   'Stop Order'      - how agriculture premiums are collected (annual
--                       stop order), offered in RecordPaymentModal.
--   'Airtime Balance' - also offered in RecordPaymentModal.
--   'Zipit'           - written by the online payment modal's bank
--                       transfer rail (ZimSwitch ZIPIT).
--
-- The constraint is widened to exactly the PaymentMethod union in
-- src/types/index.ts, so anything the app can offer, the database accepts.

ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_method_check;
ALTER TABLE public.payments ADD CONSTRAINT payments_method_check
  CHECK (method IN (
    'EcoCash',
    'OneMoney',
    'InnBucks',
    'Airtime Balance',
    'Bank Transfer',
    'Cash',
    'Debit Order',
    'Stop Order',
    'Paynow',
    'Zipit',
    'Card'
  ));
