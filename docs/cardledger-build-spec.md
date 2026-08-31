# FlowInk — Build Specification

Personal credit card spend tracking and threshold optimisation.
Singapore. UOB One, Citi Cash Back, HSBC Revolution.

Stack: Supabase Cloud (Pro, ap-southeast-1) · Edge Functions + Supabase Cron · GitHub Actions · Gmail API · Anthropic API · Telegram
Target build agent: Claude Code

**Standalone. No VPS, no n8n, no always-on server.** Everything runs either inside Supabase or in a GitHub Actions runner.

---

## 1. What this is for

### The problem

Every card and wallet already has its own analytics, locked inside its own app. UOB TMRW shows UOB. Citi shows Citi. HSBC shows HSBC. PayLah shows PayLah. **Nothing shows total spend.** There is no view of what a month actually cost, where it went by category, or how this month compares to the last six.

This system consolidates all payment sources into one ledger so that view exists.

### Goals, in priority order

**1. Primary — track all expenses and plan budgets.**
Every transaction across every payment method, categorised, in one place. Budget caps per category per period. Spending analysis over time: month on month, category trends, merchant concentration, what is drifting.

This is the point of the system. Cards are one input to it, not the purpose of it.

**2. Secondary — optimise card benefits.**
Track spend per card and per category against each card's thresholds, tiers and caps, so the rewards each card is capable of are actually earned rather than missed by a few dollars or one transaction.

**3. Tertiary — the dashboard.**
One overview surfacing insights across total spending, across periods, across categories, and across cards, with card optimisation status alongside. The consolidated picture that no single bank app can give.

### Scope note

Because the primary goal is total expense tracking, **non-card payment methods are in scope**. PayLah in particular carries a meaningful share of everyday spend and has no card rewards relevance whatsoever — it is included purely because a budget that ignores it is wrong.

### Non-goals

- Not net worth, investments, or CPF tracking.
- Not a bank aggregator. No credential sharing, no portal scraping.
- Not a payments tool. Read-only, always.

### The design constraint that shapes everything

Statements arrive monthly, 5–7 days after cycle close. Data can be five weeks stale — useless for budgeting in the month you are living in, and useless for hitting a threshold you are still inside.

Transaction alert emails arrive in seconds. **Alerts are the primary data source. Statements are the audit trail.**

---

## 2. Architecture

```
┌─ LAYER 1 · LIVE ────────────────────────────────────┐
│  Supabase Cron (every 2 min)                        │
│  → Edge Function `ingest-alerts`                    │
│  → Gmail API search from watermark                  │
│  → Anthropic API parse → Supabase                   │
│  status = provisional                    latency ~2m │
└──────────────────────────────────────────────────────┘
                          ↓
┌─ LAYER 2 · RECONCILE ───────────────────────────────┐
│  GitHub Actions (daily cron)                        │
│  → Gmail API / Drive → decrypt PDF (qpdf)           │
│  → parse → match provisional → confirmed  monthly    │
└──────────────────────────────────────────────────────┘
                          ↓
┌─ LAYER 3 · RULES ───────────────────────────────────┐
│  Postgres functions. Deterministic. No LLM.         │
└──────────────────────────────────────────────────────┘
                          ↓
┌─ LAYER 4 · OUT ─────────────────────────────────────┐
│  Edge Function `nudge` on Cron → Telegram           │
│  Dashboard (phase 4)                                 │
└──────────────────────────────────────────────────────┘
```

### Why two runtimes and not one

Supabase Edge Functions run Deno. **They cannot shell out to `qpdf` or `pikepdf` to decrypt a password-protected statement PDF.** No native binaries, no subprocess.

That single constraint splits the system:

| Job | Runtime | Why |
|---|---|---|
| Alert ingest | Edge Function + Supabase Cron | Pure text and HTTP. Well inside limits. Needs to run every 2 min, which GitHub Actions cannot do reliably. |
| Statement ingest + reconcile | GitHub Actions | Full Ubuntu runner. `apt install qpdf`, Python, no timeout pressure. Runs daily, so scheduler jitter is irrelevant. |
| Rules engine | Postgres functions | Zero latency, no network hop, deterministic. |
| Nudge | Edge Function + Supabase Cron | Once nightly, trivial payload. |

Don't try to force PDF handling into an Edge Function. Don't try to force 2-minute polling into GitHub Actions — its cron is best-effort with 5–15 minute delays under load.

### Edge Function limits to design against

- Wall clock: 400s per worker
- Request idle timeout: 150s
- CPU time: 2s per request (async I/O does not count, so Gmail and Anthropic calls are fine)
- Supabase Cron jobs should run under 10 minutes, max 8 concurrent

Batch alert processing to a maximum of 20 messages per invocation. If the watermark query returns more, process 20 and leave the watermark so the next tick picks up the rest. Backfill drains itself.

**Why two layers.** Alerts fire at authorisation. Statements post at settlement. They disagree on foreign currency amounts, tips, pre-authorisations, and refunds. The fast layer must never be treated as truth.

---

## 3. The trap that will break this if you get it wrong

**Card periods are not calendar months, and they are not the same as each other.**

| Card | Period basis | Notes |
|---|---|---|
| UOB One | **Statement month**, anchored to card approval date | Quarters are three consecutive statement months from approval, NOT calendar quarters |
| Citi Cash Back | **Statement month** | S$800 minimum and S$80 cap both per statement month |
| HSBC Revolution | **Calendar month** | S$1,000 bonus cap resets on the 1st |

Model this explicitly. A single `period_type` enum on the card config, and a function that maps a transaction date to the correct period key per card. Do not assume calendar months anywhere.

UOB's quarterly mechanic is all-or-nothing: miss the minimum in any one of the three statement months and the entire quarter's cashback is forfeited. The system must track quarter state, not just month state, and must warn early enough to act.

---

## 4. Data model

Rates change constantly. In 2025–26 alone: UOB One raised its floor from S$500 to S$600 and doubled the transaction requirement to 10, HSBC devalued its KrisFlyer ratio by 20% then restructured the whole card in April 2026, and the UOB One Account cut rates three times in seven months.

**Therefore: card rules live in the database as data, never in code.** A rate change should be an UPDATE, not a deploy.

