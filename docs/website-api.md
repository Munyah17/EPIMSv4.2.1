# motions.co.zw → Portal API Bridge

**Rule #1: the website never writes to Supabase directly.** All
registrations and payments go through `api/website-register.ts` on the
portal. A direct DB write is how Nelson's client row got created while
his policy insert failed silently — inside this endpoint a failure is
either fully rolled back or reported, never silent.

## Auth

Machine-to-machine. Send the shared secret on every call:

```
Authorization: Bearer <WEBSITE_API_SECRET>
```

Set it in the website's environment (Vercel/Netlify/wherever
motions.co.zw lives) as `WEBSITE_API_SECRET`. The same value is in
`Desktop\website_api_secret.txt` and Vercel env vars. If it's ever
unset server-side, `NOTIFY_SECRET`/`CRON_SECRET` also work.

## Endpoints

### 1. Register + start payment

`POST https://portal.motions.co.zw/api/website-register`

```json
{
  "name": "Nelson Mweeresani",
  "nationalId": "631409494R25",
  "phone": "263773282155",
  "email": "nellywacho@gmail.com",
  "dob": "1990-07-05",
  "gender": "male",
  "address": "517 Godzonga Street, Old Mabvuku, Harare",
  "occupation": "Boiler Operator",
  "agentId": "optional profiles.id",
  "productCode": "FUN0002",
  "dependants": [
    { "name": "Spouse Name", "nationalId": "…", "dob": "1985-01-01", "relationship": "Spouse", "gender": "female" }
  ],
  "paymentMethod": "paynow",
  "currency": "USD",
  "payerEmail": "nellywacho@gmail.com",
  "origin": "https://www.motions.co.zw"
}
```

`productCode` matches `products.code` (FUN001, FUN0002, FUN0003,
HCP001, HCP002, MED101, MED102, FTF101-103…) — the portal's products
table is the source of truth, so list products from
`GET /api/v1/products` if you need them dynamic.

**Success — Paynow (200):**
```json
{
  "ok": true, "clientId": "…", "clientName": "Nelson Mweeresani",
  "policyId": "…", "policyNumber": "FCP0503",
  "reference": "FCP0503-XXXX", "method": "paynow",
  "redirectUrl": "https://www.paynow.co.zw/…", "pollUrl": "https://…",
  "amount": 10.26
}
```
Redirect the payer to `redirectUrl`. Confirmation reaches our own
`api/paynow-webhook.ts` — the policy activates and the payment is
recorded exactly like a portal sale.

**Success — EcoCash (200):**
```json
{ "ok": true, "method": "ecocash", "lookupUrl": "https://…", "message": "PIN prompt sent…" }
```
The payer's phone gets the PIN prompt. Poll `lookupUrl` (it's the EIP
status URL) or call the status action below.

**Payment failed (402):**
```json
{ "ok": false, "code": "PAYMENT_FAILED", "error": "…",
  "policyId": "…", "policyNumber": "FCP0503" }
```
The client+policy exist as `pending` — show "payment failed, try
again" and let them retry; a retry reuses the same policy (no
duplicates). No money was taken.

**Registration failed (5xx/4xx):** nothing was charged and any
partially-created client row is deleted. Safe to retry outright —
submission is idempotent on `nationalId`.

### 2. Status lookup — the tally-up

```json
{ "action": "status", "reference": "FCP0503-XXXX" }
```
→ `{ ok, transaction: {status, confirmed_amount, …}, policy: {policy_number, status} }`

Use it for your "payment successful" page — `transaction.status` is
`paid`/`failed`/`pending`/`mismatch`, `policy.status` flips from
`pending` once paid. If you ever see `paid` with the policy still
`pending`, that's a real anomaly the office's recon scan also catches.

## What the website must change

1. **Stop calling Supabase at all.** No supabase-js, no service key on
   the website — remove them from its env.
2. Its own Paynow integration can stay for the redirect UX, but the
   payment should be **initiated by us** (the `redirectUrl` above) so
   confirmation lands on our webhook — that's what makes tallying
   possible. Paynow posts statuses to OUR endpoint; yours is just a
   redirect back to the result page.
3. On register success, store the `reference` — it's the join key for
   every status check and for support.

## Failure semantics (the money rules)

| Event | What the caller sees | What the data shows |
|---|---|---|
| Registration insert fails | `5xx {code:'REGISTRATION_FAILED'}` — nothing charged | No rows (new client deleted as compensation) |
| Product unknown/inactive | `400` | Nothing |
| Client already covered | `409 {code:'ALREADY_COVERED'}` | Existing live policy untouched |
| Payment initiation fails | `402 {code:'PAYMENT_FAILED'}` | client+policy `pending` — retryable |
| Payer abandons Paynow | — | `paynow_transactions` pending → recon flags it at 24h |
| Payer pays, policy still pending | — | recon flags `paid_but_pending` — office resolves |

## Still missing server-side

- `EIP_*` credentials for the EcoCash branch — until set, EcoCash
  returns `503` and callers should offer Paynow.
