# Reference example: four Singapore cards and wallets

**This is a worked example, not the product's scope.** FlowInk's schema
and rules engine (see [`docs/architecture.md`](architecture.md)) are
generic — they don't know or care what country your cards are issued in.
This document exists because a generic schema is easier to trust once
you've seen it actually hold something real, and because encoding a new
card's rules is much easier with a complete worked example to copy the
shape of than from the schema alone.

The shipped reference deployment this repo was originally built for holds
four Singapore payment methods: **UOB One** (credit card), **HSBC
Revolution** (credit card), **Citi Cash Back** (credit card, staged
before issuance), and **DBS PayLah!** (mobile wallet). If your own cards
are none of these, the goal is to read this document as "here is how
someone encoded their situation onto the generic schema," find the
closest-shaped example below, and adapt it — not to expect it to apply to
you directly.

**A caveat that matters more than any of the specific numbers below:**
reward rates, thresholds, and terms & conditions for real credit cards
change without notice, sometimes more than once a year (this data set
alone reflects at least four separate rate/term revisions across three
cards in under a year). Everything below was verified against official
issuer T&Cs and cross-checked sources as of **August 2026** — it is a
point-in-time snapshot, not a live feed. **Re-verify against a current
statement or the issuer's current T&C page before trusting any number
here for your own money**, regardless of how recently this document was
touched.

---

## The four methods, as rows

```
id              display_name       issuer  method_type   period_type  reward_type  has_rules
uob_one         UOB One            UOB     credit_card   statement    cashback     true
hsbc_revo       HSBC Revolution    HSBC    credit_card   calendar     miles        true
paylah          DBS PayLah!        DBS     wallet        calendar     (null)       false
citi_cashback   Citi Cash Back     Citi    credit_card   statement    cashback     true (staged)
```

See `supabase/migrations/0002_seed.sql` for the exact `INSERT`
statements and `supabase/migrations/0015_generic_rules_engine.sql`'s
backfill section for how each card's rows were annotated with the
generic evaluator's newer columns (`cap_basis`, `reward_form`,
`gate_scope`, `condition_key`, `credit_block_size`/`credit_floor`,
`reward_unit`) — those two files together are the authoritative current
source, more current than any SQL reproduced in this document.

`citi_cashback` is **staged**, not omitted: its `payment_methods` row
exists with `active = false`, `last4 = null`, and its `method_rules` rows
carry `valid_from = '2099-01-01'` — a foreign-key-satisfying placeholder
far enough in the future that the rules never accidentally apply before
the card exists. On issuance: flip `active = true`, set the real `last4`
and `cycle_day`, add the Gmail sender to a filter, and correct
`valid_from` to the actual effective date. As of this document's last
verification, that card had not yet been issued on the reference
deployment.

---

## Alert email formats and parser traps

Each issuer's alert email format differs enough that a single generic
parser prompt has to be tuned against real samples, not assumed to
generalise. Formats confirmed against real received mail as of August
2026:

**HSBC** — sender `HSBC.Bank.Singapore.Limited@notification.hsbc.com.hk`,
subject "Transaction Alerts (Credit Card)". HTML table with labelled
rows: masked card number (last 4 visible), transaction date
`12/JUL/2026`, amount `SGD214.75` (amount and currency concatenated, no
space), and a free-text description.

**UOB** — sender `unialerts@uobgroup.com`, subject "UOB - Transaction
Alert". Single free-text sentence, e.g. *"A transaction of USD 412.50
was made with your UOB Card ending 1111 on 18/06/26 at Nordkap Optics
GmbH."*, followed by a long legal disclaimer that gets stripped before
the parser ever sees it. Date is **DD/MM/YY**.

**PayLah** — sender `paylah.alert@dbs.com`, subject "Transaction Alerts".
Body includes a date with **no year** (`15 Sep 20:14 (SGT)`) — the year
is inferred from the email's own `internalDate`, with an explicit
December-to-January rollover correction, or every early-January PayLah
transaction lands in the wrong year.

**Citi** — not yet captured; the card had not been issued as of this
document's last verification. Capture a real sample and add a parser
branch before relying on Citi ingestion.

Traps specific to this set of issuers, beyond the generic parser contract
in `docs/architecture.md` §5:

1. **UOB alerts report foreign currency, not SGD, with no converted
   amount.** The sample above reads `USD 412.50` — the SGD cost, plus a
   3.25% FX fee, only appears at statement. Store the transaction exactly
   as received; don't guess a conversion.
2. **Three different date formats, and PayLah has no year at all** — see
   above.
3. **PayLah eVoucher-format alerts have been observed to omit `last4`
   entirely** on the reference deployment (two messages rejected by the
   general "no last4, don't guess the card" rule). It's not yet confirmed
   whether this is a permanent property of that message format or a
   parsing gap — if it's the former, PayLah eVoucher alerts likely need
   their own routing rule rather than a relaxation of the general
   no-guessing rule. **Flagged as unresolved, not fixed** — if you hit
   this with your own wallet's alerts, don't assume the general rule
   should simply be loosened; check whether the format genuinely never
   carries a card reference first.
