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
           → insert the Meta message id into wa_inbound_events
             (a retry that replays the id is acknowledged, not re-run)
           → for each message, normalise to ONE string:
               text        → the message body
               document    → "filename: X |||| id: Y"  (claim uploads)
               image       → "filename: X |||| id: Y"  (claim uploads)
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

A session row is `{ phone_number, contact_type, state, note,
created_at, updated_at }`. One open session is allowed per phone number;
expiry is calculated from `updated_at` (last message), not first contact.
`state` names the step the user is on; the matching handler owns that
step — it checks the answer, stores it, prompts the next question and
moves the state forward. If a state has no handler (a bug), the session
is deleted and the user is told to start again — a clean reset beats a
conversation stuck on a broken step. If a phone's audience changes while
a session is open (a client becomes an agent, or a new registration
matches), the session is reset to that audience's menu before dispatch.

State names are prefixed per flow so the three menus never collide:

| Prefix | Belongs to |
|---|---|
| `REG_` | registration (unknown numbers) |
| `CPAY_` `CVIEW_` `CADD_` `CCLAIM_` `CDEP_` | client menu flows |
| `AC_` `AD_` `APAY_` | agent menu flows |
| `*_CURRENCY` `*_METHOD` `*_ECOCASH` `*_CONFIRM` | the shared payment tail (`tail.ts`) |

## Menus and flows

**Unknown number → registration menu**
1. Register → full name → national ID → date of birth → gender → email (or `1` to
   skip) → pick a product → (health: chronic declaration; agriculture:
   grower/contractor/hectarage) → payment currency → payment method →
   (EcoCash number if EcoCash) → confirm → client + policy application are
   created → payment instruction sent. Duplicate national IDs are refused.
2. View available products — a real list from the `products` table.
3. Payment methods — the real method list.

**Existing client (their `clients.phone` matches)**
1. Make Payment → pick policy → periods (1–12 months, or 1–12 years for
   agriculture) → tail → charged `billable premium × periods`. Pending
   Paynow applications are included so an abandoned checkout can be retried.
2. My Policies → lists live policies + dependants → "Add New Policy"
   runs the product → tail path (creates a second policy, `pending`).
3. Renew Policy → pick policy → months → tail. Renewal is a payment:
   the Paynow webhook advances `next_payment_date` per period paid and
   reinstates `lapsed` policies — the same code path the portal uses.
4. Claims → pick an `active`/`waiting_period` policy → send a document or
   photo → the bot downloads it from Meta, stores it in the private
   `documents` bucket at `claims/<claim-id>/<file>`, and files a `claims`
   row at `intake` stage with `status='pending'`. Staff open the same
   private path used by portal claim documents.
5. Dependants → Add (dependant wizard → pick a person-cover sponsor
   policy → pick cover from that same product category → health
   declaration when required → tail; the dependant is appended to the
   policy's `dependants` JSONB) / Remove (creates a staff task — no
   deletion or billing change until staff approve it) / View.

**Agent (`profiles.role='agent'`, matched by `profiles.phone`)**
1. Add New Client → the client's details + product + health/agriculture
   fields → tail; client and policy are created **at confirm** with
   `agent_id` and `captured_by` set to the agent.
2. Add New Dependant → sponsor's national ID → sponsor's policy →
   dependant wizard → tail. An agent cannot modify a client assigned to
   another agent; the portal's secondary-agent approval flow is required.
3. My Clients → `clients WHERE agent_id = agent's profile`.
4. Commission → real figure: billable period premium ×
   `products.commission_pct` summed over live policies on the agent's book —
   agriculture/group/once-off billing follows the portal's premium rules.
5. Make Payment → client's national ID → their payable policies and
   abandoned pending applications → periods → tail. Another agent's client
   is refused.

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

New Paynow sales start in `pending_policies`; the webhook only promotes a
paid row to `policies`. If the payer chooses EcoCash or office payment for
an abandoned Paynow application, the bot promotes the row back to the
staff-visible `policies.status='pending'` queue so a direct/manual payment
can be approved without an invisible checkout row. Once-off packages are
never shown as recurring renewals and settled packages are excluded from
payment prompts.

