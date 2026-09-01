# dashboard/

Next.js (App Router, TypeScript) app, deployed to Vercel from this
directory as the project's Root Directory. See
[`../docs/architecture.md`](../docs/architecture.md) (the dashboard's
place in the overall design, §9-10) and
[`../docs/reference-example-sg.md`](../docs/reference-example-sg.md) (the
worked example this dashboard renders).

Auth gating every page via `middleware.ts` is Supabase Auth with an
**email + password** form (`app/login/LoginForm.tsx` →
`lib/actions/auth.ts`, `supabase.auth.signInWithPassword()`) —
deliberately not a magic link (see the comment at the top of
`lib/actions/auth.ts` for why). There is exactly one account: it is
created by hand in Supabase Studio, never through this UI (there is no
sign-up form), and this dashboard never creates accounts as a side effect
of anything. RLS-scoped reads/writes go through `@supabase/ssr`. Pages
cover budgets, card status and reward-tier tracking, manual (non-card)
transaction entry, the merchant triage table, and the payment-method /
rule config surface. Visual design is intentionally plain, unstyled,
semantic HTML throughout — there has not been a dedicated design pass.

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
3. **Create the operator's account before doing anything else here.**
   `/login` is email + password, not a magic link, and
   `signInWithPassword()` never creates an account as a side effect — if
   no user exists yet in `auth.users`, sign-in just fails. Create it in
   Supabase Studio (**Authentication → Users → Add user**, set an email +
   password) or via the Admin API. See
   [`../docs/setup/supabase.md`](../docs/setup/supabase.md) step 6 for the
   full walkthrough.
4. `npm run dev`, then sign in with that email and password at `/login`.
5. Register that account's uid as the operator — see the runbook at the
   top of `../supabase/migrations/0008_dashboard_rls.sql` and
   [`../docs/setup/supabase.md`](../docs/setup/supabase.md) step 6. Until
   this runs, every page will load but show no data: `is_operator()`
   returns false for everyone, including the real operator, by design
   (fail-closed).
6. **Disable public signup** on the Supabase project (Dashboard →
   Authentication → Sign In / Providers). Not done by any migration or CLI
   command — see [`../docs/setup/supabase.md`](../docs/setup/supabase.md)
   step 7 for why.

## Structure

- `lib/supabase/` — browser/server/middleware Supabase clients, all on the
  publishable key only.
- `lib/data/` — typed read queries (spend by category, 12-month trend,
  merchant leaderboard, per-method split, `card_dashboard_status()` RPC)
  and write helpers (budgets, manual transactions, merchant triage).
- `lib/actions/` — Server Actions wrapping `lib/data/` for the forms in
  `app/`.
- `app/(protected)/` — every page behind the auth gate: `/` (this-month
  proof-of-read view), `/budgets`, `/cards` and `/cards/tier-3` (reward
  tracking), `/config` (payment methods, rule review, the example-data
  loader), `/transactions/new`, `/triage`.
- `app/login` — the only route `middleware.ts`'s `PUBLIC_PATHS` treats as
  public. There is no `app/auth/callback` route (or any other public
  route) in this dashboard.
