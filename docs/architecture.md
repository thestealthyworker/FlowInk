# Architecture

This is the durable design document: what FlowInk is, how it is put
together, and why — independent of which specific cards you hold. It used
to live combined with a Singapore worked example in one file
(`docs/cardledger-build-spec.md`); that file has been split in two. This
document is the generic half. The other half —
[`docs/reference-example-sg.md`](reference-example-sg.md) — is a complete
worked example (four Singapore cards and wallets, their reward mechanics,
MCC codes, T&C citations) showing the pattern this architecture is meant
to support. If you hold Australian, UK, or any other country's cards, you
should be able to read this document end to end without needing anything
in the worked example — and then use the worked example as a template for
encoding your own cards' rules.

Every claim below is grounded in the migrations and source files this
repo actually ships (`supabase/migrations/`, `supabase/functions/`,
`dashboard/`). Where something changed between an earlier design and the
shipped code, this document describes the shipped code and says so.

---

## 1. What this is for

**Primary goal — track all expenses and plan budgets.** Every transaction
across every payment method, categorised, in one place. Budget caps per
category per period. Spending analysis over time.

**Secondary goal — optimise card benefits.** Track spend per card and per
category against each card's thresholds, tiers and caps, so rewards are
actually earned rather than missed by a few dollars or one transaction.

**Tertiary goal — the dashboard.** One overview surfacing total spending,
trends, categories, and card status together — the consolidated picture
no single bank's own app can give you.

Because the primary goal is total expense tracking, non-card payment
methods are in scope. A wallet or a bank account with no rewards
relevance whatsoever still belongs in the ledger, because a budget that
ignores it is wrong.

**Non-goals:** not net worth, investments, or any kind of retirement-fund
tracking. Not a bank aggregator — no credential sharing, no portal
scraping. Not a payments tool — read-only, always, with one narrow
exception (manual entry — see §9).

**The design constraint that shapes everything:** card statements arrive
days after the cycle closes and can be weeks stale — useless for a
threshold you are still inside. Transaction alert emails, where a bank
sends them, arrive in seconds. **Alerts are the primary data source.
Statements are the audit trail**, used to confirm and correct what the
alerts already recorded, not to originate the data.

---

## 2. The four layers

```
LAYER 1 · LIVE       Supabase Cron → Edge Function ingest-alerts
                      → Gmail API → Anthropic API → Supabase (provisional)
LAYER 2 · RECONCILE  GitHub Actions (daily) → decrypt statement PDF (qpdf)
                      → parse → match provisional → confirmed
LAYER 3 · RULES      Postgres functions. Deterministic. No LLM.
LAYER 4 · OUT        Web dashboard (Vercel) · healthchecks.io
                      dead-man's-switch
```

An earlier design had a fifth piece here — a Telegram bot pushing nightly
nudges and handling merchant triage. **It was removed.** Warnings and
merchant triage now belong to the web dashboard, and healthchecks.io is
the only out-of-band alarm. Any doc or comment you find still describing
a `nudge` or `merchant-triage` job predates that decision.

### Why two runtimes, not one

Supabase Edge Functions run Deno. They cannot shell out to `qpdf` or
`pikepdf` to decrypt a password-protected statement PDF — no native
binaries, no subprocess. That single constraint splits the system:

| Job | Runtime | Why |
|---|---|---|
| Alert ingest | Edge Function + Supabase Cron | Pure text and HTTP, well inside Edge Function limits. Needs to run every couple of minutes, which GitHub Actions' best-effort cron (5–15 min jitter under load) cannot do reliably. |
| Statement ingest + reconcile | GitHub Actions | Full Ubuntu runner — `apt install qpdf`, Python, no tight timeout. Runs once a day, so scheduler jitter doesn't matter. |
| Rules engine | Postgres functions | Zero network hop, deterministic, callable from both the ingest path and the dashboard. |

Don't try to force PDF handling into an Edge Function, and don't try to
force sub-5-minute polling into GitHub Actions.

**Alerts and statements will disagree** — on foreign-currency amounts,
tips, pre-authorisations, and refunds. The fast layer (alerts) is never
treated as final truth; it produces `provisional` rows that the slow
layer (statements) confirms or corrects.

