# Getting started

This is the entry point for deploying your own copy of FlowInk. It assumes
you have never created any of the accounts this project needs — Supabase,
Google Cloud, Anthropic, healthchecks.io, Vercel — and tells you which
setup guide to read, in which order, and why.

You should be comfortable with `git clone`, `npm install`, and pasting
commands into a terminal. Nothing beyond that is assumed. Where a step asks
you to click through a web console, it says exactly what to click.

## What you're setting up

FlowInk is four runtimes talking to one Postgres database:

```
LAYER 1 · LIVE       Supabase Cron (2 min) → Edge Function ingest-alerts
                      → Gmail API → Anthropic API → Supabase (provisional)
LAYER 2 · RECONCILE  GitHub Actions (daily) → decrypt statement PDF (qpdf)
                      → parse → match provisional → confirmed
LAYER 3 · RULES      Postgres functions. Deterministic. No LLM.
LAYER 4 · OUT        Web dashboard (Vercel) · healthchecks.io dead-man's-switch
```

Only one of those layers is required to have a working, usable app: the
database (Supabase) and the dashboard that reads it (Vercel). Everything
else — Gmail ingestion, Anthropic parsing, healthchecks.io monitoring — is
an optional automation layered on top. Skip all of it and you have a
personal finance tracker with manual transaction entry. Add pieces back
whenever you're ready; nothing about the required setup below assumes you
ever will.

## Required vs. optional, at a glance

| Piece | Required? | What you lose without it |
|---|---|---|
| [Supabase](setup/supabase.md) | **Required.** The database and auth. Nothing runs without it. | N/A |
| [Vercel](setup/vercel.md) | **Required**, in the sense that it's how you get a web dashboard at all. You can technically run the dashboard with `npm run dev` on your own machine instead and skip Vercel entirely. | A hosted URL you can open from your phone. |
| [Gmail / Google Cloud](setup/gmail.md) | Optional. | No automatic transaction capture from bank alert emails. You add every transaction yourself on `/transactions/new`. This is a fully supported, permanent way to use the app, not a degraded stopgap — see below. |
| [Anthropic](setup/anthropic.md) | Optional, and only meaningful if Gmail is also configured — it's what turns a raw alert email into structured transaction data. | Without it, Gmail ingestion (if configured) fails to parse anything; without Gmail, it does nothing at all. |
| [healthchecks.io](setup/healthchecks.md) | Optional. | No independent alarm if the ingest pipeline silently stops. The app itself will still work; you just won't be told if automation quietly dies. |
| [GitHub Actions secrets](setup/github-actions.md) | Optional — only needed if you want statement-PDF reconciliation (turning `provisional` transactions into `confirmed` ones) or you're running Gmail ingestion at all, since some of these secrets mirror the Gmail/Anthropic ones into a second runtime. | Alert-sourced transactions stay `provisional` forever — visible, not wrong, just never independently confirmed against a statement. |

**The one thing every optional piece has in common:** the dashboard always
boots and is always usable with only Supabase configured. It detects which
integrations are live (by reading a status table the background jobs
write to, never by holding their secrets itself) and shows an honest
banner instead of a crash or a silent gap wherever one is missing. See
`dashboard/lib/data/integration-status.ts` and
`dashboard/components/honest-data/IntegrationNotice.tsx` if you want to
read the mechanism.

## Order to do this in

Later steps depend on earlier ones existing, so follow this order:

1. **[Supabase](setup/supabase.md)** — always first. Creates the database,
   applies the schema, and gives you the two values (`NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`) every other step and the dashboard
   itself depend on.
2. **[Vercel](setup/vercel.md)** — deploy the dashboard against the Supabase
   project from step 1. At this point you have a working app: sign in, add
   transactions by hand, track budgets. Everything below is additive.
3. **[Gmail / Google Cloud](setup/gmail.md)** — if you want automatic
   ingestion of bank alert emails. The most fiddly step in this whole list;
   read it slowly and don't skip the verification step it asks for.
4. **[Anthropic](setup/anthropic.md)** — only meaningful once Gmail is
   configured. This is what turns a raw alert email into a structured
   transaction row.
5. **[healthchecks.io](setup/healthchecks.md)** — a free, five-minute step
   that gives you an independent alarm if any of the above silently stops
   working. Do this even if you skip Gmail/Anthropic; it's useful the
   moment you have any scheduled job at all.
6. **[GitHub Actions secrets](setup/github-actions.md)** — wires the same
   Gmail/Anthropic credentials into a second runtime for daily statement-PDF
   reconciliation, plus healthchecks.io for that job's own alarm. Do this
   last, since it's mirroring values you'll have already minted in steps
   3–5.

## After infrastructure exists

Once you've worked through the required steps (Supabase + Vercel), a
fresh deployment's card configuration is genuinely empty — no cards, no
rules — by design, not a bug. Before encoding your own cards, it's worth
seeing the pattern working end to end first: go to `/config` in the
dashboard and click **"Load the Singapore example"** to populate three
real cards with real published rates (see
[`docs/reference-example-sg.md`](reference-example-sg.md) for what it
loads and why). A **"Clear example data"** button in the same place
removes only that example data later, whenever you're ready to configure
your own cards instead.

The remaining setup — routing bank alerts to the right rules, tuning card
thresholds, anything specific to *your* cards rather than to the
infrastructure — is covered separately. That guide isn't part of this
document set; if it isn't in `docs/` yet in your checkout, it's still in
progress upstream.

## If you get stuck

Every setup guide in `docs/setup/` tells you how to verify each step
worked before moving to the next one — not just what command to run, but
what a *successful* result actually looks like, because in this system
several failure modes report success and change nothing. That phrase is
worth remembering on its own: **"the command succeeded" and "the number
changed" are different claims. Verify the second, every time.** You'll see
it again at the specific steps where it has bitten this project before.
