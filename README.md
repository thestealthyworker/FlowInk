# FlowInk

Personal credit card spend tracking and threshold optimisation. Singapore.
UOB One, Citi Cash Back, HSBC Revolution, DBS PayLah.

Full design: [`docs/cardledger-build-spec.md`](docs/cardledger-build-spec.md).

**Standalone. No VPS, no n8n, no always-on server.** Everything runs either
inside Supabase or in a GitHub Actions runner.

## Architecture

```
LAYER 1 · LIVE       Supabase Cron (2 min) → Edge Function ingest-alerts
                      → Gmail API → Anthropic API → Supabase (provisional)
LAYER 2 · RECONCILE  GitHub Actions (daily) → decrypt statement PDF (qpdf)
                      → parse → match provisional → confirmed
LAYER 3 · RULES      Postgres functions. Deterministic. No LLM.
LAYER 4 · OUT        Web dashboard (Phase 5, not yet built) · healthchecks.io
                      dead-man's-switch (heartbeat, JOB-6)
```

Telegram was removed 2026-08-25 (operator decision, `docs/cardledger-build-spec.md`
§10 AMENDMENT). Warnings and merchant triage move to the web dashboard;
**healthchecks.io is now the only out-of-band alarm** — see `heartbeat` below
and `supabase/functions/_shared/healthchecks.ts`.

## Repo layout

```
supabase/migrations/         schema + seed data, versioned
supabase/functions/
  ingest-alerts/              JOB-1 · Gmail alert → Anthropic → provisional txn
  heartbeat/                  JOB-6 · hourly healthchecks.io ping + per-source silence check
  _shared/                    gmail, anthropic, healthchecks, period, merchant, supabase, cron-auth
.github/workflows/
  ingest-statements.yml       JOB-2 · daily, decrypts + parses statement PDFs
  reconcile.yml                JOB-3 · runs immediately after JOB-2
scripts/
  ingest_statements.py, reconcile.py, verify_token.py
  lib/                         Python ports of the _shared/ helpers (separate runtime, §12)
dashboard/                    Next.js app, deployed to Vercel (Phase 5) — budgets,
                               card optimisation views, manual entry, and warnings/triage
tests/                        parser + merchant + period regression tests, fixtures/
docs/                         build spec, setup status
```

## Status

**[`docs/SETUP_STATUS.md`](docs/SETUP_STATUS.md) is the live checklist** —
what's done, what's blocked and why, and the exact commands for what's left.
Read that first when picking this back up, especially on a new machine.

Phase 0A is done: the Supabase project (`<YOUR_SUPABASE_PROJECT_REF>`, `ap-southeast-1`)
is created, migrations `0001`–`0007` are applied (schema, seed data, and the
Phase 3 rules engine), and historical transactions have been backfilled.
Phase 3 (card optimisation rules) is live. Telegram has been removed —
warnings and merchant triage now belong to the Phase 5 dashboard, not yet
built. See `docs/SETUP_STATUS.md` for the exact remaining steps.

Two things are explicitly deferred pending real data, not oversights:

- `uob_one.cycle_day` is `null` until read off a real UOB statement (§5,
  §12 item 6). Until then, UOB transactions get `period_key =
  'uob_one:pending'` rather than a guessed period — see
  `supabase/functions/_shared/period.ts`.
- Citi Cash Back's `method_rules` rows are staged with `valid_from =
  '2099-01-01'` and no `payment_methods` row exists yet — insert both once
  the card is issued and a real alert sample is captured (§5, §12 item Citi).

## Secrets — four runtimes, four stores

Each runtime reads only its own secret store; never unify them (§11, §12).

| Runtime | Store | Variables |
|---|---|---|
| Edge Functions | `supabase secrets set` | `GMAIL_REFRESH_TOKEN`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `ANTHROPIC_API_KEY`, `CRON_SHARED_SECRET`, `HEALTHCHECKS_PING_URL` — plus `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`, which Supabase injects automatically |
| GitHub Actions | repo Secrets | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GMAIL_REFRESH_TOKEN`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `ANTHROPIC_API_KEY`, `STATEMENT_PDF_PASSWORD` |
| Postgres (`pg_cron` → `pg_net`) | Supabase Vault | bearer token used to invoke Edge Functions on schedule |
| Vercel (dashboard) | project env vars | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — **public values only**, never a secret |

`CRON_SHARED_SECRET` is what every Edge Function checks the Vault-held
bearer token against (`_shared/cron_auth.ts`) — confirm the current
`pg_cron` → Edge Function auth pattern against live Supabase docs before
wiring the cron jobs (§12 item 9); don't copy an older example using
`pgjwt` or `pgsodium`, both deprecated.

`HEALTHCHECKS_PING_URL` is required, not optional, now that the Telegram
bot is gone (§10 AMENDMENT) — it is the only out-of-band alarm left
(`_shared/healthchecks.ts`, `scripts/setup_secrets.sh`).

See `docs/cardledger-build-spec.md` §11 for the full security model.