---

## 3. The trap that will break this if you get it wrong

**Card periods are not calendar months, and different cards don't share
the same period basis.** A card's rewards might reset on the calendar
month, or on its own statement cycle (which starts on whatever day the
card was approved, not the 1st). A card can also aggregate several
consecutive periods into an all-or-nothing block — e.g. a quarterly bonus
that requires clearing a threshold in *every one* of three consecutive
statement months, forfeiting the whole quarter's payout if any one month
misses.

This is why the schema tracks **two independent periods per
transaction**, never collapsed into one:

- `calendar_month` — what a household budget runs on. This is the only
  basis on which a wallet, a card, and cash are comparable.
- `period_key` — the card's own period, e.g. `some_card:2026-09`, which
  may or may not line up with the calendar month.

If you're encoding your own card's rules, get this distinction right
before anything else. `payment_methods.period_type` (`'calendar'` or
`'statement'`) and `payment_methods.cycle_day` are what the rules engine
uses to resolve a transaction date into the correct `period_key` — see
`supabase/functions/_shared/period.ts` and the SQL evaluator in §6 below.
Do not assume calendar months anywhere in code you add.

**If you don't yet know a new card's statement close day** — a common
situation, since it's usually only visible on a real statement, not
anything the card issuer publishes generically — `cycle_day` can stay
`NULL`, and `resolvePeriodKey()` returns `${method_id}:pending` rather
than guessing at a period. `evaluate_period()` recognises this suffix and
returns an explicit `error` field instead of silently computing a wrong
window. Once you learn the real `cycle_day` and set it, remember that a
backfill pass is needed to re-resolve any already-ingested `:pending`
rows — setting the column alone does not retroactively fix rows already
written with the placeholder period key.

---

## 4. Data model

Card rules — rates, thresholds, caps — change without notice. **They live
in the database as data, never in code.** A rate change is an `UPDATE`,
not a deploy. This is the single most load-bearing decision in the whole
system, and it's what makes §6's generic rules engine possible at all.

