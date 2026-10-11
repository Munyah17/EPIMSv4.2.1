# Motions WhatsApp Bot

The insurance chatbot, rebuilt inside this repo — it replaces the old
Frappe app (`motions_bot`) entirely. It runs as a Vercel serverless
function on the same deployment as the portal, reads and writes the same
live Supabase tables, and bills through the same Paynow / EcoCash
integrations. A client who registers over WhatsApp appears in the IMS
immediately; a payment made there is reconciled by the same webhook the
portal uses.

## Table of contents

1. [How a message travels](#how-a-message-travels)
2. [The state machine](#the-state-machine)
3. [Menus and flows](#menus-and-flows)
4. [Where everything lives](#where-everything-lives)
5. [One-time setup (do these in order)](#one-time-setup)
6. [Environment variables](#environment-variables)
7. [Testing without a real WhatsApp](#testing-without-a-real-whatsapp)
8. [Differences from the Frappe bot](#differences-from-the-frappe-bot)
9. [Troubleshooting](#troubleshooting)

---

## How a message travels

```
WhatsApp user texts the business number
        │  Meta Cloud API POSTs the event
        ▼
api/whatsapp-webhook.ts
   ├─ GET  → Meta handshake (verify token → echo challenge)
   └─ POST → check X-Hub-Signature-256 (if WHATSAPP_APP_SECRET is set)
           → for each message, normalise to ONE string:
               text        → the message body
               document    → "filename: X |||| id: Y"  (claim uploads)
               button tap  → the button's id (e.g. "pay", "USD", "add")
               list pick   → the row's id
        ▼
api/_lib/bot/engine.ts — dispatchMessage()
   ├─ findContact(phone): profiles(role=agent) → clients → "unknown"
   ├─ find open wa_sessions row (60-minute lifetime)
   │     expired → delete, restart
   │     "exit"  → wipe working memory, drop to main menu
   └─ HANDLER_MAP[contact type][session.state](ctx)
        ▼
   the handler validates input → saves answers into session.note
   → sends the next WhatsApp prompt → advances session.state
        ▼
   at flow end: write real rows (clients / policies / dependants /
   claims), send the EcoCash push or Paynow link, delete the session.
```

Every answer the user gives during a flow lands in the session's `note`
(JSONB) — that is the flow's working memory. Nothing becomes a real
database row until the final confirm, so a half-finished or cancelled
conversation never leaves orphan clients or policies.

## The state machine

A session row is `{ phone_number, contact_type, state, note, created_at }`.
`state` names the step the user is on; the matching handler owns that
step — it checks the answer, stores it, prompts the next question and
moves the state forward. If a state has no handler (a bug), the session
is deleted and the user is told to start again — a clean reset beats a
conversation stuck on a broken step.

State names are prefixed per flow so the three menus never collide:

| Prefix | Belongs to |
|---|---|
| `REG_` | registration (unknown numbers) |
| `CPAY_` `CVIEW_` `CADD_` `CCLAIM_` `CDEP_` | client menu flows |
| `AC_` `AD_` `APAY_` | agent menu flows |
| `*_CURRENCY` `*_METHOD` `*_ECOCASH` `*_CONFIRM` | the shared payment tail (`tail.ts`) |

## Menus and flows

**Unknown number → registration menu**
1. Register → full name → national ID → date of birth → email (or `1` to
   skip) → pick a product → payment currency → payment method →
   (EcoCash number if EcoCash) → confirm → client + pending policy are
   created → payment instruction sent.
2. View available products — a real list from the `products` table.
3. Payment methods — the real method list.

**Existing client (their `clients.phone` matches)**
1. Make Payment → pick policy → months (1–12) → tail → charged
   `premium × months`.
2. My Policies → lists live policies + dependants → "Add New Policy"
   runs the product → tail path (creates a second policy, `pending`).
3. Renew Policy → pick policy → months → tail. Renewal is a payment:
   the Paynow webhook advances `next_payment_date` per period paid and
   reinstates `lapsed` policies — the same code path the portal uses.
4. Claims → pick policy → send a document/photo → a `claims` row is
   filed at `intake` stage with the WhatsApp media id recorded — staff
   see it on the Claims page.
5. Dependants → Add (dependant wizard → pick sponsor policy → pick
   their cover → tail; the dependant is appended to the policy's
   `dependants` JSONB) / Remove (sends a removal request — no actual
   deletion, needs staff approval) / View.

**Agent (`profiles.role='agent'`, matched by `profiles.phone`)**
1. Add New Client → the client's details + product → tail; client and
   policy are created **at confirm** with `agent_id` set.
2. Add New Dependant → sponsor's national ID → sponsor's policy →
   dependant wizard → tail.
3. My Clients → `clients WHERE agent_id = agent's profile`.
4. Commission → real figure: `premium × products.commission_pct` summed
   over every live policy on the agent's book — the same field the
   portal's commission reporting reads.
5. Make Payment → client's national ID → their policies → months → tail.

**Payment tail (shared by every flow)**
Currency (USD / ZiG) → method menu → three real channels, in the
portal's own vocabulary (`PORTAL_METHOD_NAMES` maps them to what
`policies.payment_method` records):
- `EcoCash` → direct PIN push via `chargeEip` — the payer's phone gets
  the prompt
- `Paynow` → checkout link via `initiatePaynowPayment` — cards,
  InnBucks, ZimSwitch and bank all ride it
- `Office payment` → instructions + reference; staff record it and the
  policy activates identically

ZiG converts through the latest `exchange_rates` row — same rule as the
portal. References are `POLICYNUMBER-xxxx` and every Paynow transaction
writes a `paynow_transactions` row, so `api/paynow-webhook.ts`
reconciles them exactly like a portal payment — including advancing
`next_payment_date` and reinstating lapsed policies (that is what makes
"Renew Policy" a real flow, not a stub).

## Where everything lives

| File | Job |
|---|---|
| `api/whatsapp-webhook.ts` | GET verify + POST entry point, HMAC check, message normalisation |
| `api/_lib/bot/engine.ts` | classify contact → find/create session → dispatch to handler map |
| `api/_lib/bot/store.ts` | `wa_sessions` CRUD, 60-min expiry, note merging |
| `api/_lib/bot/types.ts` | `WaSession`, `Ctx`, `Contact`, handler signature |
| `api/_lib/bot/whatsapp.ts` | the four senders: text, buttons, list, document |
| `api/_lib/bot/data.ts` | live Supabase lookups + writes (clients, policies, dependants, products, claims) + policy-number generation |
| `api/_lib/bot/helpers.ts` | validators, `PAYMENT_METHODS`, `sendPaymentInstruction` |
| `api/_lib/bot/tail.ts` | `makeTail(prefix)` — the shared currency→method→ecocash→confirm→charge tail |
| `api/_lib/bot/handlers/{registration,client,agent}.ts` | the three menus' step handlers |
| `api/_lib/paynowInitiate.ts` | Paynow transaction creation, shared with `api/paynow.ts` |
| `database/add_wa_sessions.sql` | the session table migration |
| `database/add_client_gender.sql` | `clients.gender` column |

## One-time setup

**1. Database** — run `database/add_wa_sessions.sql` in the Supabase
SQL editor. (If it hasn't been run already, also confirm
`database/add_policy_source_and_numbering.sql` is in — the bot draws
policy numbers from `next_policy_sequence`.)

**2. Vercel environment variables** — Vercel dashboard → project →
Settings → Environment Variables → add for **Production** (see table
below), then redeploy.

**3. Meta app** — at https://developers.facebook.com:
   - Create/open the app → add the **WhatsApp** product.
   - Get a **permanent** access token (System User → generate token with
     `whatsapp_business_messaging` scope) — test tokens expire in 24h.
   - Note the **Phone Number ID** (WhatsApp → API Setup, under the test
     number) and add a real recipient/display number.
   - WhatsApp → Configuration → **Edit webhook**:
     - Callback URL: `https://portal.motions.co.zw/api/whatsapp-webhook`
     - Verify token: your `WHATSAPP_VERIFY_TOKEN` value
     - Subscribe to the **`messages`** field.
   - Copy the **App Secret** (Settings → Basic) into
     `WHATSAPP_APP_SECRET` — the webhook then cryptographically verifies
     that every POST really came from Meta.

**4. Send a WhatsApp message** to the business number from an unknown
phone — you should get the registration menu.

## Environment variables

| Variable | Where it's used | Required |
|---|---|---|
| `WHATSAPP_ACCESS_TOKEN` | every send | yes |
| `WHATSAPP_PHONE_NUMBER_ID` | the send url | yes |
| `WHATSAPP_GRAPH_VERSION` | API version, defaults `v21.0` | no |
| `WHATSAPP_VERIFY_TOKEN` | GET handshake — any string you choose | yes |
| `WHATSAPP_APP_SECRET` | POST signature check | strongly recommended |
| `PAYNOW_INTEGRATION_ID` / `_KEY` (+ `_ZWG_` pair) | payment links | yes |
| `EIP_*` | EcoCash direct push | yes for EcoCash |
| `VITE_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | data layer | yes (already set) |

## Testing without a real WhatsApp

POST a Meta-shaped payload at the endpoint:

```powershell
$body = '{"object":"whatsapp_business_account","entry":[{"id":"1","changes":[{"value":{"messaging_product":"whatsapp","contacts":[{"profile":{"name":"Test"}}],"messages":[{"from":"263770000000","id":"m1","timestamp":"1","type":"text","text":{"body":"hello"}}]},"field":"messages"}]}]}'
Invoke-RestMethod -Uri https://portal.motions.co.zw/api/whatsapp-webhook -Method Post -Body $body -ContentType 'application/json'
```

Without `WHATSAPP_APP_SECRET` set locally the signature check passes.
Watch the conversation rows in Supabase → Table Editor → `wa_sessions`.

## Differences from the Frappe bot

Deliberate, documented simplifications — not lost features:

- **No "enter your phone number" in registration** — the caller is on
  WhatsApp; their number is already known.
- **Policy + package → product.** The IMS keeps one row per plan
  (`products`), so the two-step Frappe pick collapses to one list.
- **Gender is captured for real** — `clients.gender` (added by
  `database/add_client_gender.sql`), with an **Other** option that
  stores the text the client types. Free text, not an enum. The portal
  register/edit forms carry the same field. Dependants carry it in the
  policy's `dependants` JSONB.
- **Payment methods match the portal** — EcoCash / Paynow / office
  payment, recorded with the same names the IMS writes (Frappe's
  ZimSwitch/PayGo/SSB list had no portal equivalent; those all resolve
  to Paynow or office anyway).
- **Payment works.** `process_payment()` was a stub returning a sample
  URL; here EcoCash pushes really fire and Paynow links really open.
- **Renew Policy and Commission are real** — renewal rides the payment
  webhook (advances `next_payment_date`, reinstates lapsed), commission
  reads `products.commission_pct`.
- **Claims file real rows** instead of acknowledging and discarding the
  document.
- **`note` is wiped on `exit`** — the Frappe version kept stale keys
  between flows.
- **Requests are verified** with Meta's app-secret signature when
  `WHATSAPP_APP_SECRET` is configured.

### One database, two channels — changes propagate by construction

Anything stored in Supabase shows the same value on both channels
without syncing: a client/payment/dependant created on WhatsApp appears
in the portal at once, and portal edits (products, prices, exchange
rates, agent phones, client records) are what the bot reads on its next
message. The exceptions that live in code — prompts, validators, method
labels — are the channel's own concern, not data, so they can't drift
apart silently.

## Troubleshooting

| Symptom | Likely cause / where to look |
|---|---|
| Meta can't save the webhook URL | `WHATSAPP_VERIFY_TOKEN` on Vercel doesn't match what you typed in the Meta console |
| Bot never replies | `vercel logs` → errors mentioning `whatsapp-webhook`; usually missing `WHATSAPP_ACCESS_TOKEN`/`PHONE_NUMBER_ID` |
| "Session has been reset" immediately | The handler for the state threw — the function log names the state |
| Payments say "not configured" | `PAYNOW_*` / `EIP_*` env vars; same check as the portal's Billing page |
| ZiG refused | No `exchange_rates` row for `ZWG` — set the rate in the portal |
| Duplicate/late replies | Meta retried a slow delivery — the endpoint now does work *before* answering 200, so retry storms mean a send is failing (check the WhatsApp API error in logs) |
