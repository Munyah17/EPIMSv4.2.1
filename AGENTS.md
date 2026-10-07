# TariqifyIMS — Motions Microinsurance

React 19 + TypeScript + Vite app backed by Supabase, deployed to Vercel
(project `epim-sv4-2-1`, production domain `https://portal.motions.co.zw`).

## Commands

- `npm run typecheck` — tsc --noEmit over `src/` (api/ has its own scope)
- `npm run build` — typecheck + Vite production build
- `npx vitest run --pool=threads` — tests; the default fork pool times out
  on this Windows machine (worker startup, not assertions) — always use
  threads or `--maxWorkers=1`
- `npx vercel --prod --yes` — manual production deploy via authenticated
  Vercel CLI; use when the GitHub→Vercel hook misses a push

## Verifying a deploy

Fetch `https://portal.motions.co.zw/` and compare the `index-*.js` hash
in the HTML with the hash emitted by `npm run build`. `vercel ls` lists
recent deployments.

## Rules

- No mock/simulated data. `src/lib/db.ts` reads Supabase; `offlineCache`
  may only hold previously fetched real rows; failed writes must surface
  as failures, never silent local saves.
- Payment/AI/email endpoints in `api/` are gated by `api/_lib/sessionAuth.ts`
  (`requireSession`); callers attach the Supabase access token. Webhook
  endpoints authenticate by signature, not session.
- Policy terms live in `src/lib/policyTerms.ts` verbatim — every policy
  document appends ALL product exclusion schedules via `drawTermsPages`.
- Premiums are per head except agriculture (`policyBillablePremium`).
- Secrets stay in `.env*` / server env — never in `src/`.