The current schema (see `supabase/migrations/0001_schema.sql` for the
base tables and `0014`–`0017` for what's been added since):

```
payment_methods    one row per card/wallet/account. id, display_name,
                    issuer, last4, method_type, period_type, cycle_day,
                    reward_type, has_rules, active, currency,
                    alert_label, alert_senders, statement_senders,
                    aggregation_window, aggregation_anchor_date,
                    rule_overrides, reward_unit

method_rules        the actual reward rules, as rows. method_id,
                    rule_type (min_spend / tier / category_rate / cap /
                    txn_count / quarterly_gate), categories, threshold,
                    rate, cap_amount, payout, txn_min, priority,
                    valid_from/valid_to, plus a second generation of
                    columns added for the generic evaluator: cap_basis,
                    reward_form, gate_scope, condition_key,
                    credit_block_size, credit_floor, estimate_caveat

method_conditions   operator-set flags for external conditions the ingest
                    pipeline cannot observe on its own (e.g. "did this
                    card's balance-tier condition hold this month?").
                    (method_id, calendar_month, condition_key) -> met/not

merchants           classify once, reuse forever. match_pattern,
                    display_name, category, known_mcc, is_transfer,
                    confidence ('guessed'|'confirmed')

transactions        the ledger. method_id, txn_date, merchant_raw,
                    merchant_id, amount, currency, fx_amount, mcc,
                    category, is_transfer, status (provisional/confirmed/
                    disputed/reversed), source (alert/statement/manual),
                    source_ref, period_key, calendar_month,
                    reconciled_with

budgets             category, period ('2026-09' or 'default'),
                    monthly_cap, alert_at

ingest_state        watermark per stream ('alerts', 'statements')

parse_failures      rejected/unparseable alert emails, for triage

integration_status  one row per optional integration (see §9)
```

A `spend_transactions` view sits in front of `transactions` and drops
statement rows that have already been reconciled against an alert row
(`reconciled_with is not null`), so a confirmed statement doesn't
double-count spend already counted from its alert. It does **not** filter
`is_transfer` — callers still need `and not is_transfer` on top of it for
a true spend total. It's defined `security_invoker = true` deliberately:
without that, the view would run with the schema owner's privileges and
bypass RLS on the underlying table entirely.

**One honest wart worth knowing about:** `merchants.hsbc_eligible`
is a column named after one specific issuer's reward-eligibility flag,
predating the generic rules engine. As far as this repo's code shows, no
current rules-engine function reads it (`grep hsbc_eligible` across
`supabase/migrations/0015_generic_rules_engine.sql` and `0007` turns up
nothing but a comment) — it's carried in the dashboard's TypeScript types
but not rendered or used anywhere in `dashboard/`. If your cards have no
HSBC-Revolution-shaped "confirmed 4x category" concept, you can safely
leave it `null` on every row. Nobody has cleaned this column up yet; it's
flagged here rather than silently left for you to trip over.

### Fixed category vocabulary

`groceries · dining · petrol · commute · transport · bills · online ·
retail · healthcare · household · other`

This list is enforced with a repeated `CHECK` constraint on every column
that stores a category (not centralised in a Postgres domain, so the
constraint is visible at each call site). `commute` and `transport` are
kept separate deliberately — ride-hailing versus mass transit earn
differently on some cards and are budgeted differently by most people.
There's no dedicated entertainment/cinema bucket; that kind of spend
currently lands in `other`, a known and deliberate limitation of an
11-category list rather than a misfiling bug.

---

## 5. Ingestion design

### The watermark pattern

Every ingest job (alert-based and statement-based) shares one pattern,
recorded in `ingest_state`:

```sql
create table ingest_state (
  stream     text primary key,        -- 'alerts', 'statements'
  watermark  bigint not null,         -- Gmail internalDate, epoch ms
  updated_at timestamptz not null default now()
);
```

Query Gmail (or wherever the source lives) for anything after the
watermark, and only advance the watermark once a message has been
handled — either inserted, or classified as a **permanent** failure (see
below). This makes the whole system self-healing (an outage is caught by
the next run picking up from the same watermark) and safely backfillable
(move the watermark back and re-run; the `(method_id, source,
source_ref)` unique constraint on `transactions` rejects duplicates for
free).

**A trap worth knowing before you touch this code:** `ingest-alerts`
distinguishes a **transient** failure (an API error, a rate limit — leave
the watermark alone, retry next tick) from a **permanent** one (a
message that will deterministically fail the same way every time — a
validation rejection, an unrecognised sender) — see
`supabase/functions/ingest-alerts/index.ts`'s `outcome.kind` handling.
Permanent failures *do* advance the watermark past themselves and get
logged, specifically so one un-parseable message can't pin the watermark
and burn an API call on it forever.

The trap: **if a message was misclassified as a permanent failure because
of a bug** — not because it's genuinely unparseable — fixing the bug does
not retroactively reprocess it. The watermark has already moved past it.
This happened on this project's own reference deployment: a Gmail label
query bug and a model output-format bug both caused real transactions to
be permanently rejected; fixing each bug did not recover the already-lost
messages, because the watermark had already advanced past them. Recovery
required manually rewinding `ingest_state.watermark` for the affected
stream and letting the next run reprocess everything after that point
(safe, because of the idempotency constraint above). **If you fix a bug
in the ingest pipeline and suspect it silently dropped real transactions
while it was broken, check `parse_failures` for rows in the affected
window and consider a deliberate watermark rewind rather than assuming
the fix alone recovers anything.**

### Routing is data, not code

Which Gmail label and which sender domains route to which
`payment_methods` row used to be hardcoded constants
(`LABEL_TO_METHOD`/`SENDER_DOMAINS` in the Edge Function,
`DEFAULT_STATEMENT_SENDER_DOMAINS` in the Python scripts) — adding a card
or fixing a wrong sender domain meant a source edit and a redeploy. As of
`supabase/migrations/0014_ingestion_routing_as_data.sql`, this is data on
`payment_methods` itself:

- `alert_label` — the Gmail label that routes an alert email to this
  method (`NULL` = not yet configured for the alert path).
- `alert_senders` / `statement_senders` — `text[]` of trusted From-header
  domains for that method's alert and statement emails respectively (two
  separate arrays, because a bank's statement-notice sender is not
  necessarily the same subdomain as its transaction-alert sender). `NULL`
  or `'{}'` must be treated identically to "no expected domain
  configured" by any caller — reject, never silently pass.
