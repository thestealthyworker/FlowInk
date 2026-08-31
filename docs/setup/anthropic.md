# Setting up the Anthropic API key

**Optional**, and only meaningful if you've also set up
[Gmail ingestion](gmail.md) — this key is what turns a raw bank alert
email into structured transaction data. Without Gmail configured, this key
does nothing at all. Without this key, Gmail ingestion (if configured)
will fetch alert emails but fail to parse any of them into transactions.

If you're not using automatic ingestion, skip this entirely — see
`docs/getting-started.md`'s required-vs-optional table for what manual
entry covers instead.

## 1. Get an API key

1. Go to [console.anthropic.com](https://console.anthropic.com) and sign
   up or sign in.
2. Add billing details (API usage is metered, pay-as-you-go — see cost
   estimate below before assuming this needs a large commitment).
3. Go to **API Keys** and create a new key. Name it something you'll
   recognize later, e.g. `flowink`.
4. Copy the key immediately — most consoles show the full key value only
   once, at creation time.

**Needs a real-world check:** the exact navigation and whether the key is
shown once-only or re-viewable is not verified against a live console as
part of writing this guide — check Anthropic's current console when you
get there.

## 2. Where this key is used

There are **two separate consumption points**, in two separate runtimes,
and the key needs to be set in **both** places if you want both to work:

1. **Live alert parsing** — the Supabase Edge Function `ingest-alerts`
   calls the Anthropic API to extract structured transaction data
   (amount, merchant, date, etc.) from each bank alert email, every 2
   minutes. Needs `ANTHROPIC_API_KEY` in the **Supabase Edge Function
   secret store**.
2. **Statement parsing** — the GitHub Actions job that reconciles monthly
   statement PDFs also calls the Anthropic API, in `scripts/ingest_statements.py`.
   Needs `ANTHROPIC_API_KEY` in **GitHub repo Secrets** (see
   [`github-actions.md`](github-actions.md)).

These are independent secret stores (see the "four runtimes, four stores"
framing in the main `README.md`). **It's an easy thing to set once and
forget the second store exists** — if live ingest is parsing correctly but
statement reconciliation is silently failing (or vice versa), a missing
key in only one of the two stores is the first thing to check.

```
# Edge Function store:
supabase secrets set --project-ref <your-project-ref> ANTHROPIC_API_KEY=<your-key>

# GitHub Actions store:
gh secret set ANTHROPIC_API_KEY --body <your-key>
```

(`scripts/setup_secrets.sh` sets both for you as part of the Gmail setup
flow, if you use it — see [`gmail.md`](gmail.md).)

## 3. What it costs

This project uses a small, cheap model (`claude-haiku-4-5`) specifically
because parsing a short bank alert email into a handful of structured
fields is high-volume, low-complexity extraction — a larger model is
unnecessary here and the cost difference compounds across every
transaction, indefinitely. At a personal-finance transaction volume — this
project's own reference deployment runs at roughly 100 transactions a
month — the Anthropic bill for this is a rounding error, not a line item
worth budgeting around.

If your bill for this ever looks material, that's a signal something is
wrong, not that your spending grew: the most likely cause is a stuck
ingest watermark causing the same messages to be re-parsed repeatedly
rather than the watermark advancing normally after each successful
insert. Check `ingest_state` (the watermark table) before assuming the
API itself got more expensive.

## What's next

With both Gmail and Anthropic configured, live alert ingestion can
actually produce transactions. [`healthchecks.io`](healthchecks.md) is
the next step if you want an independent alarm should this pipeline ever
silently stop.