## Where everything lives

| File | Job |
|---|---|
| `api/whatsapp-webhook.ts` | GET verify + POST entry point, HMAC check, message normalisation |
| `api/_lib/bot/engine.ts` | classify contact → find/create session → dispatch to handler map |
| `api/_lib/bot/store.ts` | `wa_sessions` CRUD, 60-min expiry, note merging |
| `api/_lib/bot/types.ts` | `WaSession`, `Ctx`, `Contact`, handler signature |
| `api/_lib/bot/whatsapp.ts` | senders (text/buttons/list/document), text chunking, Meta media download |
| `api/_lib/bot/data.ts` | live Supabase lookups + writes (clients, policies, pending policies, dependants, products, claims, tasks, media paths) + policy-number generation |
| `api/_lib/bot/helpers.ts` | validators, `PAYMENT_METHODS`, `sendPaymentInstruction` |
| `api/_lib/bot/tail.ts` | `makeTail(prefix)` — the shared currency→method→ecocash→confirm→charge tail |
| `api/_lib/bot/handlers/{registration,client,agent}.ts` | the three menus' step handlers |
| `api/_lib/bot/handlers/flowHelpers.ts` | shared policy/product filters, agriculture prompts, billing-period labels |
| `api/_lib/bot/bot.test.ts` | focused bot rules + state-map coverage tests |
| `api/_lib/paynowInitiate.ts` | Paynow transaction creation, shared with `api/paynow.ts` |
| `database/add_wa_sessions.sql` | session uniqueness + `wa_inbound_events` retry ledger |
| `database/add_pending_policies.sql` | pending checkout rows + `finalize_pending_policy` (updated to preserve health/agriculture fields) |
| `database/add_client_gender.sql` | `clients.gender` column |
| `database/add_document_storage.sql` | private `documents` bucket used by claim uploads |

## One-time setup

**1. Database** — in Supabase SQL editor, re-run:

- `database/add_wa_sessions.sql` — adds the one-open-session unique index
  and `wa_inbound_events` for Meta retry deduplication.
- `database/add_pending_policies.sql` — refreshes
  `finalize_pending_policy` so paid pending rows keep medical and
  agriculture fields.
- `database/add_document_storage.sql` — creates the private
  `documents` bucket if it is not already there.
- `database/add_policy_source_and_numbering.sql` — if not already run;
  the bot draws numbers from `next_policy_sequence`.

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
   - While the app is in Development mode, add test recipient numbers in
     WhatsApp → API Setup. Before production launch, complete display-name /
     business verification and move the number out of test mode.

**4. Production readiness check** — portal → WhatsApp Bot shows green for
access token, phone number ID, verify token, app secret, Paynow/EcoCash,
`wa_sessions`, `wa_inbound_events`, and the `documents` bucket. Then send
a WhatsApp message from an unknown test phone — you should get the
registration menu. Meta test numbers only receive messages from approved
test recipients.

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
When the secret is configured, sign the exact raw JSON body as
`sha256=` + hex HMAC-SHA256 using the app secret. Watch the conversation
rows in Supabase → Table Editor → `wa_sessions` and each replayed message
in `wa_inbound_events`; repeating `m1` should not replay the flow.

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
- **Claims file real rows and real attachments** — the document is
  downloaded from Meta and stored in `documents/claims/<claim-id>/`.
- **`note` is wiped on `exit`** — the Frappe version kept stale keys
  between flows.
- **Requests are verified** with Meta's app-secret signature when
  `WHATSAPP_APP_SECRET` is configured, and Meta retries are deduplicated
  through `wa_inbound_events`.

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
| Claim attachments fail | `documents` bucket missing/not private, unsupported MIME, or file over 10MB |
| Paynow application "disappears" | Stale unpaid rows are cleaned after 24h; the user can restart |
| Duplicate/late replies | Re-run `database/add_wa_sessions.sql`; `wa_inbound_events` deduplicates Meta retries. If still duplicated, two deployments are processing or a send call is timing out — check `vercel logs`. |
| Agent says another agent owns the client | Working as intended — create a secondary-agent approval request in Staff Management/Governance instead of bypassing it over WhatsApp |