- `currency` — the method's ISO-4217 home currency, not a fallback for a
  missing parse — the parser must still state a currency on every parsed
  transaction.

If you're adding your own card, this is the table you edit — no code
change, no redeploy, for the routing decision itself.

**The nested-label trap**, carried forward because it will bite anyone
adding their own Gmail-based routing: Gmail's label search does **not**
treat a parent label as matching its children. `label:Payments` matches
zero messages if your actual filters apply nested labels like
`Payments/SomeCard`. Build the ingest query as an explicit OR-set over
every configured method's own specific label, never a bare parent-label
search. See `docs/setup/gmail.md` for the concrete numbers this bit on
the reference deployment.

### Parser contract

The parser (Anthropic API, called from both the alert path and the
statement path) is asked to return one JSON object matching a fixed
schema (`amount`, `currency`, `merchant_raw`, `last4`, `txn_date`,
`txn_time`, `txn_type`, `confidence`) — temperature 0, no free text. Two
rules matter beyond the schema itself:

- **Never convert currency.** Record the currency and amount exactly as
  the source states them. If a card's alerts report a foreign-currency
  amount with no local-currency equivalent, store it that way — an
  honest "pending conversion" gap beats a confidently wrong converted
  figure. Reconciliation against the statement fills in the real
  converted amount later.
- **Never guess the card.** If no last-4 digits are extractable, `last4`
  is `null` — the row is routed to `parse_failures` for a human, never
  silently attached to a guessed card.

The model is told explicitly not to wrap its output in markdown code
fences, and the parser code defensively strips a fenced block if the
model does it anyway (`supabase/functions/_shared/anthropic.ts` — models
don't always follow formatting instructions even when told plainly not
to; don't rely on instruction-following alone for anything you parse
downstream).

**Never insert an unvalidated row.** A wrong transaction is worse than a
missing one — a gap is visible at reconciliation time; a wrong amount
silently corrupts a budget. Validation failures (bad JSON, non-numeric or
non-positive amount, a future or very-old date, an unmatched `last4`, low
model confidence) are rejected to `parse_failures`, never inserted.

---

## 6. Rules engine design

**Deterministic SQL. No LLM in this path, ever.** The model may parse and
classify; it must never decide whether a threshold was met. That
principle predates and outlives every specific implementation below.

### From per-card functions to one generic evaluator

The rules engine originally shipped (`supabase/migrations/
0007_rules_engine.sql`) as three hand-written Postgres functions, one per
card, each branching internally on its own card's specific mechanics.
That does not scale to "bring your own cards" — every new card meant a
new function.

As of `0015_generic_rules_engine.sql`, there is one generic evaluator,
**`evaluate_period(method_id, period_key)`**, that reads `method_rules`
as data instead of branching on `method_id`. It resolves the period,
sums spend and transaction count, matches applicable rules by
`valid_from`/`valid_to`, applies tiers highest-priority-first and then
category rates in priority order, and returns a self-describing JSON
contract — roughly:

```jsonc
{
  "method_id": "...", "display_name": "...", "currency": "SGD",
  "period": { "key": "...", "start": "...", "end": "...", "is_current": true, "days_left": 9 },
  "spend": { "total": 1340.00, "txn_count": 7 },
  "gates": [ { "kind": "txn_count", "cleared": false, ... } ],
  "reward_tracks": [ { "categories": null, "rate": 0.01, "accrued": 6.60, ... } ],
  "reward_accrued": 66.00,
  "cap": { "basis": "reward", "amount": 120, "remaining": 54.00, "exhausted": false },
  "crediting": { "credited": 60, "accrued_uncredited": 6.00 },
  "has_group": true, "aggregation_window": 3,
  "group": { ... only populated by evaluate_period_group(), see below ... },
  "at_risk": { "value": true, "reasons": [ "..." ] },
  "estimate_caveats": [ "..." ]
}
```