```sql
-- ============ CONFIG ============

-- Generalised: not every payment method is a rewards card.
-- PayLah is a wallet with no rules, but its spend is essential to the budget.
create table payment_methods (
  id            text primary key,           -- 'uob_one','citi_cashback','hsbc_revo','paylah'
  display_name  text not null,
  issuer        text not null,
  last4         text,                       -- routing key: present in every alert email
  method_type   text not null check (method_type in ('credit_card','wallet','bank','cash')),
  period_type   text not null check (period_type in ('calendar','statement')),
  cycle_day     int,                        -- statement close day, null if calendar
  reward_type   text check (reward_type in ('cashback','miles')),  -- null for wallets
  has_rules     boolean default true,       -- false for PayLah: budget only, no optimisation
  active        boolean default true
);

-- Seeded from confirmed alert samples, August 2026:
--   hsbc_revo  last4 2222   sender HSBC.Bank.Singapore.Limited@notification.hsbc.com.hk
--   uob_one    last4 1111   sender unialerts@uobgroup.com
--   paylah     last4 3333   sender paylah.alert@dbs.com   (mobile, not card)
--   citi_cashback — card not yet issued, add as a config row when it arrives

-- Tiered/threshold rules. Only for methods where has_rules = true.
create table method_rules (
  id            bigserial primary key,
  method_id     text references payment_methods(id),
  rule_type     text not null,              -- 'min_spend','tier','category_rate',
                                            -- 'cap','txn_count','quarterly_gate'
  categories    text[],                     -- null = applies to all
  threshold     numeric,                    -- min spend / tier entry point
  rate          numeric,                    -- 0.08 = 8%, or mpd for miles
  cap_amount    numeric,                    -- max reward per period
  payout        numeric,                    -- fixed quarterly payout if applicable
  txn_min       int,                        -- min transaction count
  priority      int default 0,              -- fill order, highest first
  valid_from    date not null,
  valid_to      date,                       -- null = current
  notes         text
);

-- ============ LEDGER ============

create type txn_status as enum ('provisional','confirmed','disputed','reversed');
create type txn_source as enum ('alert','statement','manual');

create table transactions (
  id              uuid primary key default gen_random_uuid(),
  method_id       text references payment_methods(id) not null,
  txn_date        date not null,
  posted_date     date,
  merchant_raw    text not null,            -- exactly as received
  merchant_id     bigint references merchants(id),
  amount          numeric(12,2) not null,   -- SGD, positive = spend
  currency        text default 'SGD',
  fx_amount       numeric(12,2),
  mcc             text,                     -- rarely available, nullable
  category        text,                     -- resolved via merchant_id
  is_transfer     boolean default false,    -- P2P / top-up, exclude from spend totals
  status          txn_status not null default 'provisional',
  source          txn_source not null,
  source_ref      text,                     -- Gmail message id / statement file
  period_key      text not null,            -- e.g. 'uob_one:2026-09'
  reconciled_with uuid references transactions(id),
  created_at      timestamptz default now(),
  unique (method_id, source, source_ref)    -- idempotency
);

create index on transactions (method_id, period_key);
create index on transactions (txn_date);
create index on transactions (status) where status = 'provisional';

-- ============ MERCHANTS ============
-- The piece that actually takes time. Classify once, reuse forever.

create table merchants (
  id            bigserial primary key,
  match_pattern text not null unique,       -- normalised substring
  display_name  text not null,
  category      text not null,
  known_mcc     text,
  hsbc_eligible boolean,                    -- confirmed 4 mpd category
  is_transfer   boolean default false,      -- known P2P recipients, PayLah top-ups
  confidence    text default 'guessed',     -- 'guessed'|'confirmed'
  created_at    timestamptz default now()
);

-- ============ BUDGETS ============
-- Primary goal. Calendar-month based, independent of card statement cycles.

create table budgets (
  id          bigserial primary key,
  category    text not null,
  period      text not null,                -- '2026-09', or 'default'
  monthly_cap numeric(12,2) not null,
  alert_at    numeric default 0.8,          -- warn at 80%
  unique (category, period)
);
```

### Categories (fixed vocabulary)

`groceries · dining · petrol · commute · transport · bills · online · retail · healthcare · household · other`

`commute` = Grab and taxis. `transport` = MRT and bus via SimplyGo. They earn differently and must stay separate.

### Two period models running side by side

This is a direct consequence of the goal ordering, and it must be built in from the start:

- **Budgets and spending analysis run on calendar months.** That is how a household thinks about money, and it is the only basis on which PayLah, cards and cash are comparable.
- **Card optimisation runs on each card's own period.** Statement months for UOB and Citi, calendar for HSBC.

So a single transaction belongs to **two** periods: a calendar month for budgeting and a `period_key` for card rules. Store both. Never collapse them into one.

### Confirmed alert formats (illustrative samples matching real formats)

Build the parser against these. Each issuer differs enough that a single generic prompt will fail.

**HSBC** — `HSBC.Bank.Singapore.Limited@notification.hsbc.com.hk`, subject "Transaction Alerts (Credit Card)". HTML table with labelled rows: Card Number (masked, last 4 visible), Transaction Date `12/JUL/2026`, Transaction Time, Transaction Amount `SGD214.75`, Description e.g. "Riverside Home Store". Amount and currency are concatenated with no space.

**UOB** — `unialerts@uobgroup.com`, subject "UOB - Transaction Alert". Single free-text sentence: `A transaction of USD 412.50 was made with your UOB Card ending 1111 on 18/06/26 at Nordkap Optics GmbH.` Followed by a long legal disclaimer — strip everything after the first sentence before sending to the parser. Date is **DD/MM/YY**.

**PayLah** — `paylah.alert@dbs.com`, subject "Transaction Alerts". Body: `We refer to your PayLah! Scan & Pay Transfer dated 15 Sep...` then Date & Time `15 Sep 20:14 (SGT)`, Amount `SGD8.50`, From `PayLah! Wallet (Mobile ending 3333)`, To `N.N.HARBOURLIGHT BISTRO PTE. LT D.`

**Citi** — card not yet issued. Capture a real sample before writing its parser branch.

### Parser traps confirmed by the samples

**1. UOB alerts report foreign currency, not SGD.**
The sample reads `USD 412.50` with no SGD equivalent. For any non-SGD transaction the alert **cannot** tell us what it cost, since the converted amount plus the 3.25% FX fee only appears at statement.

Handling: store `amount` and `currency` exactly as received. Do **not** guess an SGD figure. Surface foreign transactions in the dashboard as "pending conversion" and exclude them from budget totals with a visible note. Reconciliation fills in the real SGD amount within the month. An honest gap beats a confident wrong number.

**2. Three different date formats, and PayLah has no year.**
HSBC `12/JUL/2026`. UOB `18/06/26` = DD/MM/YY. PayLah `15 Sep` with no year at all — infer from the email's `internalDate`, and handle the December-to-January rollover explicitly or every early-January PayLah transaction lands in the wrong year.

**3. Route on last4, not on label alone.**
`unialerts@uobgroup.com` sends for every UOB card. The label identifies the issuer; the last 4 digits identify the card. Match `last4` against `payment_methods`. **If no match, do not guess** — write to `parse_failures` and alert. An unrecognised card is either a new card or a fraudulent one, and both need a human.

**4. PayLah states the transaction type.**
"Scan & Pay Transfer" is a merchant payment. P2P sends and wallet top-ups read differently. Extract the type string and set `is_transfer` at parse time rather than waiting on merchant classification.

**5. Merchant strings are dirty.**
`N.N.HARBOURLIGHT BISTRO PTE. LT D.` shows line-wrap artefacts splitting words. Normalise before matching: collapse whitespace, strip punctuation and corporate suffixes (PTE LTD, GMBH, INC), uppercase. Match on the normalised form.

### PayLah specifics

- `has_rules = false`. It appears in every budget and category view and in nothing card-related.
- **Transfers are not spend.** PayLah P2P to a friend, and top-ups from the linked DBS account, must be flagged `is_transfer = true` and excluded from spend totals. Counting a top-up as expenditure double-counts the money.
- Alerts cover outgoing payments only. Incoming is out of scope.
- PayLah alerts identify the recipient or merchant, not an MCC, so classification is entirely via the `merchants` table.

---

## 5. Seed data

