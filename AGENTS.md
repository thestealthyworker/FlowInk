# AGENTS.md

Pointer for an AI coding agent (Claude Code, Codex, or similar) landing
in this repo. Short and factual on purpose — the actual specs live where
they're linked below; this file exists so you find them.

## What this is

FlowInk is a self-hosted personal-finance tracker: one ledger across all
your cards/wallets, plus a rules engine that tracks each card's own
reward thresholds and caps so you know, mid-statement, whether you're on
track. Full design: [`docs/architecture.md`](docs/architecture.md) (the
generic architecture) and
[`docs/reference-example-sg.md`](docs/reference-example-sg.md) (a
complete worked example — read this if you want to see the pattern
applied to real cards before applying it to someone else's).

## If you were asked to configure this deployment for someone's cards

**Read [`docs/onboarding-spec.md`](docs/onboarding-spec.md) in full
before doing anything else.** It is the machine-readable spec for
exactly this task: what to elicit from the user, what standard your
research has to meet (a citation is a URL to the issuer's own terms, not
your own recollection of "what this card usually pays"), the precise
JSON you must emit, and the validator you run it through
(`scripts/validate_ai_config.py`) before anything touches the database.

**You do not have write access to this database, and you should not try
to get it.** Every reward rule you propose is validated, then inserted
through `submit_method_rule()` — the one function
`supabase/migrations/0018_config_review.sql` defines for this — which
computes the row's status from *who is actually calling it*, not from
anything in your JSON. Called from the context you're expected to run
in, every rule you propose lands `pending_review`: real, stored, and
completely invisible to every number the dashboard shows, until a human
approves it at `/config`. There is no parameter, flag, or confidence
value that changes this. Report what you proposed and that it needs
review — never that you "configured" or "set up" anything, because you
didn't finish the job until a human looks at it.

## Project shape, briefly

- **Single-tenant, your own deployment.** This is not a multi-user SaaS
  — one Supabase project, one operator, one dashboard, per install. See
  `supabase/migrations/0008_dashboard_rls.sql`'s header for how the
  single-operator allow-list (`app_admin`/`is_operator()`) works, and do
  not propose changing it to support multiple users.
- **Card rules are data, not code.** `method_rules` rows, evaluated by
  `evaluate_period()` (`supabase/migrations/0015_generic_rules_engine.sql`).
  A rate change is an `UPDATE`, never a deploy — never hardcode a card's
  numbers into application code.
- **Secrets are never committed.** Every credential (Supabase service
  role key, Gmail refresh token, Anthropic API key, healthchecks.io ping
  URL) lives in that runtime's own secret store — see
  `docs/getting-started.md` and `docs/setup/`. `.env.example` /
  `dashboard/.env.local.example` are templates, not real values; never
  fill in and commit a real secret anywhere, including in a scratch file
  you intend to delete later.
- **The review gate is load-bearing, not a formality.** It exists
  because an LLM confidently asserting a wrong cashback rate is spending
  advice a real person acts on. Don't build, suggest, or accept a path
  that lets AI-proposed config reach `active` status without a human
  decision — see `0018_config_review.sql`'s header for the exact
  guarantee and why it's enforced in the database, not in application
  code that a future change could accidentally skip.

## Where to actually start

[`docs/getting-started.md`](docs/getting-started.md) if you're setting up
infrastructure (Supabase, Vercel, optional integrations).
[`docs/onboarding-spec.md`](docs/onboarding-spec.md) if you're
configuring cards for a real user. Both assume you've read
`docs/architecture.md` first.