A second function, **`evaluate_period_group(method_id, period_key)`**,
handles cross-period aggregation for cards whose rewards depend on
clearing several consecutive periods together (an all-or-nothing
quarterly gate, for example) — driven by `payment_methods.
aggregation_window` and `aggregation_anchor_date`, rather than a
hardcoded "3 consecutive statement months" baked into one card's own
function.

The primitives this evaluator is built from (each a column or column
combination, not a hardcoded branch):

- `cap_basis` — whether a cap row's `cap_amount` ceils accrued *reward*
  dollars (a shared pool every category draws from) or eligible *spend*
  dollars (capped before the rate is applied, with overflow spend falling
  through to the base rate).
- `reward_form` — `'rate'` (reward = spend × rate) or `'fixed_payout'`
  (a flat amount once a tier's threshold and transaction-count gate both
  clear, independent of exact spend).
- `gate_scope` — whether failing a gate (a minimum-spend or
  transaction-count row) routes *all* spend to the base rate for the
  period, or has no effect on category-rate evaluation at all.
- `condition_key` / `method_conditions` — for a rule that depends on an
  external condition the ingest pipeline cannot observe (an account
  balance tier, say). A row's `condition_key` is matched against
  `method_conditions` for that method and calendar month; **absence of a
  row means the condition was not met** — the same fail-closed default
  as everywhere else in this system. No writer in the ingest pipeline
  ever touches `method_conditions`; it's operator- (or future
  dashboard-) set only.
- `credit_block_size` / `credit_floor` — for a card that credits rewards
  in fixed blocks only once a floor is reached (e.g. rounds down to the
  nearest $10, and doesn't credit anything below $50 accrued). Below the
  floor, the amount is a distinct `accrued_uncredited` state, never
  folded into `credited`.
- `estimate_caveat` — free text attached to a rule row, surfaced in the
  contract's `estimate_caveats[]` whenever that row is matched, for any
  mechanic the ingest pipeline can't directly observe and has to assume
  (e.g. "this assumes the purchase was made contactless, which alert
  data can't confirm").
- `payment_methods.rule_overrides` (`jsonb`) — a deliberately unused
  escape hatch for a mechanic that genuinely doesn't fit the primitives
  above. It ships `NULL` on every row; don't add speculative keys here
  for a mechanic no card actually needs yet.

### Current cutover state — read this before trusting `card_period_status()` blindly

As of `0017_repoint_card_period_status.sql`, the dashboard-facing
function `card_period_status()` dispatches to the generic evaluator. The
original three hand-written functions from `0007`
(`uob_month_status`/`uob_quarter_status`/`hsbc_month_status`/
`citi_month_status`) are **still present in the schema, still granted,
still callable** — deliberately, for one release cycle, as a rollback
path and as the input to `diff_evaluator_output(method_id, period_key)`,
a standalone differential-testing function that compares the old
per-card functions' output against the new generic evaluator's output
field-by-field for a given period. If you're extending the rules engine
and want a sanity check that your change didn't silently break an
existing card's numbers, that function is the tool — not a substitute
for reading the migration, but a genuine oracle for exactly the cards it
was built against (the Singapore worked example's three rules-bearing
cards). Expect the old functions to be dropped in a later release once
this window closes; if you're reading this in a checkout old enough that
they're already gone, this paragraph is stale.

One documented, deliberate departure from bit-for-bit fidelity: the
generic evaluator's cross-period window arithmetic (when an
`aggregation_anchor_date` is actually set) is *correct* quarterly-window
math, whereas the original `0007` function had a stride bug that only
computed correct boundaries for the first period after the anchor and
drifted afterward. This has been dormant in every environment because no
seeded card has ever had its anchor date set — the moment you set one,
expect the two engines to disagree, correctly, on the new side. See the
long comment on `evaluate_period_group()`'s window-start assignment in
`0015_generic_rules_engine.sql` for the full worked example of the
divergence.

---

## 7. Jobs

| Job | Runtime | Schedule | Does |
|---|---|---|---|
| `ingest-alerts` | Edge Function | Cron, every couple of minutes | Reads new mail past the watermark, routes by `alert_label`/`alert_senders`, parses via Anthropic, inserts `provisional` transactions. |
| `ingest-statements` (`ingest_statements.py`) | GitHub Actions | Daily | Decrypts and parses statement PDFs, inserts `confirmed` transactions. |
| `reconcile` (`reconcile.py`) | GitHub Actions | Daily, immediately after ingest-statements | Matches `provisional` rows against newly `confirmed` ones on amount/date/merchant fuzziness; marks matches reconciled; ages out old unmatched provisionals. |
| `heartbeat` | Edge Function | Cron, hourly | Pings an external dead-man's-switch (healthchecks.io) and asserts each configured alert source has seen mail recently, since Supabase Cron itself has no failure alerting of its own. |

There is no longer a nightly-nudge or merchant-triage job — both moved
into the web dashboard when the Telegram bot was retired.

**Why the per-source silence check matters specifically:** the most
likely real-world failure in this whole system isn't a crash — it's a
bank quietly reverting an alert threshold you set once (banks do this;
app updates and account changes have been observed to silently reset
notification preferences). That failure is invisible to an aggregate
"did anything ingest today" check, since your other sources keep working
normally. It only shows up as one source going silent while everything
else looks healthy — which is exactly what the heartbeat job's per-label
silence assertion is designed to catch, not an aggregate one. If you add
a source of your own, make sure it's covered by this same per-source
check rather than folded into one aggregate signal.

**Auth for `pg_cron` invoking an Edge Function** — via `pg_net` with a
bearer token held in Supabase Vault — is a pattern that has already
changed once as Supabase's own recommended approach evolved (older
community examples using `pgjwt` or `pgsodium` are deprecated). If you're
wiring this yourself, confirm the current recommended pattern against
live Supabase docs rather than copying an older tutorial; see
`supabase/functions/_shared/cron_auth.ts` for what this repo currently
does.

