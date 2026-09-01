# FlowInk

A self-hosted personal finance tracker that consolidates every card and
wallet you have into one ledger, then tracks each card's own reward
thresholds and caps so you actually earn what you're entitled to instead
of missing it by a few dollars or one transaction.

Every card and wallet already has its own analytics, locked inside its
own app. Nothing shows total spend, and nothing tells you — in the
statement month you're still inside, not five weeks later — whether
you're on track for a threshold you're about to miss. FlowInk exists to
be that one view.

Card rules (rates, tiers, caps) live in the database as data, not code —
a rate change is an `UPDATE`, not a deploy. That's what lets this repo
ship generically: the schema and rules engine don't know or care which
country your cards are from. It ships with a complete worked example for
four Singapore cards and wallets, encoded as a demonstration of the
pattern, not as the limit of what it supports.

**Standalone.** No VPS, no always-on server, no third-party automation
platform. Everything runs either inside Supabase (a hosted Postgres
provider) or in a GitHub Actions runner, both of which have usable free
tiers.

## Architecture, in brief

```
LAYER 1 · LIVE       Supabase Cron → Edge Function ingest-alerts
                      → Gmail API → Anthropic API → Supabase (provisional)
LAYER 2 · RECONCILE  GitHub Actions (daily) → decrypt statement PDF (qpdf)
                      → parse → match provisional → confirmed
LAYER 3 · RULES      Postgres functions. Deterministic. No LLM.
LAYER 4 · OUT        Web dashboard (Vercel) · healthchecks.io
                      dead-man's-switch
```

**Only layer 1 (Supabase) and the dashboard half of layer 4 are
required.** Everything else — Gmail-based ingestion, the Anthropic
parsing that turns a raw alert email into a transaction, statement-PDF
reconciliation, healthchecks.io monitoring — is optional and layered on
top. Skip all of it and you have a personal finance tracker with manual
transaction entry: a fully supported way to use this, not a degraded
stopgap. The dashboard detects which integrations are actually
configured and degrades honestly — a banner explaining what's missing,
never a crash or a silent gap — rather than assuming everything is wired
up.

The full architecture — data model, the rules engine's generic
self-describing contract, the ingestion design, the security model and
the traps this project has already hit building it — is in
[`docs/architecture.md`](docs/architecture.md). The Singapore worked
example (UOB One, HSBC Revolution, Citi Cash Back, DBS PayLah! — real
reward mechanics, MCC codes, T&C citations) is in
[`docs/reference-example-sg.md`](docs/reference-example-sg.md).

## What it costs to run

Every piece below has a usable free tier for a single-user deployment:

- **Supabase** — free, with one real caveat: a free-tier project pauses
  itself after roughly a week of inactivity, which silently stops every
  scheduled job. A few dollars a month on a paid tier removes that
  failure mode; see [`docs/setup/supabase.md`](docs/setup/supabase.md).
- **Vercel** (dashboard hosting) — free (Hobby tier) for personal,
  non-commercial use.
- **Anthropic** — pay-as-you-go, but at personal transaction volumes
  (tens to low hundreds of transactions a month, parsed by a small, cheap
  model) this is a rounding error, not a line item worth budgeting
  around.
- **healthchecks.io** — free tier is enough for one dead-man's-switch and
  a handful of per-source checks.
- **Google Cloud** (Gmail API access) — free; no billing account
  required for this project's usage.

## Before you start

You'll need to be comfortable with `git clone`, `npm install`, and
pasting commands into a terminal, and to click through several web
consoles (Supabase, Google Cloud, Vercel) as you go — every step that
requires one tells you exactly what to click. You do not need your own
server, domain, or any infrastructure beyond the free-tier accounts
above.

## Get started

**[`docs/getting-started.md`](docs/getting-started.md)** is the entry
point: what to set up, in what order, and why — including which pieces
are required and which are optional, with an honest account of what you
lose by skipping each optional one.

## Repo layout

```
supabase/migrations/         schema + seed data, versioned
supabase/functions/
  ingest-alerts/              Gmail alert → Anthropic → provisional transaction
  heartbeat/                  hourly healthchecks.io ping + per-source silence check
  _shared/                    gmail, anthropic, healthchecks, period, merchant, supabase, cron-auth
.github/workflows/
  ingest-statements.yml       daily, decrypts + parses statement PDFs
  reconcile.yml                runs immediately after ingest-statements
scripts/
  ingest_statements.py, reconcile.py, verify_token.py
  lib/                         Python ports of the _shared/ helpers (a separate runtime — see docs/architecture.md)
dashboard/                    Next.js app, deployed to Vercel — budgets, card
                               status, manual entry, and merchant triage
tests/                        parser + merchant + period regression tests, fixtures/
docs/                         architecture, the Singapore worked example, and setup guides
```

## Running the tests

The Python parser/merchant/period/reconcile regression suite lives in
`tests/`, and doesn't need any live Supabase project, Gmail account, or
API key to run:

```
pip install -r tests/requirements.txt -r scripts/requirements.txt
python3 -m pytest
```

Use `python3 -m pytest`, not a bare `pytest` — depending on how Python is
installed on your machine, a bare `pytest` on PATH may resolve to a
different (isolated) install that can't see packages from the command
above. As of this checkout, the expected result is:

```
206 passed, 3 skipped
```

The 3 skips are correct, not a partial failure: those tests exercise the
live Anthropic parsing path and skip themselves when `ANTHROPIC_API_KEY`
isn't set in your environment, which it won't be for a plain clone. If
you do have `ANTHROPIC_API_KEY` exported when you run this, those 3 tests
run for real instead (and make live API calls) — expect `209 passed`, not
206, in that case.

## Secrets — four runtimes, four stores

Each runtime reads only its own secret store; never unify them. The full
rationale for keeping them separate, and exactly where each value comes
from, is in the per-integration guides under `docs/setup/`.

| Runtime | Store | Variables |
|---|---|---|
| Edge Functions | `supabase secrets set` | `GMAIL_REFRESH_TOKEN`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `ANTHROPIC_API_KEY`, `CRON_SHARED_SECRET`, `HEALTHCHECKS_PING_URL` — plus `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`, which Supabase injects automatically |
| GitHub Actions | repo Secrets | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GMAIL_REFRESH_TOKEN`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `ANTHROPIC_API_KEY`, `STATEMENT_PDF_PASSWORD` |
| Postgres (`pg_cron` → `pg_net`) | Supabase Vault | bearer token used to invoke Edge Functions on schedule |
| Vercel (dashboard) | project env vars | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — **public values only**, never a secret |

`HEALTHCHECKS_PING_URL` is the only out-of-band alarm this system has —
Supabase Cron itself has no failure alerting of its own. It's optional in
the sense that nothing crashes without it, but skipping it means you
won't be told if automation silently stops.

See [`docs/architecture.md`](docs/architecture.md)'s security-model
section for the full reasoning behind this split, and the RLS/grants
model that's the actual line of defence around your data (not the
secrecy of these values — the Vercel-facing two are meant to be public).