4. **PayLah alerts state the transaction type in the body** ("Scan & Pay
   Transfer" vs. a P2P send vs. a top-up) — extract it at parse time and
   set `is_transfer` accordingly, rather than waiting on merchant
   classification to catch a top-up that was never going to be spend in
   the first place.
5. **Merchant strings arrive dirty.** Line-wrap artefacts split words
   (`N.N.HARBOURLIGHT BISTRO PTE. LT D.`); normalise before matching —
   collapse whitespace, strip punctuation and corporate suffixes, and
   match on the normalised form.

---

## The MCC problem

Alert emails give a merchant name, essentially never an MCC. Statements
usually omit it too. But MCC is frequently what actually determines
reward eligibility, which makes classification the single biggest source
of error in a card-optimisation feature — worse for this set of cards
than for the base expense-tracking goal, since a mis-classified merchant
still counts correctly toward a *budget*, just possibly the wrong
category.

Known traps encoded in this reference deployment's `merchants` table and
comments:

- HSBC Revolution's bonus categories are dining, shopping, travel,
  ride-hailing and taxis — **groceries are explicitly not included.**
  Tapping a phone at a supermarket earns the base rate, not the bonus
  rate.
- MCC 5814 (fast food) is excluded from HSBC Revolution's bonus and
  catches food-delivery platforms and some ordinary cafes that code
  unexpectedly under it.
- MCC 4111 (mass transit) earns nothing extra on HSBC, but is a UOB One
  "selected merchant" category earning a meaningfully higher rate.
- MCC 4722 (travel agencies — the online-travel-agent kind, not a direct
  airline/hotel booking) earns nothing on HSBC Revolution; a direct
  booking with the airline or hotel does.
- Citi Cash Back excludes bill payments, education, and government/tax
  transactions from **both** its bonus cashback and its S$800 monthly
  minimum-spend calculation — a transaction can be real spend and still
  not count toward whether the card's minimum was even met.

**Design rule this project follows:** a merchant's reward-eligibility
flag starts unknown/null, never assumed. When a later statement reveals
the real earn rate for a merchant, the row gets backfilled and its
`confidence` flips from `'guessed'` to `'confirmed'`. Expect roughly two
months of real use before a household's recurring merchant set
stabilises.

---

## UOB One — worked example of a quarterly all-or-nothing mechanic

This is the most structurally complex mechanic in the set, and the best
illustration of why `docs/architecture.md` §6's `evaluate_period_group()`
exists at all.

- **Tiers are a flat quarterly dollar payout, not a percentage** —
  S$60 / S$100 / S$200 at three spend tiers, keyed by quarterly spend
  thresholds. The commonly-quoted "3.33%" figure is a *derived* effective
  rate (payout ÷ threshold), never stored as a rate itself.
- **Quarters are three consecutive statement months, anchored to the
  card's own account-approval date** — not calendar quarters. All three
  months must independently clear both the spend threshold and a
  **10-transactions-per-month** gate; missing either in *any one* of the
  three months forfeits the entire quarter's payout, not just that
  month's share.
- On the reference deployment, the account-approval date
  (`aggregation_anchor_date`) has never been set — it defaults to `NULL`,
  which makes the evaluator fall back to a labelled trailing-window
  approximation (`grouping = 'anchor_unknown_trailing_window'`) rather
  than a true anchor-aligned quarter. This is called out explicitly in
  the evaluator's own output, not silently assumed to be correct — see
  `docs/architecture.md` §6 for what changes once a real anchor date is
  set.
- Beyond the tier payout, additional category bonuses apply per
  statement month (groceries, a set of "selected merchants" including
  ride-hailing and a specific delivery platform, one petrol brand, one
  utility biller) — each with its own rate that only unlocks at certain
  tiers, all sharing one combined cap (S$120/statement month, separate
  from and outside the quarterly tier payout).
- **Not modelled at all, flagged as a known gap:** UOB's own T&C
  describes a pro-rated first-quarter payout for a newly issued card that
  only clears its tier threshold in the quarter's second or third month.
  This reference deployment's card was well past its first quarter by
  the time this was documented, so it was never implemented or tested —
  if your own card is inside its first quarter, this mechanic is
  unhandled and worth building against `rule_overrides` (see
  `docs/architecture.md` §6) rather than assuming the standard tier logic
  covers it.
- **A live quirk found on the reference deployment, not from reading the
  T&C:** UOB's statement close date shifts to the next business day when
  the nominal close day falls on a weekend. A single fixed `cycle_day`
  can't express that — on this deployment, one transaction landed in the
  wrong statement month because of exactly this (a mid-August interest
  posting that should have belonged to one statement month landed in the
  next one instead, since the 15th fell on a Sunday that particular
  month). A correct fix needs a Singapore public-holiday-aware calendar;
  this repo does not implement one. If your own card's statement date can
  fall on a weekend, expect the same one-transaction-per-shift class of
  misattribution until/unless that's built.

---

## HSBC Revolution — calendar-month miles, contactless-only condition

- Calendar-month periods (unlike UOB and Citi's statement-month basis) —
  the bonus cap resets on the 1st regardless of when the card statement
  itself closes.
- Rewards are stored as points-per-dollar (`10X`/`20X`), not directly as
  a miles-per-dollar rate, because the points-to-miles conversion ratio
  is **partner-dependent**, not a single number — one ratio to one
  frequent-flyer partner, a different (better) ratio to others. The
  `payment_methods.reward_unit` value on this card names one specific
  partner's equivalent explicitly, precisely so a reader isn't misled
  into thinking it's a universal conversion.
- **A condition the ingest pipeline cannot observe at all:** the bonus
  rate's higher tier requires a minimum average daily balance in a
  specific *sole-owned* bank account, reassessed monthly — nothing an
  alert email or a statement PDF will ever state. This is exactly what
  `method_conditions` (§6 of `docs/architecture.md`) exists for: the
  evaluator defaults to the lower, unconditioned rate unless an operator
  explicitly records that month's balance condition as met. On the
  reference deployment, that flag has never been set — every month has
  defaulted to the standard tier.
- **A second condition alert data structurally cannot confirm:** the
  bonus rate requires the purchase be made contactless or online — a
  chip-and-PIN transaction in an otherwise-bonus category earns only the
  base rate. Alert emails don't state payment method. The reference
  deployment's rule rows carry an `estimate_caveat` saying exactly this,
  surfaced in the evaluator's `estimate_caveats[]` output whenever a
  bonus-category row is matched — the number shown is explicitly labelled
  an estimate, not presented as settled fact, until statement
  reconciliation can (partially) confirm it.

---

## Citi Cash Back — the crediting-block mechanic

- **Below a S$800/statement-month minimum spend, every category (bonus
  and base) drops to a flat 0.2%** for that whole month — a `gate_scope
  = 'all_rewards'` gate in the generic evaluator's terms, distinct from
  UOB's gate (which only affects the tier payout, not category rates).
- The minimum-spend calculation and the cashback calculation share the
  same exclusion list — bill payments, education, government/tax,
  insurance, and public-transit spend all count toward neither.
- **Cashback credits in fixed S$10 blocks, and only once accrual reaches
  a S$50 floor.** Below the floor, the accrued amount is real but not yet
  "credited" — a genuinely distinct state (`accrued_uncredited` in the
  evaluator's `crediting` output), not an approximation or a rounding
  artefact to be glossed over in a dashboard.

---

## DBS PayLah! — a wallet with no rewards mechanics at all

- `has_rules = false`. It appears in every budget and spend view and in
  nothing card-optimisation-related — the schema and rules engine treat
  a `has_rules = false` row as a first-class, fully generic case (renders
  as a plain budget-only card in the dashboard, per
  `docs/architecture.md` §8), not a special-cased afterthought.
- **Transfers are not spend.** P2P sends to another person and top-ups
  from a linked bank account both get `is_transfer = true` and are
  excluded from spend totals — counting a top-up as expenditure
  double-counts the same money once as a "transfer" and again whenever
  it's actually spent from the wallet.
- Alerts cover outgoing payments only; incoming transfers are out of
  scope entirely.
- PayLah alerts identify the recipient or merchant, never an MCC, so
  classification runs entirely through the `merchants` table — there is
  no MCC-based shortcut available for this method the way there sometimes
  is for a card.

---

## Where the schema stops being generic (dashboard side)

One dashboard route is a direct leftover of this specific worked example,
not part of the generic contract described in `docs/architecture.md` §8:
**`/cards/tier-3`** is hardcoded to `uob_one`'s id and a fixed S$2,000
threshold, built to answer one specific question — "is committing to this
one card's top tier safe, based on the lowest month in a trailing
window" — for this card. If you don't hold an equivalent card, this route
either doesn't apply to you or will render against data whose labels
don't mean what they say. Every other card-status surface in the
dashboard is genuinely generic and needs no changes to work with your own
cards; this one route does not.

---

## Sources

Rates, thresholds, and category rules above were verified against
official issuer terms and conditions and cross-checked sources as of
August 2026, as part of building the reference deployment. The original
design document this section is drawn from pointed at a "research
report" as its citation trail; that report was produced in a chat
session while building this project and was never a file committed to
this repo — it is not recoverable from this checkout, and this document
does not pretend otherwise. What you're reading here is the *outcome* of
that research as it's encoded in the schema (`supabase/migrations/
0002_seed.sql`, annotated further by `0015_generic_rules_engine.sql`),
not a re-derivation of it, and not a live citation trail. Given how often
card terms change, treat any specific rate above as a starting point to
verify against the issuer's current T&C directly, not a citation to
trust indefinitely.