---

## 8. Optional integrations and how the dashboard degrades

Every integration beyond Supabase itself is optional
(`0016_integration_status.sql`). The app boots and is fully usable — sign
in, budget, add transactions by hand — with only Supabase configured.

This works through one status table, `integration_status`, written by
whichever background job actually holds the relevant secret (`heartbeat`
for Gmail/Anthropic/healthchecks; the statement-ingest script for
statement reconciliation) using the service-role key, and read by the
dashboard the same way it reads every other table — as the authenticated
operator, under RLS. **The dashboard never holds any integration's
secrets itself.** A key absent from `integration_status` (the job that
would write it has never run) is treated identically to "not configured"
— fail toward an honest banner, never toward a silent gap or a crash. See
`dashboard/lib/data/integration-status.ts` and
`dashboard/components/honest-data/IntegrationNotice.tsx`.

The card-status UI itself is generic too. As of the commit that retired
`detectCardKind` and the bespoke per-issuer gauge components
(`HsbcGauge`, `UobGauge`, `QuarterPills`), every card's dashboard panel
(`CardStatusPanel`, `RateTrack`, `TierTrack`, `GateChips`, `GroupStrip`)
is driven entirely by §6's self-describing evaluator contract — nothing
in the dashboard branches on which specific card it's rendering. A
`has_rules = false` method (a wallet with no rewards mechanics) renders
as a plain budget-only card (`BudgetOnlyCard`), also generically.

**One route is the exception, and it's worth knowing about if you're not
using the Singapore worked example's cards:** `/cards/tier-3` is
hardcoded to `uob_one` and a `TIER3_THRESHOLD` of 2000, specifically
built to answer "is committing to this one card's Tier 3 safe" — see
`dashboard/app/(protected)/cards/tier-3/page.tsx`. It's a leftover from
the worked example, not part of the generic contract. If you don't have
an equivalent card, that one route is either irrelevant or will render
against data that doesn't mean what its labels say — everything else in
the dashboard degrades generically; this one page doesn't.

---

## 9. Manual entry and the dashboard as an input surface

An earlier design had the dashboard as strictly read-only, with
corrections routed through the (since-retired) Telegram bot. That was
superseded before the bot was removed: the dashboard accepts input for
two reasons a read-only design can't serve —

1. **Budget planning** is inherently interactive — comparing a proposed
   cap against several months of actuals belongs in the same view as the
   trend data, not in a migration file. `budgets` has full CRUD from the
   dashboard.
