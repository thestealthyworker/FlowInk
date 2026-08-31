# dashboard/

Next.js (App Router, TypeScript) app, deployed to Vercel from this
directory as the project's Root Directory. Phase 5 — see
`../docs/cardledger-build-spec.md` §10 (dashboard, especially the
AMENDMENT dated 2026-08-25) and §12.

**This pass built the security foundation only**: Supabase Auth (magic
link) gating every page via `middleware.ts`, RLS-scoped reads/writes
through `@supabase/ssr`, budget CRUD, manual (non-card) transaction entry,
and the merchant triage table. Visual design is a separate, not-yet-started
pass — every page here is plain, unstyled, semantic HTML, deliberately.

## Env vars — the complete list, ever

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
```

No service role key, no Anthropic key, no Gmail credentials — see
`.env.local.example`. Anything prefixed `NEXT_PUBLIC_` ships in the browser
bundle; both of these are public by design (RLS is the real control, not
secrecy of these values).

**`npm run build` requires both vars to be set** — it aborts with `Missing
required environment variable` during static page generation otherwise.
That is deliberate fail-closed behaviour (`lib/supabase/env.ts`), not a
defect: set the two values below (copy `.env.local.example` to `.env.local`,
or export them in the shell/CI) before building.

## Before this is usable end-to-end

1. `npm install`
2. Copy `.env.local.example` to `.env.local` and fill in the two values
   (`supabase projects api-keys --project-ref <YOUR_SUPABASE_PROJECT_REF>`).
3. `npm run dev`, sign in once via the magic-link form at `/login`.
4. Register that session's uid as the operator — see the runbook at the
   top of `../supabase/migrations/0008_dashboard_rls.sql`. Until this
   runs, every page will load but show no data: `is_operator()` returns
   false for everyone, including the real operator, by design (fail-closed).
5. **Disable public signup** on the Supabase project (Dashboard →
   Authentication → Sign In / Providers). Not done by any migration or CLI
   command — see `../docs/SETUP_STATUS.md`'s Phase 5 section for why.

## Structure

- `lib/supabase/` — browser/server/middleware Supabase clients, all on the
  publishable key only.
- `lib/data/` — typed read queries (spend by category, 12-month trend,
  merchant leaderboard, per-method split, `card_dashboard_status()` RPC)
  and write helpers (budgets, manual transactions, merchant triage).
- `lib/actions/` — Server Actions wrapping `lib/data/` for the forms in
  `app/`.
- `app/(protected)/` — every page behind the auth gate: `/` (this-month
  proof-of-read view), `/budgets`, `/transactions/new`, `/triage`.
- `app/login`, `app/auth/callback` — the two routes middleware treats as
  public.