**Verified against official issuer T&Cs and cross-checked sources, August 2026.** Full findings, citations, and discrepancy notes: [Singapore Credit Card Terms Verification — August 2026](#) (research report, this conversation). Re-verify before production regardless — see Section 13 item 5.

### What changed from the original draft

- **UOB One quarterly cashback is a flat dollar payout, not a percentage.** S$60 / S$100 / S$200 per quarter at Tiers 1/2/3. The "3.33%" figure is a derived effective rate, not a stored parameter — do not seed it as a rate.
- **UOB One additional-cashback cap raised to S$120/statement month** (was S$100, effective with the 22 Sep 2025 T&C revision).
- **DFI Retail Group removed as a UOB One bonus merchant** (Cold Storage, Giant, Guardian, 7-Eleven, Jasons, Marketplace, CART) effective 31 Jul 2025. **Groceries (MCC 5411) added instead** as a standalone tiered category — no bonus at Tier 1.
- **UOB One Account max EIR cut to 1.90% p.a.** (from 2.50%, effective 1 Dec 2025 — the third cut in 2025).
- **HSBC Revolution restructured 1 April 2026.** 4 mpd is now permanent (was a promo). Monthly cap **reverted to S$1,000** (was S$1,500 during the promo — if S$1,500 is in the DB, it is stale). **New 8 mpd tier** added for holders with ≥S$50,000 average daily balance in a sole HSBC Everyday Global Account, capped at S$1,200.
- **HSBC → KrisFlyer confirmed at 3:1** (devalued from 2.5:1 on 16 Jan 2025), giving an effective 3.33 mpd into KrisFlyer specifically. Best-partner transfers (Avios, Asia Miles, Flying Blue, EVA Infinity MileageLands) remain 2.5:1, the full 4 mpd.
- **Emirates Skywards confirmed unreachable from any Singapore-issued card**, including HSBC. Do not model it as a destination.

```sql
-- ============ PAYMENT METHODS ============

insert into payment_methods
  (id, display_name, issuer, last4, method_type, period_type, cycle_day, reward_type, has_rules) values
  ('uob_one',       'UOB One',           'UOB',  '1111', 'credit_card', 'statement', null, 'cashback', true),
  ('hsbc_revo',     'HSBC Revolution',   'HSBC', '2222', 'credit_card', 'calendar',  null, 'miles',    true),
  ('paylah',        'DBS PayLah!',       'DBS',  '3333', 'wallet',      'calendar',  null, null,       false);
  -- citi_cashback: insert when the card is issued. cycle_day set from the first statement.
  -- uob_one cycle_day: UNKNOWN. Set from a real statement before Phase 3. Blocks period_key.

-- ============ UOB ONE ============
-- Statement months. Quarters = 3 consecutive statement months anchored to
-- card account opening date (T&C definition), NOT calendar quarters.
-- All-or-nothing: miss the spend threshold or txn count in any one
-- statement month and the entire quarter's cashback is forfeited
-- (T&C clause 3.2). Exception: the very first quarter after issuance is
-- pro-rated if the tier is only met in month 2 or 3 — not modelled below,
-- add if this account is inside its first quarter.
-- Source: UOB One Card T&C ver 2.1, 22 Sep 2025, effective 1 Jul 2025.

insert into method_rules
  (method_id, rule_type, categories, threshold, rate, cap_amount, payout, txn_min, priority, valid_from, notes) values

  -- Gate: 10 transactions in EVERY statement month, at every tier
  ('uob_one', 'txn_count',      null, null,   null,   null, null, 10,  100, '2025-07-01',
   'Posted transactions only. Gate applies per statement month, not per quarter. T&C clause 3.1.'),

  -- Tiers. Flat quarterly payout, not a rate. Highest first; engine takes the first match.
  ('uob_one', 'tier',           null, 2000,   null, null, 200,  10,  30,  '2025-07-01',
   'Tier 3. Flat S$200/quarter. Effective rate ~3.33% is derived (200/6000), not stored.'),
  ('uob_one', 'tier',           null, 1000,   null, null, 100,  10,  20,  '2025-07-01',
   'Tier 2. Flat S$100/quarter. Effective rate ~3.33% is derived (100/3000).'),
  ('uob_one', 'tier',           null, 600,    null, null, 60,   10,  10,  '2025-07-01',
   'Tier 1. Flat S$60/quarter. Effective rate ~3.33% is derived (60/1800).'),

  -- Groceries (MCC 5411). No bonus at Tier 1. T&C clause 4.1, effective 1 Jul 2025.
  ('uob_one', 'category_rate',  '{groceries}', 2000, 0.0467, null, null, null, 30, '2025-07-01', 'Groceries at Tier 3'),
  ('uob_one', 'category_rate',  '{groceries}', 1000, 0.0267, null, null, null, 20, '2025-07-01', 'Groceries at Tier 2'),
  -- Tier 1: no row. Groceries earn base only below S$1,000.

  -- Selected merchants: Grab (excl. wallet top-up), McDonald's, Shopee (excl. wallet
  -- top-up), SimplyGo bus/MRT. T&C clause 4.1.
  ('uob_one', 'category_rate',  '{transport,commute}', 2000, 0.0667, null, null, null, 30, '2025-07-01',
   'Selected merchants at Tier 3: Grab, McDonald''s, Shopee, SimplyGo. Excludes Grab/Shopee wallet top-ups.'),
  ('uob_one', 'category_rate',  '{transport,commute}', 600, 0.05,   null, null, null, 10, '2025-07-01',
   'Selected merchants at Tiers 1 and 2. Same exclusions.'),

  -- Shell: Tier 3 only.
  ('uob_one', 'category_rate',  '{petrol}', 2000, 0.0167, null, null, null, 30, '2025-07-01',
   'Shell only, Tier 3 only. No bonus at Tiers 1 or 2 — verify petrol merchant code before relying on this.'),

  -- Singapore Power: flat 1% at every tier.
  ('uob_one', 'category_rate',  '{bills}', 600, 0.01, null, null, null, 10, '2025-07-01',
   'Singapore Power (SP) only, 1% at every tier including Tier 1.'),

  -- Ceiling on ALL additional cashback (groceries + selected merchants + Shell + SP) combined.
  ('uob_one', 'cap',            null, null,   null,   120,  null, null, 0,  '2025-07-01',
   'Additional cashback cap per statement month, RAISED from S$100 (was pre-22 Sep 2025). Quarterly cashback (the S$60/100/200 tier payout) sits outside this cap.'),

  -- ============ CITI CASH BACK ============
  -- Confirmed accurate against official Citibank pages, no corrections needed
  -- beyond removing the travel-insurance benefit (discontinued 31 Mar 2026).
  -- Card not yet issued: rows staged, activate on issue date.

  ('citi_cashback', 'min_spend',     null, 800,  null, null, null, null, 100, '2099-01-01',
   'STAGED. Below S$800/statement month everything drops to 0.2% base. Excludes bill payments (incl. Citi PayAll), education, government/tax/fines, insurance, SimplyGo transit, and more — see full exclusion list — from BOTH the cashback and this minimum.'),
  ('citi_cashback', 'category_rate', '{petrol,commute}',    null, 0.08,  null, null, null, 30, '2099-01-01',
   'STAGED. 8% = 0.2% base + 7.8% bonus. Petrol MCC 5541/5542. Commute = taxi/private-hire only (Grab, Gojek, ComfortDelGro, TADA, RYDE etc.), MCC 4121 — excludes SimplyGo/transit.'),
  ('citi_cashback', 'category_rate', '{dining,groceries}',  null, 0.06,  null, null, null, 20, '2099-01-01',
   'STAGED. 6% = 0.2% base + 5.8% bonus. Dining MCC 5811/5812/5814 — hotel restaurants (7011) and bars (5813) excluded. Groceries MCC 5411.'),
  ('citi_cashback', 'category_rate', null,                  null, 0.002, null, null, null, 0,  '2099-01-01',
   'STAGED. Base rate, all other retail, and everything once the S$80 cap is hit.'),
  ('citi_cashback', 'cap',           null, null, null, 80,   null, null, 0,  '2099-01-01',
   'STAGED. Combined across all bonus categories per statement month. Credits in S$10 multiples, only once accrual reaches S$50 — model as a distinct accrued-but-uncredited state.'),

  -- ============ HSBC REVOLUTION ============
  -- Restructured 1 April 2026: 4 mpd made permanent, cap reverted to
  -- S$1,000 (was S$1,500 during the Jul 2025-Mar 2026 promo), new 8 mpd
  -- tier added. Calendar months. Rate stored as mpd (10X points), not a
  -- percentage — 10 reward points per S$1, redeemable at 2.5:1 to best
  -- partners = 4 mpd effective.

  ('hsbc_revo', 'category_rate', '{dining,retail,online,commute}', null, 4.0, null, null, null, 20, '2026-04-01',
   'Standard tier, PERMANENT (not promo). 10X points. Travel qualifies via online OR contactless; dining/shopping/transport/memberships require CONTACTLESS ONLY — chip/PIN does not earn this rate. Excludes groceries generally, MCC 4722 travel agencies, MCC 5814 fast food/delivery, MCC 4111 transit, petrol.'),
  ('hsbc_revo', 'category_rate', '{dining,retail,online,commute}', null, 8.0, null, null, null, 25, '2026-04-01',
   'Enhanced tier. Requires >=S$50,000 average daily balance in a SOLE (not joint) SGD HSBC Everyday Global Account, reassessed monthly. 20X points. Same category and contactless rules as standard tier.'),
  ('hsbc_revo', 'category_rate', null, null, 0.4, null, null, null, 0, '2026-04-01',
   'Base rate, 1X points. Applies to groceries, petrol, MCC 4111 transport, MCC 4722 travel agencies, MCC 5814 fast food, and any bonus-category spend not made contactless/online.'),
  ('hsbc_revo', 'cap',           null, null, null, 1000, null, null, 0, '2026-04-01',
   'Standard tier cap: first S$1,000 of eligible spend per CALENDAR month. Spend beyond earns base rate.'),
  ('hsbc_revo', 'cap',           null, null, null, 1200, null, null, 5, '2026-04-01',
   'Enhanced (8 mpd / EGA) tier cap: first S$1,200 per CALENDAR month. Use this cap instead of the S$1,000 row when the EGA balance condition is met that month.');

-- PayLah: no rules. has_rules = false. Budget participation only.

-- ============ MERCHANT SEEDS ============
-- A handful of generic, well-known merchants to seed the table with.
-- Everything else starts as 'guessed'.

insert into merchants (match_pattern, display_name, category, hsbc_eligible, is_transfer, confidence) values
  ('TIKTOK SHOP',  'TikTok Shop',   'online',  true,  false, 'guessed'),
  ('CHRONO24',     'Chrono24',      'retail',  true,  false, 'guessed');
```

### Rules that do not fit the table and must live in engine code

- **UOB's quarterly gate.** All three statement months must independently clear their tier and the 10-transaction minimum. A single failure zeroes the quarter (T&C clause 3.2). Not expressible as a row.
- **UOB's first-quarter proration.** New cardholders get one-third or two-thirds of the tier payout if the threshold is only met in the second or third statement month of their very first quarter. Only relevant while `uob_one` is inside its first quarter post-issuance.
- **Citi's crediting mechanic.** Accrual in S$10 multiples, no credit until S$50. Accrued-but-uncredited is a distinct state the dashboard must show separately.
- **HSBC's payment-method condition.** The bonus rate (4 mpd or 8 mpd) requires contactless or online for every category except travel, which also accepts a plain online booking. A chip-and-PIN dining transaction earns the base rate despite matching the category. Alerts do not indicate payment method, so this is **unknowable from alert data** — assume bonus, correct at reconciliation, and label the miles figure as an estimate.
- **HSBC's EGA balance condition.** Whether the 8 mpd tier applies depends on a bank balance the ingest pipeline has no access to. Default to the standard S$1,000/4 mpd cap unless the operator manually flags EGA eligibility for that month.
- **HSBC transfer ratio is partner-dependent, not a single number.** Store the point balance (10X or 20X per dollar) as the source of truth; apply 3:1 for KrisFlyer, 2.5:1 for Avios/Asia Miles/Flying Blue/EVA, and look up others rather than assuming a flat 4 mpd converts everywhere.

---

## 6. The MCC problem — read this before building the classifier

Alert emails give a merchant string. Statements usually omit MCC too. But **MCC is what actually determines eligibility**, and it is the single biggest source of error in this system.

Known traps to encode in `merchants`:

- HSBC Revolution bonus categories: dining, shopping, travel, ride-hailing, taxis, memberships. **Groceries are not included.** Tapping a phone at NTUC earns the base rate, not 4 mpd.
- MCC 5814 (fast food) is excluded from HSBC Revolution and catches food delivery platforms and some ordinary cafes that code unexpectedly.
- MCC 4111 (SimplyGo, public transport) gets no HSBC contactless bonus, but is a UOB selected merchant earning 5%–6.67%.
- MCC 4722 (travel agencies — Agoda, Expedia, Klook, Trip.com) earns nothing on HSBC. Direct airline and hotel bookings do.
- Citi excludes bill payments, education, and government or tax transactions from both the cashback **and** the S$800 minimum spend calculation.

**Design rule:** `hsbc_eligible` starts null. Never assume. When a statement later reveals the real earn rate, backfill and set `confidence = 'confirmed'`. Expect roughly two months before the recurring merchant set is stable.

---

## 7. Jobs

### Gmail auth — read this first, it will break everything if missed

Without n8n managing OAuth, we handle the token exchange ourselves.

**The trap: if the Google Cloud OAuth consent screen is left in "Testing" publishing status, refresh tokens expire after 7 days.** The pipeline works all week, then dies silently every Sunday. Publish the app to "In production". It stays unverified, which is fine for a single-user app requesting `gmail.readonly` — accept the unverified-app warning once during consent.

Flow:
1. One-time local consent with `access_type=offline&prompt=consent`, capture the refresh token
2. Store refresh token in **Supabase Vault**, never in an env var or repo
3. Each run: POST to `oauth2.googleapis.com/token` with the refresh token, get a 1-hour access token, hold it in memory only
4. Scope: `https://www.googleapis.com/auth/gmail.readonly` and nothing more

### Watermark pattern (all ingest jobs)

```sql
create table ingest_state (
  stream     text primary key,        -- 'alerts','statements'
  watermark  bigint not null,         -- Gmail internalDate, epoch ms
  updated_at timestamptz default now()
);
```

Query Gmail with `after:{watermark}`, advance only after a successful insert. Self-healing: any outage is caught by the next run. Backfillable: move the watermark back and re-run, duplicates rejected by the `(method_id, source, source_ref)` unique constraint.

---

### JOB-1 · `ingest-alerts` — Edge Function, Cron every 2 min

Gmail account: **you@example.com**, a dedicated notification-only mailbox.

**Scope note:** Gmail OAuth cannot be scoped to a label. `gmail.readonly` grants read access to the whole mailbox. The separate account is the scope control, not the label. Keep that mailbox free of personal correspondence.

- Read watermark → Gmail API `users.messages.list` with `label:Payments after:{watermark}`
- **Route by label, not by parsing the issuer from the body.** `Payments/UOB` → `uob_one`, `Payments/Citi` → `citi_cashback`, `Payments/HSBC` → `hsbc_revo`, `Payments/PayLah` → `paylah`. More robust than text matching and it makes a silent source obvious.
- Cap at 20 messages per invocation
- Body → Anthropic API → strict JSON `{amount, currency, merchant_raw, txn_date, is_transfer_hint}`
- Normalise merchant, lookup `merchants`, insert as `provisional`, set both calendar month and card `period_key`
- On parse failure: write raw to `parse_failures`, **do not advance the watermark past it**, notify. Never drop silently.

Auth: Cron invokes the function via `pg_net` with a bearer token from Vault. Note that the pg_cron-to-Edge-Function auth pattern is a known documentation gap post-JWT-key migration — resolve the current recommended approach at build time rather than copying an older community example using `pgjwt` or `pgsodium`, both of which are deprecated.

### JOB-2 · `ingest-statements` — GitHub Actions, daily 09:00 SGT

- Runner installs `qpdf` and Python deps
- Gmail API search for statement senders with attachments, or Drive fallback
- Decrypt PDF (password pattern from GitHub Secrets)
- Extract text → Anthropic API → JSON array
- Insert as `confirmed`, source `statement`
- Decrypted file never written outside the ephemeral runner. Runner is destroyed on completion.

### JOB-3 · `reconcile` — GitHub Actions, runs immediately after JOB-2

- Match provisional → confirmed on `(method_id, amount ±2%, txn_date ±3 days, merchant fuzzy)`
- Matched: mark reconciled, confirmed amount becomes truth
- Unmatched provisional older than 45 days: mark `reversed` (likely dropped pre-auth)
- Unmatched confirmed: an alert we missed. Log it. **Miss rate above 5% means the alert threshold is not low enough** — that is the health metric that matters most.

### JOB-4 · `nudge` — Edge Function, Cron daily 20:00 SGT

Push to Telegram **only if actionable**. Silent when on track — a nightly notification is a notification nobody reads.

**Lead with budget, then cards.** That ordering reflects the goal hierarchy: the budget is the point, the card optimisation is the bonus.

```
Sept · day 18 of 30

Spend      S$1,890 of S$2,600 budget
Over       Dining S$412 / S$350   !
Watch      Groceries S$690 / S$800

UOB One    S$1,340 / S$2,000 · 7 of 10 txns · 9 days left
           Short S$660. Tier 3 = S$200/quarter.
Citi       S$62 / S$80 cap · minimum cleared
HSBC       S$610 / S$1,000
PayLah     S$228 this month
```

Escalate in the last 5 days of a card period. Escalate hard if a UOB quarter is at risk, since one missed month forfeits roughly S$312.

### JOB-5 · `merchant-triage` — Edge Function, Cron Sunday 10:00 SGT

- List merchants with `confidence = 'guessed'` seen 2+ times
- Telegram with inline category buttons, one tap to confirm; include a "transfer, not spend" button for PayLah recipients
- Keeps classification debt from accumulating

### JOB-6 · `heartbeat` — Edge Function, Cron hourly

**Supabase Cron has no failure alerting and no heartbeat.** Skipped runs are not retried, a run is dropped if the previous one still holds a lock, and a paused project or incident silently stops every schedule. Since this system's only job is to not miss things, silent failure is the primary risk.

- Ping an external dead-man's-switch (healthchecks.io free tier) every hour
- If Supabase stops pinging for any reason, the external service alerts by email
- Assert per source: if any of the four labels has seen zero mail in 72 hours, warn. A single bank quietly reverting an alert threshold is the most likely real-world failure and it is invisible in an aggregate check.

---

## 8. Parser contract

The highest-risk component in the system. It runs thousands of times unattended, and a silent misparse becomes a wrong number in the budget that nobody catches.

**Model:** `claude-haiku-4-5-20251001`. This is high-volume, low-complexity extraction — Sonnet is unnecessary here and the cost difference compounds across every transaction for years.

**Temperature 0.** Deterministic extraction, not generation.

### Output schema

The model returns this and nothing else. No preamble, no markdown fences, no explanation.

```json
{
  "amount": 214.75,
  "currency": "SGD",
  "merchant_raw": "Riverside Home Store",
  "last4": "2222",
  "txn_date": "2026-07-12",
  "txn_time": "18:40:52",
  "txn_type": "purchase",
  "confidence": "high"
}
```

| Field | Rule |
|---|---|
| `amount` | Number, never a string. No currency symbols or thousands separators. |
| `currency` | ISO 4217. **Never convert.** UOB reports foreign amounts; record `USD`, do not guess SGD. |
| `merchant_raw` | Verbatim from the email. Normalisation happens downstream, not here. |
| `last4` | Digits only. `null` if absent — never infer from context. |
| `txn_date` | ISO 8601. UOB is DD/MM/YY. PayLah has no year: use the year of the email's `internalDate`, and if that produces a future date, subtract one year. |
| `txn_type` | `purchase` \| `transfer` \| `topup` \| `refund` \| `unknown`. PayLah "Scan & Pay" is `purchase`. P2P sends are `transfer`. |
| `confidence` | `high` \| `low`. `low` for anything ambiguous or partially matched. |

### System prompt

```
You extract structured transaction data from Singapore bank alert emails.

Return ONLY a single JSON object matching the schema. No markdown fences,
no preamble, no explanation.

Rules:
- Never convert currency. Record the currency and amount exactly as stated.
- Never infer a value that is not present. Use null.
- Never guess the card. If no last-4 digits appear, last4 is null.
- Ambiguous dates: DD/MM/YY unless the day is unambiguously above 12.
- Set confidence to "low" if any field required guessing.

If the email is not a transaction alert (marketing, statement notice,
security notice), return {"txn_type": "not_a_transaction"}.
```

The last rule matters: filters catch by sender, and banks send marketing and statement notices from the same address.

### Validation before insert

Reject and route to `parse_failures` if any of:
- JSON does not parse, or fails schema validation
- `amount` is absent, non-numeric, zero or negative
- `txn_date` is in the future, or more than 90 days past
- `last4` is present but matches no active `payment_methods` row
- `confidence` is `low`

**Never insert an unvalidated row.** A wrong transaction is worse than a missing one — a gap is visible at reconciliation, a wrong amount silently corrupts the budget.

### Failure handling

```sql
create table parse_failures (
  id           bigserial primary key,
  source_ref   text unique not null,      -- Gmail message id
  raw_body     text not null,
  model_output text,
  reason       text not null,
  resolved     boolean default false,
  created_at   timestamptz default now()
);
```

- **Do not advance the watermark past a failure.** Leave it so the next run retries; the unique constraint makes retries free.
- Retry twice with exponential backoff on API errors (429, 5xx). Do not retry on validation failures — the same input yields the same output.
- If `parse_failures` gains 3 unresolved rows in 24 hours, alert via Telegram. A bank has probably changed its email format, and every subsequent transaction is being lost.

### Cost sanity check

At roughly 100 transactions a month with short emails, this is a rounding error on Haiku. If the Anthropic bill is ever material, something is looping — check for a watermark that is not advancing.

### Testing

Commit the three confirmed samples from Section 4 (Confirmed alert formats) as fixtures under `tests/fixtures/`. Every parser change runs against them. Add each new bank format as a fixture when first encountered, and add every `parse_failures` row as a regression case once fixed.

---

## 9. Rules engine

**Deterministic SQL or a Postgres function. No LLM in this path.** The model may parse and classify; it must never decide whether a threshold was met.

Evaluation order per card per period:
1. Resolve period key from transaction date and card `period_type`
2. Sum confirmed + provisional spend, count transactions
3. Match applicable `method_rules` where date falls in `valid_from`/`valid_to`
4. Apply tiers highest-first, then category rates in `priority` order, decrementing the cap
5. Return: `{spend, txn_count, tier_hit, reward_accrued, cap_remaining, gap_to_next, days_left, at_risk}`

Also model Citi's crediting quirk: cashback credits in S$10 blocks and only once accrual reaches S$50. Accrued-but-uncredited is a real state and the dashboard should show it separately.

---

## 10. Dashboard

Tertiary in priority but it is the deliverable that makes the consolidation visible, so it is no longer an afterthought phase.

**Views, in order of value:**

1. **This month.** Total spend against total budget, days elapsed against days remaining, projected month-end. Category bars against their caps.
2. **Over time.** Rolling 12-month total spend. Per-category trend lines. Which categories are drifting up.
3. **Where it went.** Category breakdown for the selected period, merchant leaderboard, payment method split. The view no bank app can produce.
4. **Card optimisation.** Per-card period progress against tiers, caps and transaction counts. Rewards earned versus rewards available. Historical hit rate per quarter.
5. **The Tier 3 record.** Month-over-month spend with the S$2,000 line marked, plus the lowest month in the window. This is the evidence for whether committing to UOB Tier 3 is safe.

Supabase plus a small Next.js app, or Metabase on Supabase if speed matters more than polish. Read-only, publishable key with RLS, no writes from the dashboard.

### Deployment: Next.js on Vercel

**Stack:** Next.js (App Router, TypeScript), deployed on Vercel from the `flowink` repo, on a custom domain.

**Repo location:** `dashboard/` at the repo root. Set Vercel's Root Directory to `dashboard` so it ignores `supabase/` and `.github/`.

**Setup:**
1. Import the `flowink` repo into Vercel
2. Root Directory `dashboard`, framework preset Next.js
3. Function region **`sin1` (Singapore)** to sit next to `ap-southeast-1`. The default is US East, which adds a pointless round trip to every query.
4. Add the custom domain in Vercel, point DNS as instructed
5. Auto-deploy on push to `main`; preview deploys on branches

**Environment variables (Vercel project settings):**
```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
```

**That is the complete list.** The service role key, the Anthropic key and the Gmail credentials must never appear in the dashboard project, under any name. Anything prefixed `NEXT_PUBLIC_` is compiled into the browser bundle and readable by anyone who opens devtools — and even without the prefix, a frontend runtime is the wrong place for a key that bypasses RLS.

### The security question this raises

**A public URL now points at your complete financial history.** The domain is guessable, indexable, and reachable by anyone. The publishable key is designed to be public and is not a secret.

**RLS is the only thing standing between the internet and your data.** Not the key, not the domain obscurity, not Vercel.

Required:
- **Supabase Auth on every page.** Email magic link or Google OAuth, restricted to a single allowed user. Next.js middleware redirects unauthenticated requests to sign-in.
- **RLS policies keyed to `auth.uid()`**, default-deny. Verify by querying the REST endpoint with the publishable key and no session — it must return empty, not data. Test this explicitly before pointing the domain at it.
- **`robots.txt` disallow all**, plus `X-Robots-Tag: noindex` in `next.config.js` headers.
- **Read-only.** No mutations from the dashboard. Corrections go through the Telegram triage bot, which runs server-side.

The middleware redirect is UX, not security. Someone can always hit the Supabase REST endpoint directly and skip the frontend entirely. If RLS is wrong, the middleware will not save you.

### AMENDMENT (2026-08-25) — the dashboard is an input surface, not read-only

The original design above states the dashboard is read-only and that corrections go
through the Telegram bot. **That is superseded.** Operator decision: the web app must
accept input, for two reasons the read-only design cannot serve.

**1. Budget planning.** Budgets are set and revised in the dashboard, by category and by
period. They are not seeded in a migration and not hardcoded. Planning is an interactive
activity — comparing a proposed cap against the last six months of actuals — and that
belongs in the same view as the trend data, not in a SQL file.

**2. Non-card spending.** §14 lists "Cash is invisible" as a real gap in the primary goal
and proposes a Telegram entry path. The operator wants it in the web app instead: any
spending with no card behind it — cash, bank transfer, GIRO from a non-DBS account,
anything the ingest pipeline structurally cannot see — is entered by hand.

**The schema already supports this.** `txn_source` includes `'manual'`, and the
idempotency constraint is deliberately written `check (source = 'manual' or source_ref is
not null)` so manual rows need no source reference. No migration is required for the data
model; what changes is the security model.

**Security consequences — these replace §11's "Read-only. No mutations from the dashboard":**

- RLS write policies are required on exactly two tables: `budgets` (full CRUD) and
  `transactions` (INSERT, and UPDATE/DELETE restricted to `source = 'manual'` rows only).
  Every other table stays default-deny, and ingested rows must not be editable from the
  browser — a bug or a hostile session must not be able to rewrite bank-sourced history.
- Policies must be pinned to the single operator's `auth.uid()`, never
  `auth.uid() is not null` and never `auth.role() = 'authenticated'`. Supabase's
  `/auth/v1/signup` endpoint is public and reachable with the publishable key, so a
  permissive policy means any stranger can self-register and gain write access.
  **Disabling public signup is mandatory, not optional, once writes exist.**
- The write path raises the cost of an RLS mistake. Previously a misconfiguration leaked
  data; now it also permits an attacker to corrupt the ledger. Verification before DNS
  cutover must test writes as well as reads: an unauthenticated POST and an
  authenticated-as-a-freshly-signed-up-stranger POST must both fail.
- `service_role` still never appears in the dashboard project. Browser writes go through
  the publishable key under RLS, exactly like reads.

Phase 5 is therefore a security-design task, not only a UI task.

### Cost

Vercel Hobby is free and sufficient for a single user. Its terms prohibit commercial use — a personal finance dashboard is personal, so this is fine, but it would need to change if this were ever offered as a commercial, multi-tenant product.

### Fourth runtime, fourth secret store

Vercel joins Edge Functions, GitHub Actions and Postgres. Same rule: each reads only its own store. Unlike the other three, Vercel's holds **no secrets at all** — only the two public values above. If you find yourself adding a third variable there, stop and work out why.

### STATUS UPDATE (2026-08-28) — built, then visually redesigned

All 5 views above (plus both AMENDMENT input surfaces) shipped 2026-08-26. The
home view was rebuilt again 2026-08-27 into a single-page "Command Center"
with anchor-navigated sections (Trends, Ledger) instead of separate routes —
visual only; budget planning, manual entry, and triage were explicitly out of
scope for that pass and are unchanged. `docs/SETUP_STATUS.md` is the file to
trust for current live state — this spec is the durable architecture record,
not a live status page.

---

## 11. Security

### Hosting decision: Supabase Cloud, not self-hosted

Supabase is SOC 2 Type 2 compliant and ISO 27001 certified, with the same compliance controls applied to every project regardless of plan. Data is AES-256 encrypted at rest and TLS in transit, and a project created in an AWS region keeps its Postgres database and storage in that region.

**Region: ap-southeast-1 (Singapore).** Data stays local and latency is negligible from both Edge Functions and GitHub runners.

Self-hosting would mean owning Postgres patching, firewall rules, disk encryption, backup verification and intrusion detection. Managed is the more secure option here, not the less secure one.

**Plan: Pro (~US$25/mo).** Not for security — RLS behaves identically on Free. Two operational reasons: free projects pause after one week of inactivity, which would silently kill ingest mid-quarter, and free has no backups. For a system whose only job is not missing a threshold, that is cheap insurance.

### The design principle that matters most

**Make a breach embarrassing rather than costly.** With card numbers redacted at parse time, the database holds merchant names and amounts. No PANs, no credentials, no ability to move money. An attacker learns where the operator buys groceries. Design to that standard and every other control is a second line rather than the only line.

### Controls (all of these are our responsibility, not Supabase's)

- **Read-only throughout.** No bank credentials anywhere in the system. No portal scraping.

  **The line:** fetching from Gmail is fine — the operator's own mail, the operator's own API, OAuth readonly. Scraping a bank portal is not. It requires internet banking credentials, likely breaches the bank's terms, and shifts fraud liability onto the operator. If a data gap tempts a scraper, fix the alert threshold instead.
- **Gmail OAuth scoped to readonly.**
- **Redact card numbers at parse time.** Store last 4 only, never the PAN. Never store then hide.
- **Service role key** lives in Supabase Vault and GitHub Secrets only. Never in a repo, never in an Edge Function env that gets logged. It bypasses RLS entirely and is the single most likely cause of compromise.
- **Gmail refresh token in Supabase Vault**, never in GitHub Secrets or an env file. Scope `gmail.readonly` only.
- **Private repo (`flowink`).** GitHub Actions logs are retained and readable by anyone with repo access — never `echo` a secret or a decrypted statement line.
- **Four runtimes, four secret stores.** `supabase secrets set` for Edge Functions, GitHub repo Secrets for Actions, Supabase Vault for Postgres, Vercel env vars for the dashboard. Each reads only its own; duplication across them is correct, not a smell. **Vercel holds no secrets** — only the Supabase URL and publishable key, both public by design.
- **The dashboard is internet-facing.** RLS keyed to `auth.uid()` is the only real control. Verify by hitting the REST endpoint with the publishable key and no session; it must return empty. Do this before pointing the domain at it.
- **RLS enabled and default-deny on every table**, added at schema creation, not retrofitted. Run the Supabase security linter before considering Phase 1 done.
- **PostgREST grants.** Projects created after 30 May 2026 require explicit Postgres grants for Data API access; existing free projects are affected from 30 October 2026. Confirm which rule applies and grant deliberately rather than discovering it when a query fails.
- **MFA on the Supabase account and the Google account.** The Google account is the higher-value target — it holds the statements.
- **Statement PDFs never persist.** Decryption happens in the ephemeral GitHub Actions runner, which is destroyed on completion. Drive is the archive, encrypted originals only.
- **Spend cap on** in Supabase billing.

### Regulatory

PDPA does not apply — it excludes data used purely for personal or domestic purposes, and this is the operator's own data about themselves.

**If this is ever productised commercially for clients, that changes entirely**: consent collection, retention policy, breach notification within the PDPC window, and a DPA with Supabase. Treat any multi-tenant version as a separate build with a separate threat model, not an extension of this one.

Nothing in this design breaches bank terms. It reads the operator's own email and the operator's own documents.

---

## 12. Build order

**Repo: `flowink`, private, on GitHub.** GitHub is not just version control here — Actions is one of the three runtimes, so the repo is load-bearing infrastructure. Full layout in Phase 0A below.

### Phase 0 — initialisation

**Status at handoff:** Gmail `Payments/*` labels and filters created and applied to existing mail. Alert senders confirmed for three sources. Google Cloud project created, Gmail API enabled, OAuth consent screen published to Production, refresh token captured locally at `~/cardledger-auth/`.

---

#### 0A(i) · Claude Code, no local machine needed

Everything here is code and config. Runs from Claude Code on mobile against the repo.

- [ ] All repo creation, scaffolding, `.gitignore`, README
- [ ] All migrations in `supabase/migrations` including the Section 5 seed data
- [ ] All Edge Function code, Actions workflow YAML, `verify_token.py`
- [ ] `tests/fixtures/` from the three confirmed alert samples
- [ ] Commit and push

#### 0A(ii) · Claude Code, requires the local machine

Blocked until laptop access. These touch local files or CLI sessions authenticated as the operator.

- [ ] Read `~/cardledger-auth/client_secret.json`, extract `client_id` and `client_secret`
- [ ] `supabase login`, `gh auth login`
- [ ] Create the Supabase project, run migrations, set Edge Function secrets
- [ ] Run `verify_token.py`
- [ ] Delete `~/cardledger-auth`

#### 0A · Full task detail

- [ ] **Create the GitHub repo.** Name `flowink`, **private**. This is the home for the whole project: Edge Functions, migrations, and the Actions workflows that run JOB-2 and JOB-3. Not optional — GitHub Actions is a runtime here, not just version control, so there is no "run it locally" fallback.
  ```
  gh repo create flowink --private --clone
  ```
- [ ] **Scaffold the repo structure:**
  ```
  flowink/
    supabase/migrations/        schema, versioned
    supabase/functions/         ingest-alerts, nudge, merchant-triage, heartbeat
    .github/workflows/          ingest-statements.yml, reconcile.yml
    dashboard/                  Next.js app, deployed to Vercel
    scripts/verify_token.py     day-8 and ad-hoc auth diagnostic
    docs/cardledger-build-spec.md   this file, committed
    .gitignore
    README.md
  ```
- [ ] **Write `.gitignore` before the first commit.** Must cover `client_secret*.json`, `*credentials*.json`, `.env`, `.env.*`, `token.json`, `venv/`, `*.pdf`. Getting this wrong once means a credential in git history permanently.
- [ ] **Set GitHub Secrets** (Settings → Secrets and variables → Actions). The Actions jobs run in a separate runtime from Edge Functions and cannot read Supabase secrets, so these must be duplicated:
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `GMAIL_REFRESH_TOKEN`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`
  - `ANTHROPIC_API_KEY`
  - `STATEMENT_PDF_PASSWORD`

  **Three runtimes, three secret stores.** Edge Functions use `supabase secrets set`. GitHub Actions uses repo Secrets. Postgres uses Vault, for the bearer token `pg_cron` needs to invoke a function through `pg_net`. Do not try to unify them; each runtime can only read its own.
- [ ] **Never `echo` a secret or a decrypted statement line in a workflow.** Actions logs persist and are readable by anyone with repo access.
- [ ] **Create the Supabase project** via the Supabase CLI or Management API. Region `ap-southeast-1`, Pro plan. Needs a Supabase access token from the dashboard.
- [ ] **Read `~/cardledger-auth/client_secret.json`** and extract `client_id` and `client_secret`. Read from the file — never have the operator paste secrets into a chat session.
- [ ] **Set Edge Function secrets** for the values the function itself consumes:
  ```
  supabase secrets set GMAIL_REFRESH_TOKEN=... GMAIL_CLIENT_ID=... GMAIL_CLIENT_SECRET=...
  ```
  **Correction to note:** Edge Function runtime secrets go here, **not** in Vault. Vault is for values Postgres needs, such as the bearer token `pg_cron` uses to invoke the function through `pg_net`. Putting Gmail credentials in Vault forces the function into a round trip it does not need.
- [ ] **Write and run `verify_token.py`** — mint an access token from the refresh token, list one message from `label:Payments`, print the count. Serves as both the immediate smoke test and the day-8 check script. Commit it; it is the diagnostic for every future auth failure.
- [ ] **Delete `~/cardledger-auth`** once secrets are stored and verification passes. That refresh token grants read access to the entire mailbox and must not persist on the laptop.
- [ ] **Confirm the current pg_cron → Edge Function auth pattern** against live Supabase docs before writing invocation code. The static service_role_key approach is gone, `pgjwt` is deprecated in Postgres 17, `pgsodium` is not recommended for new use.

#### 0B · Only the operator can do these

Not automatable. They block Phase 1 acceptance.

- [ ] **Enable MFA** on the Supabase account and on you@example.com.
- [ ] **Turn on the Supabase spend cap.**
- [ ] **Test HSBC with a transaction under S$10.** Highest priority item here. HSBC's default alert threshold is S$500 and the only confirmed sample was well above that threshold, which proves nothing about small transactions. If small purchases do not alert, HSBC data is silently incomplete and every month's budget is wrong.
- [ ] **Test UOB and PayLah with small amounts** to confirm the S$0.01 and S$0 thresholds took effect. Alert preference changes can take up to 3 business days to apply.
- [ ] **Check whether UOB or HSBC exclude recurring transactions from alerts.** DBS explicitly does. If either matches, subscriptions and GIRO will not appear until statement reconciliation and the live budget understates every month by that amount. If confirmed, the nudge must label the figure "excludes recurring" rather than present it as complete.
- [ ] **Citi card issuance.** Once approved: capture a real alert sample, add the sender to a `Payments/Citi` filter, insert the `payment_methods` row with its `last4`, add the parser branch. Until then the system runs three-branch.
- [ ] **Day-8 token check on 2 September.** Run `verify_token.py`. If it fails, the consent screen was never actually published and every downstream job will die weekly.

#### Phase 0 acceptance

A live test transaction on each active source lands under the correct nested label within 5 minutes, `verify_token.py` succeeds on day 1 **and** day 8, and no credential files remain outside Supabase.

---

**Phase 1 — prove the ingest works**
Schema with RLS default-deny, JOB-1, JOB-6, manual merchant table. Acceptance: all active sources ingest with the right `method_id` resolved from `last4`, PayLah transfers flagged and excluded from spend, foreign-currency transactions stored uncosted rather than guessed, security linter clean, heartbeat visible in healthchecks.io.

**Phase 2 — budgets and analysis (primary goal)**
Calendar-month aggregation, `budgets` table, category rollups, month-over-month queries. JOB-4 nudge with budget leading. Acceptance: month-to-date total and per-category spend match a hand-checked figure across all four sources.

**Phase 3 — card optimisation (secondary goal)**
`method_rules` engine as Postgres functions, dual period model, card section of the nudge. Acceptance: tier state, transaction count and cap remaining match a hand-checked figure on a real statement month.

**Phase 4 — reconciliation**
JOB-2, JOB-3, JOB-5. Acceptance: a full statement reconciles with under 5% unmatched.

**Phase 5 — dashboard**
Next.js in `dashboard/`, deployed to Vercel on the custom domain, region `sin1`. Acceptance: Supabase Auth gates every page, an unauthenticated REST query against the publishable key returns empty, `noindex` headers present, and the five views in Section 10 render against real data.

Do not start Phase 2 before Phase 1 has run for a full week. Alert coverage gaps are the biggest unknown and only surface with real traffic.

---

## 13. Resolve before writing code

1. **Set alert thresholds to the minimum on all four sources.** UOB offers S$0.01. PayLah accepts S$0 for outgoing payments. HSBC defaults to S$500 and is customisable. Citi is configured in Citibank Online. This is the single dependency the whole system rests on.
2. ~~Confirm what each alert email contains.~~ **Done for HSBC, UOB and PayLah** — all three carry merchant, amount and last 4. See Confirmed alert formats. Still needed for Citi once the card is issued.
3. **Check whether any bank excludes recurring transactions from alerts.** DBS explicitly does. If UOB, Citi or HSBC do the same, subscriptions and GIRO will only appear at statement reconciliation, and the live budget will understate.
4. ~~Capture the exact sender addresses.~~ **Done for three:** `HSBC.Bank.Singapore.Limited@notification.hsbc.com.hk`, `unialerts@uobgroup.com`, `paylah.alert@dbs.com`. Citi pending card issuance.
5. **Confirm whether statement emails carry a PDF attachment** or just a "log in to view" link. If the latter, JOB-2 becomes a manual monthly drop into Drive and the Actions job watches Drive instead.
6. **Find the UOB One and Citi statement close days** — set by card approval date, they determine every card period boundary and the UOB quarter cycle.
7. ~~Verify current rates before loading `method_rules`.~~ **Done for UOB One and Citi Cash Back**, cross-checked against official T&Cs — see Section 5 seed data and the linked research report. **HSBC Revolution corrected for the 1 Apr 2026 restructuring.** Re-verify against a live statement regardless before production; rates change without notice and the research is a point-in-time snapshot.
8. **Create the Supabase project in ap-southeast-1 on Pro**, enable MFA, turn on the spend cap, confirm whether the PostgREST explicit-grants rule applies to a project created now.
9. **Confirm the current recommended pg_cron → Edge Function auth pattern.** The old static service_role_key approach is gone, `pgjwt` is deprecated in Postgres 17, and `pgsodium` is not recommended for new use. Check current Supabase docs rather than following a community example.

---

## 14. Known limitations

- **Foreign currency spend is unquantified until statement.** UOB alerts report the foreign amount only. Overseas and USD transactions sit in the ledger uncosted for up to five weeks, so the live budget understates by the SGD value of that spend plus the 3.25% FX fee.
- **Cash is invisible.** With total expense tracking as the primary goal, this is now a real gap rather than a footnote. A manual entry path via the Telegram bot is needed if cash is material.
- Recurring and card-on-file transactions may not alert at some banks. Reconciliation catches these a month later, but the live budget understates until then.
- MCC is inferred, not authoritative. Category accuracy will be roughly 90% until the merchant table matures.
- PayLah P2P transfers are only correctly excluded once the recipient is classified. Early months will overstate spend until triage catches up.
- Threshold state includes provisional rows, so a reversed pre-auth can briefly overstate progress. Acceptable — it errs toward spending more, not less.
- Bank transfers, GIRO from non-DBS accounts, and any card not in `payment_methods` are out of scope and will make the budget incomplete by that amount.