2. **Non-card spending** — cash, a bank transfer, anything the ingest
   pipeline structurally cannot see — is entered by hand.
   `transactions.source = 'manual'` exists exactly for this; the
   idempotency constraint is written so manual rows don't need a
   `source_ref`.

The security consequence: RLS write policies exist on exactly two
tables, `budgets` (full CRUD) and `transactions` (`INSERT`, and
`UPDATE`/`DELETE` restricted to `source = 'manual'` rows only — a bug or
a hostile session must never be able to rewrite bank-sourced history).
Every other table stays default-deny. See §10 for how those policies are
scoped.

---

## 10. Security model

### Hosting decision

Supabase Cloud, not self-hosted. Self-hosting means owning Postgres
patching, firewall rules, disk encryption, backup verification, and
intrusion detection yourself — for this system, managed is the more
secure option, not the less secure one. Pick whichever region is
physically closest to you; nothing in the schema or code assumes a
particular region (see `docs/setup/supabase.md` for the reference
deployment's own choice and why it isn't a requirement for yours).

### The design principle that matters most

**Make a breach embarrassing rather than costly.** Card numbers are
redacted at parse time — only the last 4 digits are ever stored, never a
full PAN. No credentials, no ability to move money live in this system
anywhere. An attacker who got in would learn where you shop, not gain any
ability to spend your money. Design to that standard, and every other
control below is a second line of defence, not the only line.

### Three independent gates protect the data

1. **Grants.** `anon` and `authenticated` hold no table or function
   privileges by default (`revoke ... from anon, authenticated` at
   schema creation, restated via `alter default privileges` so it
   extends to future migrations too). An unauthenticated request gets
   `42501 permission denied`, refused before RLS is even consulted —
   not empty rows.
2. **RLS**, default-deny on every table from creation, never retrofitted.
   Every policy checks a real allow-list function (an `is_operator()`-
   style check against an explicit admin table), never a bare `auth.uid()
   is not null` — a policy keyed to "is this any authenticated user" is
   wrong the moment self-signup is possible at all, and Supabase's
   `/auth/v1/signup` endpoint is public by default.
3. **Signup disabled.** No new account can be created once you turn this
   off in the auth settings — see `docs/setup/supabase.md` §7. This is a
   required step for a public repo's deployment, not a footnote: an
   unconfirmed signup-disable is the difference between "my data" and
   "anyone who finds my Supabase URL's data."

Any one of these three failing on its own still leaves two intact.
Vercel — the dashboard's own runtime — holds **no secrets at all**, only
the Supabase URL and the publishable (anon) key, both meant to be public.

### A defence-in-depth trap that has already bitten this project twice

**PostgreSQL automatically grants `EXECUTE` on a newly created function
to the `PUBLIC` pseudo-role**, independently of any `ALTER DEFAULT
PRIVILEGES` you might have already run. Revoking a privilege from named
roles (`anon`, `authenticated`) does nothing to this separate `PUBLIC`
grant, because every role — `anon` included — is implicitly a member of
`PUBLIC`. The only statement that actually closes it targets `PUBLIC`
directly (`revoke execute on all functions in schema public from
public`). This repo's own migrations do this and re-issue the
default-privileges version for future migrations — but that does not
cover a function *you* add later in a migration that doesn't explicitly
revoke. **Every new function needs its own explicit `revoke ... from
public` line.** See `0007_rules_engine.sql`'s "DEFENCE IN DEPTH" section
for the full story of how this was found, twice.

### A second trap, less obvious, found the hard way: `SECURITY INVOKER` triggers and RLS

This project's default posture is "never `SECURITY DEFINER`" — triggers
and functions run as the calling role, subject to the same RLS the
caller would be subject to querying directly, with exactly one deviate
(`is_operator()` itself, which has to bypass RLS to answer "is this user
an operator" in the first place).

That default posture has a sharp edge: **a trigger that needs to write
across a table boundary RLS restricts will silently do nothing, with no
error, if it runs `SECURITY INVOKER`.** This actually happened here. A
trigger that propagated a merchant's category onto its own transactions
(`0010_propagate_merchant_category.sql`) ran `SECURITY INVOKER`
deliberately, matching the project's default stance — but the dashboard's
own `UPDATE` policy on `transactions` only allows the caller to touch
`source = 'manual'` rows. The trigger's own `UPDATE` therefore matched
**zero rows** for every bank-sourced transaction, forever, with no
exception raised anywhere. The UI reported success (the merchant row
really did update); the transactions never moved; nobody noticed for a
full day, because nothing re-verified live data against the claim that
this was fixed. The fix (`0013_fix_propagation_rls_gap.sql`) made the
trigger `SECURITY DEFINER`, narrowly — it can only ever copy a value the
operator already approved (via the merchant row's own RLS-gated update)
onto that merchant's transactions, nothing else, and direct `EXECUTE`
stays revoked from every role so it can only ever fire as a trigger side
effect.

**The general lesson, if you write your own trigger that needs to reach
across an RLS-protected table:** either scope its `SECURITY DEFINER`
narrowly and document exactly what it's allowed to touch and why (follow
`0013`'s own comment block as the template), or accept that it will
silently no-op for any caller whose RLS scope doesn't already cover the
target rows — and test that assumption against a real non-privileged
session, not just against a service-role connection where the gap is
invisible. "The command succeeded" and "the number changed" are
different claims; this bug is the canonical example of why that
distinction matters enough to say twice.

### Everything else

- Gmail OAuth scoped to `gmail.readonly`, nothing broader — see
  `docs/setup/gmail.md` for why.
- The service-role key lives only in the Supabase Vault and GitHub
  Secrets — never in a repo, never in an Edge Function env that gets
  logged. It bypasses RLS entirely and is the single most likely cause
  of a real compromise if it ever leaks.
- Statement PDFs never persist outside the ephemeral GitHub Actions
  runner, which is destroyed on completion.
- Each runtime (Edge Functions, GitHub Actions, Postgres via Vault,
  Vercel) reads only its own secret store — duplication across stores is
  correct here, not a smell. See `docs/getting-started.md`'s
  required-vs-optional table and the individual `docs/setup/*.md` guides
  for exactly which variables go where.
- Run Supabase's built-in security linter (**Database → Advisors**)
  before considering any schema change done.

### Regulatory note — read this as a starting point, not a guarantee

This system reads only your own mail and your own documents, and never
scrapes a bank portal or stores banking credentials. Whether any specific
data-protection regime applies to your own deployment depends on your
jurisdiction and how you use it — this is not legal advice, and if you
ever turn this into something that serves other people's data rather
than your own, treat that as a materially different threat model
requiring its own review, not an extension of this one.

---

## 11. Known limitations, by design

- **Cash and anything the ingest pipeline structurally cannot see** is
  invisible until entered manually. A budget that never gets manual
  entries for cash spend will systematically understate.
- **MCC (merchant category code) is inferred, not authoritative.**
  Alert emails rarely carry it; the `merchants` table's classification is
  the actual source of truth, seeded with a handful of known merchants
  and otherwise built up by triage over time. Expect category accuracy to
  improve over the first couple of months of real use, not to be
  perfect from day one.
- **Foreign-currency spend can be uncosted for a while.** If a bank's
  alert reports only a foreign amount with no local-currency conversion,
  the system stores it that way rather than guessing — an honest gap
  beats a confident wrong number. Reconciliation against the statement
  fills in the real converted amount, typically within the same billing
  cycle.
- **Recurring/card-on-file transactions may not alert at all**, depending
  on the bank. Reconciliation catches these at the next statement, but
  the live budget will understate until then.
- **Threshold and cap state includes `provisional` rows**, so a
  transaction that later reverses (a dropped pre-authorisation, a
  refund) can briefly overstate progress toward a threshold. This is
  accepted deliberately — it errs toward overestimating spend, not
  underestimating it.

---

## 12. Where to go from here

- **A complete worked example** encoding four real Singapore cards and
  wallets onto this schema — [`docs/reference-example-sg.md`](reference-example-sg.md).
- **Setting up your own deployment** — [`docs/getting-started.md`](getting-started.md)
  and the guides under `docs/setup/`.
- **Historical design and build-planning material** — not needed to run
  or extend this system, kept for provenance — [`docs/design/`](design/).
