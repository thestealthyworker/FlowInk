-- WP1: the generic rules engine. See design/rules-engine.md (in the
-- project's planning scratch space, not shipped in this repo) for the
-- full design rationale. Source studied in full before writing this file:
-- 0007_rules_engine.sql, 0001_schema.sql, 0002_seed.sql,
-- 0008_dashboard_rls.sql.
--
-- WHAT THIS MIGRATION DOES
--   1. Extends method_rules / payment_methods with the columns the
--      generic evaluator needs (§2 of the design), and a new
--      method_conditions table generalising hsbc_ega_months.
--   2. Backfills those columns for the three existing cards so the new
--      evaluator reproduces the old three hand-written functions' output.
--   3. Creates evaluate_period() and evaluate_period_group() — one
--      generic evaluator replacing uob_month_status / hsbc_month_status /
--      citi_month_status / uob_quarter_status.
--   4. Creates diff_evaluator_output(), a standalone, callable
--      differential-testing artifact (not inline test-script logic) that
--      compares the OLD dispatcher's output against the NEW evaluator's
--      output for one (method_id, period_key) and reports a structured,
--      field-by-field diff.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--   - It does NOT edit 0007_rules_engine.sql. uob_month_status,
--     uob_quarter_status, hsbc_month_status, citi_month_status,
--     hsbc_ega_active, hsbc_ega_months all stay exactly as they are —
--     alive, granted, callable — for one release cycle as a rollback path
--     and as the correctness oracle diff_evaluator_output compares
--     against.
--   - It does NOT repoint card_period_status() to the new evaluator.
--     card_period_status still dispatches to the old per-card functions,
--     completely unchanged from 0007. That switch is a follow-up
--     migration, gated on QA reviewing diff_evaluator_output's output
--     across a real range of periods — see the differential-testing
--     driver run alongside this migration for that review.
--   - It does NOT drop hsbc_ega_months, even though method_conditions
--     generalises it and this migration copies its data forward. Same
--     one-release-cycle retirement window as the functions above.
--
-- ONE DEPARTURE FROM design/rules-engine.md §2, FOUND BY RUNNING THE
-- DIFFERENTIAL HARNESS AGAINST A REAL DATABASE, NOT BY READING THE CODE
-- ------------------------------------------------------------------
-- §2 (and this migration's own first draft) proposed renaming
-- method_rules.requires_ega -> condition_key and payment_methods.
-- quarter_anchor_date -> aggregation_anchor_date "in place". Both renames
-- silently pass migration-apply time and then break hsbc_month_status /
-- uob_quarter_status (0007) the first time either is actually CALLED
-- afterward, because both hardcode the old column name literally in their
-- own SQL — a plpgsql function's embedded SQL resolves column names at
-- execution time, not creation time. That is precisely the oracle this
-- migration exists to keep alive. Fixed here by making both new columns
-- ADDITIVE (new column + backfill + a check constraint holding it in sync
-- with the untouched original) instead of a rename — see the header
-- comments directly above each `alter table ... add column` below for the
-- full explanation at its point of use.
--
-- A SECOND, MORE CONSEQUENTIAL DEPARTURE — NOT BIT-FOR-BIT, DELIBERATELY,
-- ON THE ANCHOR-ALIGNED QUARTER PATH ONLY
-- ------------------------------------------------------------------
-- This migration's fidelity claim is qualified, not blanket. There are
-- two branches inside evaluate_period_group()'s window resolution
-- (mirroring uob_quarter_status's own v_anchor is null / is not null
-- split, 0007 lines 594-603):
--
--   - anchor NULL (the trailing-window fallback, grouping =
--     'anchor_unknown_trailing_window'): bit-for-bit identical to 0007 —
--     this is the only path any production data has ever exercised,
--     because quarter_anchor_date has been NULL for uob_one in every
--     environment to date.
--   - anchor NOT NULL (grouping = 'anchor_aligned'): deliberately NOT
--     bit-for-bit. uob_quarter_status (0007 line 598) advances the
--     window start by ONE MONTH per elapsed group —
--     `date_trunc('month', v_anchor) + floor(v_months_diff / 3.0)::int *
--     interval '1 month'` — instead of by the window's full width. That
--     is a stride bug: it only produces the right answer for the first
--     quarter after the anchor, then walks the window start forward at a
--     third of the correct rate every quarter after that, so members
--     silently drift out of alignment with the anchor quarter boundaries
--     the whole feature exists to respect. This evaluator instead
--     advances by the full window width (`... * v_window * interval '1
--     month'`) — the corrected, actually-quarterly arithmetic.
--
-- Concrete, verified example (aggregation_anchor_date = '2026-02-01',
-- run directly against both functions before this fix): for target
-- uob_one:2026-05, 0007 groups months [2026-03, 2026-04, 2026-05] while
-- this evaluator groups [2026-05, 2026-06, 2026-07]; for target
-- uob_one:2026-08, 0007 groups [2026-04, 2026-05, 2026-06] while this
-- evaluator groups [2026-08, 2026-09, 2026-10] — and for that second
-- target the divergence flips the downstream `forfeited` verdict itself
-- (0007: forfeited = true; this evaluator: forfeited = false), i.e. a
-- real payout being wrongly written off versus correctly recognised,
-- depending on which engine answered. Reproduce with
-- `diff_evaluator_output('uob_one', 'uob_one:2026-08')` after setting
-- aggregation_anchor_date — see WP1's differential-run artifacts for the
-- full anchor-set output.
--
-- This has been dormant in production because quarter_anchor_date is
-- NULL for every seeded card, so evaluate_period_group() has only ever
-- run the (genuinely bit-for-bit) trailing-window branch. The moment
-- anything sets that column, the two engines will answer differently
-- for real, and correctly so on the NEW side — do NOT "fix" this
-- evaluator to reproduce 0007's stride bug. See the comment directly on
-- v_window_start's anchor-aligned assignment in evaluate_period_group()
-- below, and the warning on payment_methods.aggregation_anchor_date
-- (and quarter_anchor_date), for the same note at point of use.
--
-- COLUMNS BEYOND THE DESIGN DOC'S §2 LIST — flagged prominently,
-- not silently added (originally three; now two this migration itself
-- adds, plus payment_methods.currency which 0014 got to first — see
-- that bullet below)
-- ------------------------------------------------------------------
-- design/rules-engine.md §2 lists the method_rules/payment_methods column
-- additions needed for the primitives it enumerates, but its own §3.1
-- self-describing output contract needs three more pieces of data that
-- have nowhere to live in that list, and the whole point of a *generic*
-- evaluator is that it must not hardcode a per-card string to fill the
-- gap:
--
--   - payment_methods.reward_unit (text). Every existing function
--     hardcodes its own reward_unit literal — 'cashback_sgd_additional'
--     (uob_month_status line 508), 'miles_best_partner_equivalent_2.5to1'
--     (hsbc_month_status line 867), 'cashback_sgd' (citi_month_status
--     line 1058). A generic evaluator has no `if method_id = 'uob_one'`
--     branch left to hang that literal on, so it has to be data. Backfilled
--     below with the exact three strings above — same values, new home.
--   - method_rules.estimate_caveat (text, nullable). The design's own
--     §3.1 example shows `estimate_caveats: []` populated for HSBC
--     ("assumes contactless, unconfirmed until reconciliation") but never
--     says where that string comes from generically; today it exists only
--     as a comment in hsbc_month_status (0007 lines 748-753), not data.
--     Backfilled onto HSBC's two bonus-category rows only.
--   - payment_methods.currency: design §3.1's example includes
--     `"currency": "SGD"` "from payment_methods.currency" but its own §2
--     schema list never adds the column — this migration's first draft
--     added it here. By the time this migration was rebased onto the
--     current branch tip, 0014_ingestion_routing_as_data.sql (WP2, landed
--     first) had independently added the exact same column — `currency
--     text not null default 'SGD' check (currency ~ '^[A-Z]{3}$')`, for
--     the parser's own needs — so this migration does NOT re-add it
--     (Postgres would reject a duplicate `add column`); evaluate_period()
--     below simply reads the column 0014 already created. Flagged as the
--     one place this migration's own header note about "three columns
--     beyond §2" turned into two once WP2 landed on the same branch —
--     the other two (reward_unit, estimate_caveat) are still added here,
--     genuinely new.
--
-- Two more additions to the JSON *output* (not the schema) beyond the
-- literal §3.1 example, both documented at their point of use below:
-- a top-level `reward_accrued` (the raw, pre-crediting total the old
-- functions each returned, needed because §3.1's reward_tracks[] array
-- has no single total of its own — specifically the category_rate total
-- ONLY, excluding any fixed_payout tier track, exactly matching what
-- uob_month_status's own `reward_accrued` field means: UOB's quarterly
-- tier payout is a separate figure, never folded into this one, in
-- either the old function or this one — see the long comment at
-- evaluate_period()'s tier-track block below, added after the
-- differential harness caught an earlier version of this function
-- getting that wrong) and a top-level `cap` summary object (the
-- shared-cap concept collapsed to one place instead of repeated
-- per-track, needed because UOB/Citi's cap is shared across every
-- category_rate row, not owned by any single one of them).

-- ============ SCHEMA: method_rules ============

alter table method_rules
  add column cap_basis text check (cap_basis in ('reward', 'spend')),
  add column reward_form text check (reward_form in ('rate', 'fixed_payout')),
  add column gate_scope text check (gate_scope in ('tier_only', 'all_rewards')),
  add column credit_block_size numeric,
  add column credit_floor numeric,
  add column estimate_caveat text;

comment on column method_rules.cap_basis is
  'Which unit a cap row''s cap_amount is denominated in — the single most
   important discriminator the old three-function design existed to keep
   apart (0007''s own header, lines 44-48). Only ever set on rule_type =
   ''cap'' rows. ''reward'': cap_amount ceils accrued reward DOLLARS —
   every category_rate row (base row included) draws from the same shared
   pool, clamped after the rate is applied (uob_one, citi_cashback).
   ''spend'': cap_amount ceils eligible SPEND dollars — only rows with a
   non-null categories list draw from the pool, clamped BEFORE the rate is
   applied, and the row with categories is null (the base rate) is never
   capped at all, plus overflow spend past the cap falls through to the
   base rate rather than being forfeited (hsbc_revo). NULL means this card
   has no cap at all (no rule_type=''cap'' row matches).';

comment on column method_rules.reward_form is
  'rate: reward = matched_spend * rate (the common case, every
   category_rate row today). fixed_payout: reward = payout, a flat dollar
   amount independent of spend once threshold + txn_min both clear (every
   tier row today, uob_one only). Only meaningful on tier/category_rate
   rows; NULL defaults to ''rate'' at read time via coalesce, since that
   was every row''s implicit behaviour before this column existed.';

comment on column method_rules.gate_scope is
  'Only meaningful on min_spend/txn_count rows. ''all_rewards'': failing
   this gate routes ALL spend to the base category_rate row (categories is
   null) for the whole period — no bonus category_rate row is evaluated at
   all (citi_cashback''s min_spend gate, 0007 lines 1009-1019).
   ''tier_only'': failing this gate has NO effect on category_rate
   evaluation. In the *current* seed data it also has no effect on tier
   evaluation either, despite what that might suggest — see the long
   comment on evaluate_period() below for why that is a real discrepancy
   between this design doc and the code it was modelled on, preserved
   deliberately rather than silently corrected.';

comment on column method_rules.credit_block_size is
  'Post-processing crediting transform (citi_cashback''s cap row only
   today): reward rounds DOWN to the nearest multiple of this many dollars
   before it counts as credited. NULL means no transform — the row''s
   reward_accrued is usable immediately, true of every other row in the
   current seed data.';

comment on column method_rules.credit_floor is
  'Paired with credit_block_size: the blocked total must reach at least
   this many dollars before any of it is ''credited'' — below it, the
   whole blocked amount is accrued_uncredited, a distinct state never
   folded into the credited figure (citi_cashback: floor S$50, matching
   0007 lines 1021-1028). NULL is treated as a floor of zero (immediate
   crediting of any positive block) — not exercised by any seeded card,
   since the one row that sets credit_block_size also sets this.';

comment on column method_rules.estimate_caveat is
  'Free-text caveat attached to the evaluator''s output whenever this row
   is matched (claims at least one category) in a given period''s
   evaluation — e.g. hsbc_revo''s two bonus-category rows carry the
   contactless/online assumption from hsbc_month_status''s comment (0007
   lines 748-753), now data instead of a comment humans have to already
   know to go read. NULL (the default) means this row never needs one.
   Collected into the output''s top-level estimate_caveats[] array,
   de-duplicated.';

-- condition_key: generalises requires_ega, ADDITIVELY, not in place.
--
-- ============ DEVIATION FROM design/rules-engine.md §2, FOUND BY THE
-- DIFFERENTIAL HARNESS ITSELF, NOT BY CODE REVIEW ============
-- The design doc (§2) and this migration's own first draft both proposed
-- `alter table method_rules rename column requires_ega to condition_key`
-- — "generalised in place". That is wrong, and running
-- diff_evaluator_output() against real data is what caught it:
-- hsbc_month_status (0007 lines 797, 803) hardcodes the literal column
-- name `requires_ega` inside its own SQL (`where ... requires_ega =
-- v_ega`), and uob_quarter_status (0007 line 588) hardcodes
-- `quarter_anchor_date` the same way. A plpgsql function's embedded SQL
-- resolves column names at EXECUTION time, not at CREATE time, so `alter
-- table ... rename column` succeeds silently when this migration is
-- applied — the break only surfaces the first time hsbc_month_status or
-- uob_quarter_status is actually CALLED afterward, with
-- `column "requires_ega" does not exist`. That is exactly backwards for a
-- migration whose entire job is to keep those two functions alive,
-- unchanged, as the correctness oracle diff_evaluator_output compares
-- against (this migration's task brief, and design/rules-engine.md §4
-- step 4 itself: "does not drop ... in this same migration"). A rename
-- that breaks the oracle mid-migration defeats the one-release-cycle
-- rollback window before it starts.
--
-- Fix: add condition_key as a genuinely NEW, separate column instead of
-- retyping requires_ega in place. requires_ega itself — name, type,
-- default, not-null, values — is left completely untouched, so
-- hsbc_month_status keeps working exactly as 0007 wrote it, unchanged by
-- this migration. condition_key is backfilled from requires_ega once,
-- below, with the same true->'ega' / false->NULL mapping the design doc
-- specified; the two columns describe the same fact in two shapes for
-- exactly the retirement-window duration in the task brief, after which
-- a follow-up migration (dropping requires_ega alongside
-- hsbc_month_status itself) removes the duplication. Until then, ANY
-- future write to method_rules.requires_ega (there are none in this
-- migration or in the live ingest pipeline — it is operator/seed-only)
-- would need a matching write to condition_key to stay in sync; flagged
-- here rather than silently assumed.
alter table method_rules add column condition_key text;
update method_rules set condition_key = case when requires_ega then 'ega' else null end;
-- Constraint added AFTER the backfill above, deliberately: every existing
-- row has condition_key = NULL the instant the column is added (its
-- default), which does not yet match requires_ega for HSBC's two EGA
-- rows — adding the constraint before backfilling would reject those
-- rows' still-NULL condition_key against their already-true requires_ega.
alter table method_rules add constraint method_rules_condition_key_requires_ega_consistent
  check (condition_key is not distinct from (case when requires_ega then 'ega' else null end));

comment on column method_rules.condition_key is
  'Non-null only on rows gated by an operator-set external condition the
   ingest pipeline cannot observe (primitive #7 in the design doc) — e.g.
   ''ega'' for HSBC''s >=S$50,000 balance flag. NULL (the default) means
   this row is unconditional. Matched against method_conditions for the
   transaction period''s calendar month; absence of a method_conditions
   row for a given (method_id, calendar_month, condition_key) means the
   condition is NOT met — the same safe default hsbc_ega_months always
   used, preserved exactly via the 1:1 data migration below.
   DELIBERATELY NOT a rename of method_rules.requires_ega (which design/
   rules-engine.md §2 proposed and this migration''s first draft did) —
   see this migration''s header note on why a rename breaks
   hsbc_month_status (0007), which hardcodes the literal column name
   `requires_ega` in its own SQL. requires_ega stays exactly as 0007 left
   it, kept in sync via the check constraint above, until 0007''s
   functions are retired in a follow-up migration.';

-- ============ SCHEMA: method_conditions (generalises hsbc_ega_months) ============

create table method_conditions (
  method_id      text not null references payment_methods(id),
  calendar_month text not null check (calendar_month ~ '^\d{4}-\d{2}$'),
  condition_key  text not null,
  condition_met  boolean not null default true,
  note           text,
  updated_at     timestamptz not null default now(),
  primary key (method_id, calendar_month, condition_key)
);

comment on table method_conditions is
  'Operator-set flag: was a named external condition (method_rules.
   condition_key) met in this calendar month, for this card? Generalises
   hsbc_ega_months (0007) beyond a single hardcoded EGA boolean to any
   number of named conditions per card. Absence of a row = condition not
   met — the same safe default hsbc_ega_months always used. No writer in
   the ingest pipeline ever touches this table; only an operator (or a
   future dashboard control) does.';

alter table method_conditions enable row level security;
alter table method_conditions force row level security;
-- No policies, same posture as hsbc_ega_months at creation (0007) and
-- every table at creation (0001): default-deny until a deliberate
-- operator-facing grant is added. The blanket revokes below are
-- additional defence in depth, not load-bearing on their own.

-- One-time 1:1 migration of hsbc_ega_months's existing rows. Not a
-- backfill in the "derive new columns from old data" sense above — this
-- literally copies every row hsbc_ega_months has ever held into its
-- generalised replacement, condition_key = 'ega' throughout, so nothing
-- an operator has already recorded is lost. hsbc_ega_months itself is
-- left in place (not dropped) for the same one-release-cycle rollback
-- window as the old evaluator functions.
insert into method_conditions (method_id, calendar_month, condition_key, condition_met, note, updated_at)
select method_id, calendar_month, 'ega', ega_active, note, updated_at
from hsbc_ega_months
on conflict (method_id, calendar_month, condition_key) do nothing;

-- ============ SCHEMA: payment_methods ============

-- aggregation_anchor_date: same additive-not-in-place fix as
-- condition_key above, and found the same way — uob_quarter_status
-- (0007 line 588) hardcodes the literal column name
-- `quarter_anchor_date`, so `rename column` here would break it exactly
-- as it broke hsbc_month_status. quarter_anchor_date is left completely
-- untouched; aggregation_anchor_date is a new column, kept in sync via
-- the check constraint below, backfilled from it once.
alter table payment_methods add column aggregation_anchor_date date;
update payment_methods set aggregation_anchor_date = quarter_anchor_date;
-- Constraint added AFTER the backfill, same ordering reason as
-- method_rules.condition_key above (a NOT NULL quarter_anchor_date would
-- otherwise momentarily mismatch the just-added, still-NULL column).
alter table payment_methods add constraint payment_methods_aggregation_anchor_consistent
  check (aggregation_anchor_date is not distinct from quarter_anchor_date);

comment on column payment_methods.aggregation_anchor_date is
  'First day of the first period of this card''s first cross-period
   aggregation window (primitive #9) — e.g. UOB''s first statement month
   after account approval, the anchor for its quarterly gate. Only
   meaningful when aggregation_window is not null. NULL means unknown:
   evaluate_period_group() must not guess it, and while it is NULL falls
   back to an explicitly-labelled trailing-window approximation
   (grouping = ''anchor_unknown_trailing_window'') exactly as
   uob_quarter_status always did (0007 lines 532-542) — this new,
   additive column changes nothing about that behaviour (see the header
   note above this table''s section on why it is additive, not a rename).
   WARNING — setting this column to NOT NULL changes quarterly window
   computation versus retired uob_quarter_status (0007) behaviour: once
   an anchor is set, evaluate_period_group() takes the
   ''anchor_aligned'' branch, which DELIBERATELY does not reproduce 0007
   bit-for-bit — 0007 (0007 line 598) has a stride bug that advances the
   window start by one month per elapsed group instead of by the full
   window width, so it only computes correct quarter boundaries for the
   first quarter after the anchor and drifts every quarter thereafter;
   this evaluator computes the corrected, actually-quarterly windows
   instead, which can flip the `forfeited` verdict for a period 0007
   would have grouped differently. See the "SECOND, MORE CONSEQUENTIAL
   DEPARTURE" section in this migration''s header for the full example,
   and evaluate_period_group() below for the bit-for-bit-preserved
   trailing-window arithmetic (the only path exercised while this column
   stays NULL, as it does for every card today).';

-- NOTE: currency is deliberately NOT added here. design/rules-engine.md
-- §3.1 names it as a field this migration's output contract needs, and
-- this migration's first draft did add it — but 0014_ingestion_routing_
-- as_data.sql (WP2), which landed on this branch first, independently
-- added the identical column (`currency text not null default 'SGD'
-- check (currency ~ '^[A-Z]{3}$')`) for the parser's own needs. Adding it
-- again here would fail with "column already exists". evaluate_period()
-- below reads payment_methods.currency exactly as if this migration had
-- added it — the column exists, owned by 0014, documented there.
alter table payment_methods
  add column aggregation_window int check (aggregation_window is null or aggregation_window >= 2),
  add column rule_overrides jsonb,
  add column reward_unit text;

comment on column payment_methods.aggregation_window is
  'NULL for a card whose periods are evaluated independently (hsbc_revo,
   citi_cashback, every wallet). Set to the number of consecutive periods
   that must ALL clear the same tier threshold, all-or-nothing, before
   that tier''s fixed payout is earned (uob_one: 3). Drives
   evaluate_period_group(), called only when this is not null.';

comment on column payment_methods.rule_overrides is
  'Escape hatch for a mechanic that does not fit the declarative
   primitives evaluate_period()/evaluate_period_group() implement — see
   design/rules-engine.md §5. INTENTIONALLY INERT AT SHIP TIME: NULL on
   every row, and there is currently no override key evaluate_period()
   checks for. Do not add speculative keys here for a mechanic no real
   card in this codebase''s history has actually needed — the one known
   candidate (UOB''s first-quarter proration) is flagged unimplemented in
   the CURRENT hand-written engine too (0002_seed.sql lines 42-43,
   "not modelled below, add if this account is inside its first quarter"),
   so implementing it here would be solving a problem the existing system
   has never solved either, not closing a regression. If a future card
   genuinely needs this hatch: add ONE explicitly-named key, document it
   in a code comment on evaluate_period()/evaluate_period_group() (not a
   schema comment, since the whole point is these are the cases the
   schema deliberately does not model), and keep every other row''s value
   NULL.';

comment on column payment_methods.reward_unit is
  'The unit evaluate_period()''s reward_tracks[].unit and the old
   per-card functions'' hardcoded reward_unit literal are both describing
   — e.g. ''cashback_sgd_additional'' for uob_one. NULL for a wallet
   (has_rules = false) or any has_rules card not yet backfilled. Exists
   because a generic evaluator has no per-card branch left to hang a
   hardcoded literal on the way the old three functions did — see this
   migration''s header note for why this column is not in
   design/rules-engine.md §2''s list despite being required by that same
   design''s §3.1.';

-- ============ BACKFILL: reproduce the old three functions'' implicit shapes as data ============
-- Per design/rules-engine.md §4 step 2. Every UPDATE below sets a column
-- this migration just added to the value that made the OLD hand-written
-- function behave the way it already does — this is annotation of
-- existing behaviour, not a behaviour change. Verified against
-- diff_evaluator_output() below, not asserted.

-- ---- uob_one ----
update method_rules set reward_form = 'fixed_payout'
  where method_id = 'uob_one' and rule_type = 'tier';
update method_rules set reward_form = 'rate'
  where method_id = 'uob_one' and rule_type = 'category_rate';
update method_rules set cap_basis = 'reward'
  where method_id = 'uob_one' and rule_type = 'cap';
update method_rules set gate_scope = 'tier_only'
  where method_id = 'uob_one' and rule_type = 'txn_count';
update payment_methods
  set aggregation_window = 3, reward_unit = 'cashback_sgd_additional'
  where id = 'uob_one';

-- ---- hsbc_revo ----
update method_rules set reward_form = 'rate'
  where method_id = 'hsbc_revo' and rule_type = 'category_rate';
update method_rules set cap_basis = 'spend'
  where method_id = 'hsbc_revo' and rule_type = 'cap';
update method_rules
  set estimate_caveat = 'Assumes bonus-category spend was made contactless or online (required for the bonus rate) — unconfirmed until statement reconciliation.'
  where method_id = 'hsbc_revo' and rule_type = 'category_rate' and categories is not null;
update payment_methods
  set reward_unit = 'miles_best_partner_equivalent_2.5to1'
  where id = 'hsbc_revo';

-- ---- citi_cashback ----
update method_rules set gate_scope = 'all_rewards'
  where method_id = 'citi_cashback' and rule_type = 'min_spend';
update method_rules set reward_form = 'rate'
  where method_id = 'citi_cashback' and rule_type = 'category_rate';
update method_rules
  set cap_basis = 'reward', credit_block_size = 10, credit_floor = 50
  where method_id = 'citi_cashback' and rule_type = 'cap';
update payment_methods
  set reward_unit = 'cashback_sgd'
  where id = 'citi_cashback';

-- ============ THE GENERIC EVALUATOR ============
--
-- evaluate_period() replaces uob_month_status / hsbc_month_status /
-- citi_month_status with one function that reads method_rules as data
-- instead of branching on method_id. Same five-ish-step order the old
-- functions and the build spec (docs/architecture.md §6) already used:
-- resolve bounds, sum spend, resolve conditions, evaluate gates,
-- evaluate tiers, evaluate category rates (cap-aware), apply the
-- crediting transform, build the self-describing output (design §3.1).
--
-- ============ A REAL DISCREPANCY BETWEEN THE DESIGN DOC AND THE CODE IT
-- WAS MODELLED ON, PRESERVED HERE RATHER THAN SILENTLY "FIXED" ============
-- design/rules-engine.md §2/§3 describes gate_scope = 'tier_only' as
-- "failing this gate only prevents a 'tier'-type row's flat payout from
-- being hit" — i.e. it reads as if the standalone txn_count gate row is
-- what blocks UOB's tier payout. That is not what 0007's code actually
-- does. uob_month_status's tier walk (lines 416-430) checks EACH tier
-- row's OWN txn_min field directly (`v_txn_count >= coalesce(v_tier_row.
-- txn_min, 0)`) — it never consults the standalone txn_count gate row at
-- all for that purpose. The standalone gate row (0007 lines 406-414) only
-- ever feeds v_gate_ok, which the function returns as the informational
-- `gate_cleared` field and nothing else — 0007's own "DOCUMENTED
-- ASSUMPTION" comment (lines 332-341) says exactly this, and the design
-- doc's §1 table row 2 quotes that same comment accurately even though
-- its own §2/§3 prose then describes the *effect* (both land on the same
-- answer for uob_one's seed data, since every tier row's txn_min is
-- independently 10, matching the gate row's own txn_min) as if it were
-- the *mechanism*. Getting the mechanism right matters the moment a
-- future card's tier txn_min and its standalone gate's txn_min could ever
-- diverge — a generic evaluator that wired gate_scope = 'tier_only' to
-- actually gate the tier walk would be introducing NEW behaviour 0007
-- never had, not preserving old behaviour, and would fail the very
-- differential test this migration exists to pass the moment such a card
-- existed. This function preserves the actual mechanism: each tier row's
-- own txn_min governs that tier's own qualification (unchanged, generic
-- already); the standalone gate row's gate_scope = 'tier_only' is purely
-- descriptive metadata surfaced in the output's gates[] array, with zero
-- effect on tier or category_rate evaluation. gate_scope = 'all_rewards'
-- is the one value that actually gates anything computationally (citi_
-- cashback's min_spend row, matching 0007 lines 976 vs 1010 exactly).
create or replace function evaluate_period(p_method_id text, p_period_key text default null)
returns jsonb
language plpgsql
security invoker
stable
set search_path = public, pg_temp
as $$
declare
  v_method record;
  v_period_key text;
  v_bounds record;
  v_as_of date;
  v_calendar_month text;
  v_spend numeric := 0;
  v_txn_count int := 0;
  v_conditions jsonb := '{}'::jsonb;
  v_condition_keys text[];
  v_ck text;
  v_gates jsonb := '[]'::jsonb;
  v_bonus_locked boolean := false;
  v_any_gate_failed boolean := false;
  v_reasons text[] := '{}';
  v_estimate_caveats text[] := '{}';
  v_reward_tracks jsonb := '[]'::jsonb;
  v_reward_accrued numeric := 0;
  v_cap_row record;
  v_cap_remaining numeric;
  v_base_row record;
  v_base_rate numeric;
  v_claimed text[] := '{}';
  v_all_categories text[] := array[
    'groceries', 'dining', 'petrol', 'commute', 'transport',
    'bills', 'online', 'retail', 'healthcare', 'household', 'other'
  ];
  r record;
  v_g_required numeric;
  v_g_actual numeric;
  v_g_cleared boolean;
  v_candidate_cats text[];
  v_cat_spend numeric;
  v_row_reward numeric;
  v_applied numeric;
  v_spend_cap_overflow numeric := 0;
  v_overflow_reward numeric;
  v_base_track_idx int := null;
  v_tier_thresholds jsonb := '[]'::jsonb;
  v_tier_hit jsonb := null;
  v_gap_to_next numeric := null;
  v_t_reached boolean;
  v_t_is_current boolean;
  v_crediting jsonb := null;
  v_at_risk boolean := false;
begin
  select * into v_method from payment_methods where id = p_method_id;
  if not found then
    return jsonb_build_object('method_id', p_method_id, 'error', 'unknown payment method');
  end if;

  if not v_method.has_rules then
    return jsonb_build_object('method_id', p_method_id, 'display_name', v_method.display_name,
      'has_rules', false, 'note', 'no card rules configured for this method (e.g. a wallet)');
  end if;

  -- Staged/inactive card guard, generalised from citi_month_status (0007
  -- lines 931-939). Short-circuits BEFORE any query against transactions
  -- or method_rules, exactly as the old inert guard did — preserved
  -- deliberately, see this migration's task brief and the differential
  -- test below.
  if not v_method.active then
    return jsonb_build_object(
      'method_id', p_method_id, 'display_name', v_method.display_name,
      'currency', v_method.currency, 'active', false,
      'note', 'card not yet active — inert until payment_methods.active = true'
    );
  end if;

  v_period_key := coalesce(p_period_key, card_current_period_key(p_method_id));
  if v_period_key like '%:pending' then
    return jsonb_build_object('method_id', p_method_id, 'display_name', v_method.display_name,
      'period_key', v_period_key,
      'error', 'cycle_day not set for ' || p_method_id || '; period cannot be resolved');
  end if;

  select * into v_bounds from card_period_bounds(p_method_id, v_period_key);
  if v_bounds is null then
    return jsonb_build_object('method_id', p_method_id, 'display_name', v_method.display_name,
      'period_key', v_period_key, 'error', 'invalid or unresolvable period_key');
  end if;
  v_as_of := v_bounds.period_end;
  v_calendar_month := split_part(v_period_key, ':', 2);

  -- Step 2: sum spend/txn_count. Identical query every old function ran.
  select coalesce(sum(amount), 0), count(*) into v_spend, v_txn_count
  from spend_transactions
  where method_id = p_method_id and period_key = v_period_key
    and status in ('confirmed', 'provisional') and not is_transfer;

  -- Step 3: resolve conditions. Generalises hsbc_ega_active() to any
  -- number of named condition_keys this method's in-effect rows
  -- reference. Absence of a method_conditions row = not met, same safe
  -- default hsbc_ega_months always used.
  select array_agg(distinct condition_key) into v_condition_keys
  from method_rules
  where method_id = p_method_id and condition_key is not null
    and valid_from <= v_as_of and (valid_to is null or valid_to >= v_as_of);

  if v_condition_keys is not null then
    foreach v_ck in array v_condition_keys loop
      v_conditions := v_conditions || jsonb_build_object(v_ck, coalesce(
        (select condition_met from method_conditions
         where method_id = p_method_id and calendar_month = v_calendar_month and condition_key = v_ck),
        false
      ));
    end loop;
  end if;

  -- Step 4: gates. min_spend/txn_count rows are purely informational
  -- (gates[] array) UNLESS gate_scope = 'all_rewards', in which case a
  -- failure sets v_bonus_locked and routes step 6 to the base-rate-only
  -- branch. See the long header comment above on why gate_scope =
  -- 'tier_only' does NOT gate the tier walk here.
  for r in
    select rule_type, threshold, txn_min, gate_scope from method_rules
    where method_id = p_method_id and rule_type in ('min_spend', 'txn_count')
      and valid_from <= v_as_of and (valid_to is null or valid_to >= v_as_of)
      and (condition_key is null or coalesce((v_conditions ->> condition_key)::boolean, false))
  loop
    if r.rule_type = 'txn_count' then
      v_g_required := coalesce(r.txn_min, 0);
      v_g_actual := v_txn_count;
      v_g_cleared := v_txn_count >= v_g_required;
    else
      v_g_required := coalesce(r.threshold, 0);
      v_g_actual := v_spend;
      v_g_cleared := v_spend >= v_g_required;
    end if;

    v_gates := v_gates || jsonb_build_array(jsonb_build_object(
      'kind', r.rule_type, 'cleared', v_g_cleared,
      'required', v_g_required, 'actual', v_g_actual,
      'scope', coalesce(r.gate_scope, 'tier_only')
    ));

    if not v_g_cleared then
      v_any_gate_failed := true;
      v_reasons := v_reasons || ('below_' || r.rule_type);
      if r.gate_scope = 'all_rewards' then
        v_bonus_locked := true;
      end if;
    end if;
  end loop;

  -- Step 5: tiers (rule_type = 'tier'). Same threshold-desc walk as
  -- uob_month_status lines 416-430, generalised beyond uob_one. Each
  -- row's own txn_min governs that row's own qualification — unchanged.
  for r in
    select threshold, payout, txn_min from method_rules
    where method_id = p_method_id and rule_type = 'tier'
      and valid_from <= v_as_of and (valid_to is null or valid_to >= v_as_of)
      and (condition_key is null or coalesce((v_conditions ->> condition_key)::boolean, false))
    order by threshold desc
  loop
    v_t_reached := v_spend >= r.threshold and v_txn_count >= coalesce(r.txn_min, 0);
    v_t_is_current := false;

    if v_tier_hit is null and v_t_reached then
      v_tier_hit := jsonb_build_object('threshold', r.threshold, 'payout', r.payout);
      v_t_is_current := true;
    elsif v_tier_hit is null and v_spend < r.threshold then
      -- Overwritten on every unmet iteration; since rows are walked
      -- threshold-desc, the LAST overwrite before a match (or before the
      -- loop ends) is the nearest unmet tier above current spend —
      -- identical logic to uob_month_status lines 424-428.
      v_gap_to_next := r.threshold - v_spend;
    end if;

    v_tier_thresholds := v_tier_thresholds || jsonb_build_array(jsonb_build_object(
      'value', r.threshold, 'reached', v_t_reached, 'is_current_tier', v_t_is_current,
      'payout', r.payout,
      'gap', case when not v_t_reached then round(greatest(0, r.threshold - v_spend), 2) else null end,
      -- QA finding (contract defect): without this, a tier that is
      -- unreached purely on transaction count (spend already at/above
      -- threshold, so `gap` above is 0.00) was indistinguishable from a
      -- reached tier except for `reached: false`, with nothing in the
      -- row explaining why — e.g. UOB with 9 txns / $2,250 spend shows
      -- every tier as gap: 0.00, reached: false. A client had to
      -- cross-reference the top-level gates[] and assume it applies
      -- uniformly to every tier, which this migration's own header
      -- (the gate_scope = 'tier_only' departure, lines 422-451) says is
      -- NOT the real mechanism — each tier row has its own independent
      -- txn_min. Exposing it here lets a client compute its own txn
      -- shortfall (txn_min - spend.txn_count) directly from data this
      -- evaluator already returns, the same way `gap` already lets it
      -- compute spend shortfall — not a recomputed reward, so build spec
      -- (docs/architecture.md §6) is not in tension with this.
      'txn_min', coalesce(r.txn_min, 0)
    ));
  end loop;

  if jsonb_array_length(v_tier_thresholds) > 0 then
    -- Deliberately NOT folded into the top-level v_reward_accrued —
    -- found to be a real bug (not a stylistic choice) by the
    -- differential harness itself: uob_month_status's own
    -- `reward_accrued` (0007 line ~502, reward_unit
    -- 'cashback_sgd_additional') is accumulated ONLY inside its
    -- category_rate loop; the tier payout stays in `tier_hit.payout`
    -- alone, never added into that same total, because the tier payout
    -- is a SEPARATE quarterly cashback, disbursed through the
    -- cross-period group (evaluate_period_group's confirmed_tier),
    -- distinct from this period's monthly "additional cashback" figure.
    -- An earlier version of this function summed the two into one
    -- top-level number — plausible-looking, but wrong the moment a card
    -- has both a tier track and category_rate tracks in the same period
    -- (uob_one, every period): diff_evaluator_output caught it
    -- immediately (old 30.00 vs new 90.00 on a period with exactly
    -- S$600 of tier-1-qualifying spend and no other category spend).
    -- The tier's own payout is still fully reported, just only inside
    -- this track's own `accrued` field below and in `tier_hit`, exactly
    -- where the old function put it and nowhere else.
    v_reward_tracks := v_reward_tracks || jsonb_build_array(jsonb_build_object(
      'kind', 'tier', 'label', 'Spend tiers',
      'reward_form', 'fixed_payout', 'unit', v_method.reward_unit,
      'thresholds', v_tier_thresholds,
      'accrued', round(coalesce((v_tier_hit ->> 'payout')::numeric, 0), 2),
      'gap_to_next', round(coalesce(v_gap_to_next, 0), 2)
    ));
  end if;

  -- Step 6a: fetch the shared cap row once (if any), condition-filtered
  -- exactly like every other row lookup below. order by priority desc
  -- picks the higher-priority (condition-gated, when active) variant over
  -- an unconditional alternative for the same slot — see the resolution
  -- rule comment above the category_rate walk below.
  select cap_amount, cap_basis, credit_block_size, credit_floor
    into v_cap_row
  from method_rules
  where method_id = p_method_id and rule_type = 'cap'
    and valid_from <= v_as_of and (valid_to is null or valid_to >= v_as_of)
    and (condition_key is null or coalesce((v_conditions ->> condition_key)::boolean, false))
  order by priority desc
  limit 1;
  v_cap_remaining := v_cap_row.cap_amount;

  -- Base rate (categories is null category_rate row), fetched once for
  -- use both in the v_bonus_locked branch and in routing spend-basis
  -- overflow — same double-purpose fetch citi_month_status already made
  -- (0007 line 970, used only in its own locked branch at line 1012)
  -- alongside the SAME row also being processed inside the generic walk
  -- below when not locked. Not a new redundancy; mirrors what already
  -- existed.
  select rate into v_base_rate
  from method_rules
  where method_id = p_method_id and rule_type = 'category_rate' and categories is null
    and valid_from <= v_as_of and (valid_to is null or valid_to >= v_as_of)
    and (condition_key is null or coalesce((v_conditions ->> condition_key)::boolean, false))
  limit 1;

  if v_bonus_locked then
    -- gate_scope = 'all_rewards' failed: every dollar of spend earns the
    -- base rate only, no category_rate row is evaluated at all — citi_
    -- month_status lines 1010-1019, generalised.
    v_row_reward := v_spend * coalesce(v_base_rate, 0);
    if v_cap_row.cap_basis = 'spend' then
      -- Not exercised by any seeded card (no card combines gate_scope =
      -- 'all_rewards' with cap_basis = 'spend'); extrapolated for
      -- generality and NOT verified by the differential harness below.
      v_applied := least(v_spend, coalesce(v_cap_remaining, v_spend)) * coalesce(v_base_rate, 0);
      if v_cap_remaining is not null then
        v_cap_remaining := v_cap_remaining - least(v_spend, v_cap_remaining);
      end if;
    else
      v_applied := least(v_row_reward, coalesce(v_cap_remaining, v_row_reward));
      if v_cap_remaining is not null then
        v_cap_remaining := v_cap_remaining - v_applied;
      end if;
    end if;
    v_reward_accrued := v_reward_accrued + v_applied;
    v_reward_tracks := v_reward_tracks || jsonb_build_array(jsonb_build_object(
      'kind', 'category_rate', 'label', 'Base rate (bonus categories locked this period)',
      'reward_form', 'rate', 'unit', v_method.reward_unit,
      'categories', null, 'threshold', null, 'threshold_met', true,
      'matched_spend', round(v_spend, 2), 'rate', v_base_rate, 'accrued', round(v_applied, 2),
      'cap', case when v_cap_row.cap_basis is not null then jsonb_build_object(
        'basis', v_cap_row.cap_basis, 'amount', v_cap_row.cap_amount,
        'remaining', round(v_cap_remaining, 2),
        'exhausted', v_cap_remaining is not null and v_cap_remaining <= 0
      ) else null end
    ));
  else
    -- Step 6b: the priority-desc, claim-based category_rate walk —
    -- character-for-character the same algorithm uob_month_status
    -- (lines 439-470) and citi_month_status (lines 976-1008) already
    -- share, lifted out once and made cap-aware.
    --
    -- CONDITION RESOLUTION RULE (not spelled out mechanically in the
    -- design doc's §3 step 3/6 — worked out here from hsbc_month_status's
    -- actual lookup, `where requires_ega = v_ega`, which is an EQUALITY
    -- match, not merely "is this row gated"): a row with a non-null
    -- condition_key participates in this walk (and the cap lookup above)
    -- ONLY IF that condition currently resolves true; a row with
    -- condition_key IS NULL always participates. This reproduces HSBC's
    -- exact behaviour purely through the filter plus the EXISTING
    -- claim/priority mechanism, with no extra branching: when EGA is
    -- active, both the 8 mpd row (condition_key='ega', priority 25) and
    -- the 4 mpd row (condition_key is null, priority 20) pass the filter,
    -- but the 8 mpd row is walked first and claims the categories, so the
    -- 4 mpd row finds nothing left to claim and is skipped by the
    -- existing "candidate_cats is empty" branch below — never double-
    -- counted. When EGA is inactive, the 8 mpd row is filtered out
    -- entirely and only the 4 mpd row participates.
    for r in
      select categories, threshold, rate, notes, reward_form, estimate_caveat
      from method_rules
      where method_id = p_method_id and rule_type = 'category_rate'
        and valid_from <= v_as_of and (valid_to is null or valid_to >= v_as_of)
        and (condition_key is null or coalesce((v_conditions ->> condition_key)::boolean, false))
      order by priority desc
    loop
      if r.threshold is not null and v_spend < r.threshold then
        -- Not yet active this period. Old code skips this row with zero
        -- trace in its output; this evaluator still emits a zero-effect
        -- track entry (threshold_met: false) so a UI can show progress
        -- toward it without shape-sniffing — new information, not a
        -- behaviour change: nothing below this branch touches
        -- v_reward_accrued, v_cap_remaining, or v_claimed, so it cannot
        -- affect the differential comparison.
        v_reward_tracks := v_reward_tracks || jsonb_build_array(jsonb_build_object(
          'kind', 'category_rate',
          'label', coalesce(nullif(split_part(r.notes, '.', 1), ''), 'Category bonus') || '.',
          'reward_form', coalesce(r.reward_form, 'rate'), 'unit', v_method.reward_unit,
          'categories', to_jsonb(r.categories), 'threshold', r.threshold, 'threshold_met', false,
          'matched_spend', 0, 'rate', r.rate, 'accrued', 0, 'cap', null
        ));
        continue;
      end if;

      if r.categories is null then
        v_candidate_cats := array(select unnest(v_all_categories) except select unnest(v_claimed));
      else
        v_candidate_cats := array(select unnest(r.categories) except select unnest(v_claimed));
      end if;

      if array_length(v_candidate_cats, 1) is null then
        -- Fully claimed by a higher-priority row already this period.
        -- Same "no trace in old output" / "safe new trace here" note as
        -- above applies.
        v_reward_tracks := v_reward_tracks || jsonb_build_array(jsonb_build_object(
          'kind', 'category_rate',
          'label', coalesce(nullif(split_part(r.notes, '.', 1), ''), 'Category bonus') || '.',
          'reward_form', coalesce(r.reward_form, 'rate'), 'unit', v_method.reward_unit,
          'categories', to_jsonb(r.categories), 'threshold', r.threshold, 'threshold_met', true,
          'matched_spend', 0, 'rate', r.rate, 'accrued', 0,
          'note', 'fully claimed by a higher-priority rule this period', 'cap', null
        ));
        continue;
      end if;

      select coalesce(sum(amount), 0) into v_cat_spend
      from spend_transactions
      where method_id = p_method_id and period_key = v_period_key
        and status in ('confirmed', 'provisional') and not is_transfer
        and category = any(v_candidate_cats);

      if v_cap_row.cap_basis = 'spend' and r.categories is not null then
        -- Spend-ceiling bonus row (hsbc_revo-style): clamp SPEND against
        -- the shared cap before multiplying by rate; overflow spend is
        -- routed to the base rate below, exactly hsbc_month_status lines
        -- 822-832.
        declare
          v_capped_spend numeric := least(v_cat_spend, coalesce(v_cap_remaining, v_cat_spend));
          v_overflow_spend numeric := v_cat_spend - v_capped_spend;
        begin
          v_applied := v_capped_spend * r.rate;
          v_reward_accrued := v_reward_accrued + v_applied;
          v_spend_cap_overflow := v_spend_cap_overflow + v_overflow_spend;
          if v_cap_remaining is not null then
            v_cap_remaining := v_cap_remaining - v_capped_spend;
          end if;
          v_reward_tracks := v_reward_tracks || jsonb_build_array(jsonb_build_object(
            'kind', 'category_rate',
            'label', coalesce(nullif(split_part(r.notes, '.', 1), ''), 'Category bonus') || '.',
            'reward_form', coalesce(r.reward_form, 'rate'), 'unit', v_method.reward_unit,
            'categories', to_jsonb(r.categories), 'threshold', r.threshold, 'threshold_met', true,
            'matched_spend', round(v_cat_spend, 2), 'rate', r.rate, 'accrued', round(v_applied, 2),
            'overflow_spend', round(v_overflow_spend, 2),
            'cap', jsonb_build_object(
              'basis', 'spend', 'amount', v_cap_row.cap_amount,
              'remaining', round(v_cap_remaining, 2),
              'exhausted', v_cap_remaining is not null and v_cap_remaining <= 0
            )
          ));
        end;
      elsif v_cap_row.cap_basis = 'spend' and r.categories is null then
        -- The base rate row under a spend-ceiling scheme (hsbc_revo's
        -- non-bonus-category spend): NEVER capped, full rate always,
        -- zero interaction with v_cap_remaining — hsbc_month_status's
        -- `v_base_spend * v_base_rate` term (line 832) is unconditional.
        -- Without this branch, this row would otherwise be caught by the
        -- reward-ceiling branch below and wrongly clamped against the
        -- SAME cap pool the bonus row above already drew from.
        v_applied := v_cat_spend * r.rate;
        v_reward_accrued := v_reward_accrued + v_applied;
        v_reward_tracks := v_reward_tracks || jsonb_build_array(jsonb_build_object(
          'kind', 'category_rate',
          'label', coalesce(nullif(split_part(r.notes, '.', 1), ''), 'Category bonus') || '.',
          'reward_form', coalesce(r.reward_form, 'rate'), 'unit', v_method.reward_unit,
          'categories', to_jsonb(r.categories), 'threshold', r.threshold, 'threshold_met', true,
          'matched_spend', round(v_cat_spend, 2), 'rate', r.rate, 'accrued', round(v_applied, 2),
          'cap', null
        ));
        -- Remember this track's index: spend-cap overflow accumulated
        -- across every capped bonus row above (known only once the loop
        -- below finishes) gets folded into ITS accrued figure, not left
        -- to inflate reward_accrued alone with no track to show for it —
        -- see the overflow-routing block after this loop.
        v_base_track_idx := jsonb_array_length(v_reward_tracks) - 1;
      else
        -- Reward-ceiling row (uob_one/citi_cashback-style, or genuinely
        -- uncapped when v_cap_row.cap_basis is null): clamp the computed
        -- reward DOLLARS against the shared cap — uob_month_status lines
        -- 439-470 / citi_month_status lines 976-1008.
        v_row_reward := v_cat_spend * r.rate;
        v_applied := least(v_row_reward, coalesce(v_cap_remaining, v_row_reward));
        v_reward_accrued := v_reward_accrued + v_applied;
        if v_cap_remaining is not null then
          v_cap_remaining := v_cap_remaining - v_applied;
        end if;
        v_reward_tracks := v_reward_tracks || jsonb_build_array(jsonb_build_object(
          'kind', 'category_rate',
          'label', coalesce(nullif(split_part(r.notes, '.', 1), ''), 'Category bonus') || '.',
          'reward_form', coalesce(r.reward_form, 'rate'), 'unit', v_method.reward_unit,
          'categories', to_jsonb(r.categories), 'threshold', r.threshold, 'threshold_met', true,
          'matched_spend', round(v_cat_spend, 2), 'rate', r.rate, 'accrued', round(v_applied, 2),
          'cap', case when v_cap_row.cap_basis is not null then jsonb_build_object(
            'basis', v_cap_row.cap_basis, 'amount', v_cap_row.cap_amount,
            'remaining', round(v_cap_remaining, 2),
            'exhausted', v_cap_remaining is not null and v_cap_remaining <= 0
          ) else null end
        ));
      end if;

      v_claimed := v_claimed || v_candidate_cats;
      if r.estimate_caveat is not null and not (r.estimate_caveat = any(v_estimate_caveats)) then
        v_estimate_caveats := v_estimate_caveats || r.estimate_caveat;
      end if;
    end loop;

    -- Route accumulated spend-cap overflow to the base rate — the
    -- `v_overflow * v_base_rate` term of hsbc_month_status line 831,
    -- generalised across however many spend-capped rows this card has
    -- (currently exactly one).
    --
    -- QA finding (contract defect, not a behaviour bug — the DOLLAR
    -- figure below was always right): folding the overflow reward only
    -- into the top-level v_reward_accrued and nowhere else left it
    -- invisible in reward_tracks[] — e.g. HSBC dining spend $1,050
    -- against a $1,000 spend-basis cap: top-level reward_accrued =
    -- 4020.00, but summing reward_tracks[].accrued gave 4000.00, a
    -- $20 gap present in NO track. `overflow_spend` existed on the
    -- capped bonus row, but its reward VALUE required a client to also
    -- find the sibling `categories: null` track, read its `rate`, and
    -- multiply — recomputing a number this evaluator already computed,
    -- which build spec (docs/architecture.md §6) forbids clients from
    -- having to do. Fixed by folding the overflow reward into the
    -- base-rate track's own
    -- `accrued` (chosen over adding a new top-level field: the overflow
    -- spend genuinely does earn at the base rate that track already
    -- reports, so crediting it there is the accurate description of
    -- where the reward came from, and it restores the invariant a
    -- client would reasonably assume already held for category_rate
    -- tracks — sum(reward_tracks[].accrued) == reward_accrued across
    -- every category_rate row. That invariant still has exactly one
    -- documented exception, unrelated to this fix: the tier track's
    -- `accrued` (its fixed payout) is deliberately EXCLUDED from
    -- reward_accrued — see the tier-track block above — so a client
    -- summing reward_tracks[].accrued to reproduce reward_accrued must
    -- skip any `kind: 'tier'` row. `overflow_spend` is carried onto the
    -- same track so it stays self-explanatory (why accrued >
    -- matched_spend * rate).
    if v_spend_cap_overflow > 0 then
      v_overflow_reward := round(v_spend_cap_overflow * coalesce(v_base_rate, 0), 2);
      v_reward_accrued := v_reward_accrued + v_overflow_reward;
      if v_base_track_idx is not null then
        v_reward_tracks := jsonb_set(
          jsonb_set(
            v_reward_tracks,
            array[v_base_track_idx::text, 'accrued'],
            to_jsonb(round(coalesce((v_reward_tracks -> v_base_track_idx ->> 'accrued')::numeric, 0) + v_overflow_reward, 2))
          ),
          array[v_base_track_idx::text, 'overflow_spend'],
          to_jsonb(round(v_spend_cap_overflow, 2))
        );
      end if;
    end if;
  end if;

  -- Step 7: crediting transform (citi_cashback's cap row only today).
  -- Applied to the FINAL reward_accrued after every track above has been
  -- summed — citi_month_status lines 1021-1028, generalised off
  -- credit_block_size/credit_floor instead of hardcoded 10/50.
  if v_cap_row.credit_block_size is not null then
    declare
      v_floor numeric := coalesce(v_cap_row.credit_floor, 0);
      v_blocked numeric := floor(v_reward_accrued / v_cap_row.credit_block_size) * v_cap_row.credit_block_size;
    begin
      if v_blocked >= v_floor then
        v_crediting := jsonb_build_object(
          'block_size', v_cap_row.credit_block_size, 'floor', v_floor,
          'credited', v_blocked, 'accrued_uncredited', round(v_reward_accrued - v_blocked, 2)
        );
      else
        v_crediting := jsonb_build_object(
          'block_size', v_cap_row.credit_block_size, 'floor', v_floor,
          'credited', 0, 'accrued_uncredited', v_blocked
        );
      end if;
    end;
  end if;

  -- at_risk: a genuine generalisation of three previously ad hoc, per-
  -- card boolean expressions (uob_month_status line 510,
  -- hsbc_month_status lines 869-870, citi_month_status line 1062) into
  -- one data-driven OR of three conditions, each already computed above
  -- for an unrelated reason:
  --   - any gate (of either scope) currently failing — reproduces UOB's
  --     `not gate_ok` term and Citi's `not gate_ok` term exactly, since
  --     each card's only gate row(s) are exactly the ones the old
  --     function consulted for its own at_risk expression.
  --   - a tier track exists and no tier has been reached yet — reproduces
  --     UOB's hardcoded `spend < 600` term exactly (tier_hit is null iff
  --     spend is below the LOWEST seeded threshold, since tiers are
  --     walked highest-first and the first met tier wins).
  --   - the shared cap is spend-basis and still has headroom — reproduces
  --     HSBC's `bonus_spend < cap_amount` term exactly (cap_remaining > 0
  --     iff bonus_spend < cap_amount, by construction of how
  --     v_cap_remaining is decremented above).
  -- Verified empirically against the three seeded cards by the
  -- differential harness below, not merely reasoned through — this is
  -- exactly the kind of generalisation that needed a real diff, not a
  -- code review, to trust.
  if v_any_gate_failed then
    v_at_risk := true;
  end if;
  if jsonb_array_length(v_tier_thresholds) > 0 and v_tier_hit is null then
    v_at_risk := true;
  end if;
  if v_cap_row.cap_basis = 'spend' and v_cap_remaining is not null and v_cap_remaining > 0 then
    v_at_risk := true;
    -- Explicit ::text cast, not stylistic: `text[] || 'literal'` with an
    -- untyped string literal on the right resolves ambiguously in
    -- plpgsql/Postgres — it can pick the anyarray||anyarray overload and
    -- try to parse the literal AS an array, raising "malformed array
    -- literal" at call time (found running this migration's own
    -- differential harness, not by inspection: v_reasons || ('below_' ||
    -- r.rule_type) above never hit this because concatenating with a text
    -- column gives the literal a known text type already). Every bare
    -- literal appended to a text[] variable in this function is cast
    -- explicitly for the same reason — see the matching cast just below.
    v_reasons := v_reasons || 'unused_bonus_cap_headroom'::text;
  end if;
  if v_cap_row.cap_basis is not null and v_cap_remaining is not null and v_cap_remaining <= 0 then
    v_reasons := v_reasons || 'cap_exhausted'::text;
  end if;
  v_at_risk := v_at_risk and v_bounds.is_current and v_bounds.days_left <= 5;

  return jsonb_build_object(
    'method_id', p_method_id,
    'display_name', v_method.display_name,
    'currency', v_method.currency,
    'period', jsonb_build_object(
      'key', v_period_key,
      'start', v_bounds.period_start, 'end', v_bounds.period_end,
      'is_current', v_bounds.is_current, 'days_left', v_bounds.days_left,
      'kind', v_method.period_type
    ),
    'spend', jsonb_build_object('total', round(v_spend, 2), 'txn_count', v_txn_count),
    'gates', v_gates,
    'reward_tracks', v_reward_tracks,
    -- Addition beyond the design doc's §3.1 example — see this
    -- migration's header note. The raw, pre-crediting total; matches
    -- what every old function's own `reward_accrued` field already meant
    -- (citi_month_status returns the RAW figure here too, line 1057 —
    -- the crediting split is a separate `credited`/`accrued_uncredited`
    -- pair, not a correction to this field).
    'reward_accrued', round(v_reward_accrued, 2),
    -- Addition beyond the design doc's §3.1 example — see this
    -- migration's header note. Collapses the one shared cap (when this
    -- card has one) to a single place instead of repeating it identically
    -- on every capped track.
    'cap', case when v_cap_row.cap_basis is not null then jsonb_build_object(
      'basis', v_cap_row.cap_basis, 'amount', v_cap_row.cap_amount,
      'remaining', round(v_cap_remaining, 2),
      'exhausted', v_cap_remaining is not null and v_cap_remaining <= 0
    ) else null end,
    'crediting', v_crediting,
    'group', null, -- populated by card_period_status-equivalent callers via evaluate_period_group(); see that function
    -- QA finding (contract defect): `group` above is unconditionally
    -- null, with nothing in this payload telling a client that
    -- evaluate_period_group() is meaningful for this method_id at all —
    -- the only way to know uob_one is quarterly was out-of-band
    -- knowledge baked into the caller, exactly the per-issuer
    -- special-casing this generic contract exists to remove. `has_group`
    -- is the boolean a client branches on; `aggregation_window` is
    -- surfaced alongside it (null when has_group is false) since a
    -- caller that already knows to call evaluate_period_group() needs
    -- the window size to know how many member periods to expect back,
    -- and this evaluator already has the value in hand from the same
    -- payment_methods row `group` above's own note points at — no
    -- second query.
    'has_group', v_method.aggregation_window is not null,
    'aggregation_window', v_method.aggregation_window,
    'at_risk', jsonb_build_object('value', v_at_risk, 'reasons', to_jsonb(v_reasons)),
    'estimate_caveats', to_jsonb(v_estimate_caveats),
    'active', true
  );
end;
$$;

comment on function evaluate_period(text, text) is
  'Generic replacement for uob_month_status / hsbc_month_status /
   citi_month_status. Reads method_rules as data instead of branching on
   method_id — see the long comment above the function body for the one
   deliberate discrepancy this preserves against design/rules-engine.md''s
   own prose. NOT yet called by card_period_status() — that switch is
   gated on diff_evaluator_output() below being reviewed clean across a
   real range of periods. uob_month_status/hsbc_month_status/
   citi_month_status remain the live path until then.
   QA-driven additive fixes on top of the original shape, none changing
   any EXISTING field''s meaning except where noted: (1) `has_group` and
   `aggregation_window` are new top-level fields — the only way to know
   evaluate_period_group() applies to a method_id used to be out-of-band
   knowledge that uob_one is quarterly; (2) each `reward_tracks[]` tier
   row gained `txn_min` so an unreached tier is self-explanatory even
   when spend already clears the threshold (`gap: 0.00`) and only the
   independent txn_min is unmet; (3) the base-rate (`categories: null`)
   category_rate track''s `accrued` — and this IS a meaning change, flagged
   here loudly, nothing consumes this contract yet — now includes any
   spend-cap overflow reward routed to it (with a new `overflow_spend`
   field alongside explaining why), instead of that reward existing only
   in the top-level reward_accrued total with no track summing to it. See
   the inline comments at each site for the concrete QA-found cases.';

-- ============ CROSS-PERIOD AGGREGATION ============
--
-- evaluate_period_group() replaces uob_quarter_status with a generic
-- version driven by payment_methods.aggregation_window /
-- aggregation_anchor_date instead of a hardcoded 3 and
-- array[2000,1000,600]. Keeps uob_quarter_status's exact algorithm (0007
-- lines 543-728) for the SHAPE of the computation — resolve the window
-- via the anchor or the trailing-window fallback, call evaluate_period()
-- once per member period (never itself recursively — no unbounded
-- recursion risk), and determine still_achievable_tier / confirmed_tier
-- / forfeited from each member's own gate clearance, never a summed
-- total across members — but NOT for the anchor-aligned window
-- arithmetic itself, which this function deliberately corrects rather
-- than reproduces. See the "SECOND, MORE CONSEQUENTIAL DEPARTURE"
-- section in this migration's header, and the comment on
-- v_window_start's anchor-aligned branch below, for the concrete
-- divergence and why it is intentional.
create or replace function evaluate_period_group(p_method_id text, p_period_key text default null)
returns jsonb
language plpgsql
security invoker
stable
set search_path = public, pg_temp
as $$
declare
  v_period_key text := coalesce(p_period_key, card_current_period_key(p_method_id));
  v_bounds record;
  v_anchor date;
  v_window int;
  v_target date;
  v_months_diff int;
  v_window_start date;
  v_grouping text;
  v_periods date[];
  v_statuses jsonb := '[]'::jsonb;
  v_mstatus jsonb;
  v_thr numeric;
  v_txn_min int;
  v_payout numeric;
  v_still_achievable jsonb := null;
  v_confirmed jsonb := null;
  v_forfeited boolean;
  v_ok boolean;
  v_all_closed_ok boolean;
  v_spend numeric;
  v_txn int;
  v_is_current boolean;
  v_days_left int;
  v_closed boolean;
  v_any_current_at_risk boolean;
  v_blocking_members jsonb := '[]'::jsonb;
  v_min_thr numeric;
  v_min_txn_min int;
  i int;
begin
  select * into v_bounds from card_period_bounds(p_method_id, v_period_key);
  if v_bounds is null then
    return jsonb_build_object('method_id', p_method_id, 'group_period_key', v_period_key,
      'error', 'invalid or unresolvable period_key');
  end if;

  select aggregation_anchor_date, aggregation_window into v_anchor, v_window
  from payment_methods where id = p_method_id;

  if v_window is null then
    return jsonb_build_object('method_id', p_method_id, 'group_period_key', v_period_key,
      'error', 'no aggregation_window configured for this method');
  end if;

  v_target := make_date(
    split_part(split_part(v_period_key, ':', 2), '-', 1)::int,
    split_part(split_part(v_period_key, ':', 2), '-', 2)::int,
    1
  );

  if v_anchor is not null then
    -- NOT bit-for-bit uob_quarter_status (0007 line 598) — deliberately.
    -- 0007's own arithmetic is `date_trunc('month', v_anchor) +
    -- floor(v_months_diff / 3.0)::int * interval '1 month'`: it advances
    -- the window start by ONE MONTH per elapsed group instead of by the
    -- window's full width, a stride bug that only lands on the right
    -- quarter boundary for the first quarter after the anchor and then
    -- drifts every quarter after that. This line fixes the stride to
    -- `* v_window` so the window start actually advances by whole
    -- windows. Verified divergent (and this side verified correct)
    -- against 0007's function directly: with aggregation_anchor_date =
    -- '2026-02-01', target uob_one:2026-05 groups [2026-03, 2026-04,
    -- 2026-05] under 0007 vs [2026-05, 2026-06, 2026-07] here; target
    -- uob_one:2026-08 groups [2026-04, 2026-05, 2026-06] under 0007 vs
    -- [2026-08, 2026-09, 2026-10] here, and that second case flips the
    -- downstream `forfeited` verdict between the two engines. See the
    -- "SECOND, MORE CONSEQUENTIAL DEPARTURE" section in this migration's
    -- header for the full writeup — do not "fix" this line to match
    -- 0007; 0007 is the one that is wrong.
    v_months_diff := (extract(year from v_target)::int - extract(year from v_anchor)::int) * 12
                    + (extract(month from v_target)::int - extract(month from v_anchor)::int);
    v_window_start := (date_trunc('month', v_anchor)
      + (floor(v_months_diff / v_window::numeric)::int * v_window * interval '1 month'))::date;
    v_grouping := 'anchor_aligned';
  else
    -- Bit-for-bit the same fallback uob_quarter_status always used (0007
    -- lines 600-603: `date_trunc('month', v_target) - interval '2
    -- month'`), generalised from the hardcoded 2-month offset to
    -- (v_window - 1) months — identical arithmetic for uob_one's actual
    -- window of 3, the only case this has ever run against.
    v_window_start := (date_trunc('month', v_target) - (v_window - 1) * interval '1 month')::date;
    v_grouping := 'anchor_unknown_trailing_window';
  end if;

  v_periods := array(select (v_window_start + (n * interval '1 month'))::date from generate_series(0, v_window - 1) n);

  for i in 1..v_window loop
    v_mstatus := evaluate_period(p_method_id, p_method_id || ':' || to_char(v_periods[i], 'YYYY-MM'));
    v_statuses := v_statuses || jsonb_build_array(v_mstatus);
  end loop;

  -- Lowest tier threshold this method has (for the forfeited/blocking
  -- report below) — generalises uob_quarter_status's hardcoded "600" cut
  -- line for "even Tier 1 is not achievable".
  select threshold, txn_min into v_min_thr, v_min_txn_min
  from method_rules
  where method_id = p_method_id and rule_type = 'tier'
    and valid_from <= v_bounds.period_end and (valid_to is null or valid_to >= v_bounds.period_end)
  order by threshold asc limit 1;

  for v_thr, v_txn_min, v_payout in
    select threshold, coalesce(txn_min, 0), payout from method_rules
    where method_id = p_method_id and rule_type = 'tier'
      and valid_from <= v_bounds.period_end and (valid_to is null or valid_to >= v_bounds.period_end)
    order by threshold desc
  loop
    v_ok := true;
    v_all_closed_ok := true;
    for i in 1..v_window loop
      v_mstatus := v_statuses -> (i - 1);
      if v_mstatus ? 'error' or v_mstatus ? 'has_rules' then
        continue;
      end if;
      v_spend := (v_mstatus -> 'spend' ->> 'total')::numeric;
      v_txn := (v_mstatus -> 'spend' ->> 'txn_count')::int;
      v_is_current := (v_mstatus -> 'period' ->> 'is_current')::boolean;
      v_days_left := (v_mstatus -> 'period' ->> 'days_left')::int;
      v_closed := (not v_is_current) and v_days_left = 0;

      -- Only a CLOSED member's shortfall is a hard, unrecoverable failure
      -- for "still achievable" — an in-progress or future member is given
      -- the benefit of the doubt, exactly uob_quarter_status lines
      -- 633-643.
      if v_closed then
        if v_spend < v_thr or v_txn < v_txn_min then
          v_ok := false;
        end if;
      end if;
      if not v_closed or v_spend < v_thr or v_txn < v_txn_min then
        v_all_closed_ok := false;
      end if;
    end loop;
    if v_ok and v_still_achievable is null then
      v_still_achievable := jsonb_build_object('threshold', v_thr, 'payout', v_payout);
    end if;
    if v_all_closed_ok and v_confirmed is null then
      v_confirmed := jsonb_build_object('threshold', v_thr, 'payout', v_payout);
    end if;
  end loop;

  v_forfeited := v_still_achievable is null;

  if v_forfeited and v_min_thr is not null then
    for i in 1..v_window loop
      v_mstatus := v_statuses -> (i - 1);
      if v_mstatus ? 'error' or v_mstatus ? 'has_rules' then
        continue;
      end if;
      v_spend := (v_mstatus -> 'spend' ->> 'total')::numeric;
      v_txn := (v_mstatus -> 'spend' ->> 'txn_count')::int;
      v_is_current := (v_mstatus -> 'period' ->> 'is_current')::boolean;
      v_days_left := (v_mstatus -> 'period' ->> 'days_left')::int;
      v_closed := (not v_is_current) and v_days_left = 0;
      if v_closed and (v_spend < v_min_thr or v_txn < v_min_txn_min) then
        v_blocking_members := v_blocking_members || jsonb_build_array(jsonb_build_object(
          'period_key', v_mstatus -> 'period' ->> 'key',
          'spend', v_spend, 'txn_count', v_txn,
          'spend_short', greatest(0, v_min_thr - v_spend),
          'txn_short', greatest(0, v_min_txn_min - v_txn)
        ));
      end if;
    end loop;
  end if;

  select bool_or(coalesce((s -> 'at_risk' ->> 'value')::boolean, false)) into v_any_current_at_risk
  from jsonb_array_elements(v_statuses) s;

  return jsonb_build_object(
    'method_id', p_method_id,
    'group_period_key', v_period_key,
    'window', v_window,
    'grouping', v_grouping,
    'anchor_unknown', v_anchor is null,
    'members', v_statuses,
    'still_achievable_tier', v_still_achievable,
    'confirmed_tier', v_confirmed,
    'forfeited', v_forfeited,
    'blocking_members', v_blocking_members,
    'at_risk', v_forfeited or coalesce(v_any_current_at_risk, false),
    'approx_payout_at_stake', case when v_forfeited then null
      else (v_still_achievable ->> 'payout')::numeric end
  );
end;
$$;

comment on function evaluate_period_group(text, text) is
  'Generic replacement for uob_quarter_status. Called only when
   payment_methods.aggregation_window is not null. Fidelity to 0007 is
   qualified, not blanket: bit-for-bit preserves the anchor-unknown
   trailing-window fallback (grouping =
   ''anchor_unknown_trailing_window'') for uob_one, the only card this has
   ever run against — see the inline comment on v_window_start above.
   The anchor-aligned branch (grouping = ''anchor_aligned'', taken only
   when aggregation_anchor_date is set — true for no card today) is
   DELIBERATELY NOT bit-for-bit: it corrects a window-stride bug in 0007
   (0007 line 598 advances the window start by one month per elapsed
   group instead of by the full window width) rather than reproducing
   it, which can change which periods group together and can flip the
   `forfeited` verdict versus 0007 for the same period_key. See the
   "SECOND, MORE CONSEQUENTIAL DEPARTURE" section in this migration''s
   header for the concrete example, and the inline comment on
   v_window_start''s anchor-aligned assignment above for the fix itself.';

-- ============ DIFFERENTIAL-TESTING HARNESS (WP1's own acceptance gate,
-- reused by WP7's validator) ============
--
-- A named, standalone, reusable callable per design/rules-engine.md §4
-- step 5 and the WP8 note in design/plan.md — not inline test-script
-- logic. Compares the OLD dispatcher (card_period_status, still calling
-- uob_month_status/hsbc_month_status/citi_month_status/uob_quarter_status
-- exactly as 0007 left it) against the NEW evaluator (evaluate_period() +
-- evaluate_period_group()) for one (method_id, period_key), field by
-- field, and returns EVERY comparison made — matches included, not just
-- mismatches — so the output is reviewable as a complete record, per the
-- task brief, not a bare pass/fail assertion.
--
-- The two shapes are deliberately not structurally identical (that is
-- design §3.1's whole point), so this cannot be a generic recursive-diff
-- walk — it has to know the field mapping explicitly. Numeric
-- comparisons tolerate a half-cent to absorb independent rounding paths
-- that can each legitimately round a boundary value either way.
create or replace function diff_evaluator_output(p_method_id text, p_period_key text default null)
returns jsonb
language plpgsql
security invoker
stable
set search_path = public, pg_temp
as $$
declare
  v_has_rules boolean;
  v_window int;
  v_period_key text := p_period_key;
  v_old jsonb;
  v_new jsonb;
  v_group jsonb := null;
  v_checks jsonb := '[]'::jsonb;
  v_match boolean := true;
  v_old_active boolean;
  v_new_active boolean;
begin
  select has_rules, aggregation_window into v_has_rules, v_window
  from payment_methods where id = p_method_id;
  if not found then
    return jsonb_build_object('method_id', p_method_id, 'error', 'unknown payment method');
  end if;
  if not v_has_rules then
    return jsonb_build_object('method_id', p_method_id, 'note',
      'not a rules-engine method (has_rules = false) — nothing to diff');
  end if;

  -- Resolve to one concrete period_key up front so both sides are
  -- compared for the exact same period even when p_period_key was left
  -- null — resolving it twice (once per side, independently) would race
  -- across a period boundary in principle, however unlikely in practice.
  if v_period_key is null then
    v_period_key := card_current_period_key(p_method_id);
  end if;

  v_old := card_period_status(p_method_id, v_period_key);
  v_new := evaluate_period(p_method_id, v_period_key);

  v_old_active := coalesce((v_old ->> 'active')::boolean, true);
  v_new_active := coalesce((v_new ->> 'active')::boolean, true);

  v_checks := v_checks || jsonb_build_array(jsonb_build_object(
    'field', 'active', 'old', v_old_active, 'new', v_new_active, 'match', v_old_active = v_new_active
  ));
  if v_old_active <> v_new_active then
    v_match := false;
  end if;

  if (v_old ? 'error') or (v_new ? 'error') then
    v_checks := v_checks || jsonb_build_array(jsonb_build_object(
      'field', 'error', 'old', v_old -> 'error', 'new', v_new -> 'error',
      'match', (v_old ? 'error') = (v_new ? 'error')
    ));
    if (v_old ? 'error') <> (v_new ? 'error') then
      v_match := false;
    end if;
    return jsonb_build_object(
      'method_id', p_method_id, 'period_key', v_period_key,
      'old', v_old, 'new', v_new, 'new_group', v_group,
      'match', v_match, 'checks', v_checks
    );
  end if;

  if not v_old_active or not v_new_active then
    -- Inert-card guard on both sides — nothing further to compare, this
    -- IS the check (Citi's short-circuit, preserved).
    return jsonb_build_object(
      'method_id', p_method_id, 'period_key', v_period_key,
      'old', v_old, 'new', v_new, 'new_group', v_group,
      'match', v_match, 'checks', v_checks
    );
  end if;

  if v_window is not null then
    v_group := evaluate_period_group(p_method_id, v_period_key);
  end if;

  -- spend / txn_count
  v_checks := v_checks || jsonb_build_array(jsonb_build_object(
    'field', 'spend', 'old', v_old -> 'spend', 'new', v_new -> 'spend' -> 'total',
    'match', abs(coalesce((v_old ->> 'spend')::numeric, 0) - coalesce((v_new -> 'spend' ->> 'total')::numeric, 0)) <= 0.005
  ));
  v_checks := v_checks || jsonb_build_array(jsonb_build_object(
    'field', 'txn_count', 'old', v_old -> 'txn_count', 'new', v_new -> 'spend' -> 'txn_count',
    'match', coalesce((v_old ->> 'txn_count')::int, 0) = coalesce((v_new -> 'spend' ->> 'txn_count')::int, 0)
  ));

  -- reward_accrued (raw, pre-crediting)
  v_checks := v_checks || jsonb_build_array(jsonb_build_object(
    'field', 'reward_accrued', 'old', v_old -> 'reward_accrued', 'new', v_new -> 'reward_accrued',
    'match', abs(coalesce((v_old ->> 'reward_accrued')::numeric, 0) - coalesce((v_new ->> 'reward_accrued')::numeric, 0)) <= 0.005
  ));

  -- cap_remaining / cap_exhausted (only when old actually has a cap)
  if v_old ? 'cap_amount' and (v_old -> 'cap_amount') is not null then
    v_checks := v_checks || jsonb_build_array(jsonb_build_object(
      'field', 'cap_remaining', 'old', v_old -> 'cap_remaining', 'new', v_new -> 'cap' ->> 'remaining',
      'match', abs(coalesce((v_old ->> 'cap_remaining')::numeric, 0) - coalesce((v_new -> 'cap' ->> 'remaining')::numeric, 0)) <= 0.005
    ));
    v_checks := v_checks || jsonb_build_array(jsonb_build_object(
      'field', 'cap_exhausted', 'old', v_old -> 'cap_exhausted', 'new', v_new -> 'cap' -> 'exhausted',
      'match', coalesce((v_old ->> 'cap_exhausted')::boolean, false) = coalesce((v_new -> 'cap' ->> 'exhausted')::boolean, false)
    ));
  end if;

  -- at_risk
  v_checks := v_checks || jsonb_build_array(jsonb_build_object(
    'field', 'at_risk', 'old', v_old -> 'at_risk', 'new', v_new -> 'at_risk' -> 'value',
    'match', coalesce((v_old ->> 'at_risk')::boolean, false) = coalesce((v_new -> 'at_risk' ->> 'value')::boolean, false)
  ));

  -- gates[] / gate_cleared: old exposes one aggregate boolean (v_gate_ok,
  -- ANDed across however many gate rows the card has — 0007 lines 406-414
  -- / 955-960); new exposes the per-row detail in gates[] plus nothing
  -- pre-aggregated, so aggregate it here the same way old did (bool_and,
  -- vacuously true when there are no gate rows, matching v_gate_ok's
  -- `:= true` initial value). Not every card has a gate row at all — HSBC
  -- has none, hence no `gate_cleared` field in old's output — so this is
  -- skipped, not defaulted, when old has nothing to compare against.
  -- Previously this evaluator's gates[] output was exercised by every
  -- fixture case QA tried without ever actually being asserted on by
  -- this harness.
  if v_old ? 'gate_cleared' then
    declare
      v_new_gates_cleared boolean;
    begin
      select bool_and(coalesce((g ->> 'cleared')::boolean, false)) into v_new_gates_cleared
      from jsonb_array_elements(coalesce(v_new -> 'gates', '[]'::jsonb)) g;
      v_new_gates_cleared := coalesce(v_new_gates_cleared, true);
      v_checks := v_checks || jsonb_build_array(jsonb_build_object(
        'field', 'gate_cleared', 'old', v_old -> 'gate_cleared', 'new', to_jsonb(v_new_gates_cleared),
        'match', coalesce((v_old ->> 'gate_cleared')::boolean, true) = v_new_gates_cleared
      ));
    end;
  end if;

  -- tier_hit / gap_to_next (only when a tier track exists — uob_one)
  if v_new -> 'reward_tracks' is not null and jsonb_path_exists(v_new -> 'reward_tracks', '$[*] ? (@.kind == "tier")') then
    declare
      v_new_tier_track jsonb;
      v_new_current jsonb;
      v_old_tier_hit jsonb := v_old -> 'tier_hit';
    begin
      select track into v_new_tier_track
      from jsonb_array_elements(v_new -> 'reward_tracks') track
      where track ->> 'kind' = 'tier' limit 1;

      select elem into v_new_current
      from jsonb_array_elements(v_new_tier_track -> 'thresholds') elem
      where (elem ->> 'is_current_tier')::boolean = true limit 1;

      v_checks := v_checks || jsonb_build_array(jsonb_build_object(
        'field', 'tier_hit',
        'old', v_old_tier_hit,
        'new', case when v_new_current is not null
          then jsonb_build_object('threshold', v_new_current -> 'value', 'payout', v_new_current -> 'payout')
          else null end,
        'match', coalesce((v_old_tier_hit ->> 'threshold')::numeric, -1) = coalesce((v_new_current ->> 'value')::numeric, -1)
              and coalesce((v_old_tier_hit ->> 'payout')::numeric, -1) = coalesce((v_new_current ->> 'payout')::numeric, -1)
      ));
      v_checks := v_checks || jsonb_build_array(jsonb_build_object(
        'field', 'gap_to_next', 'old', v_old -> 'gap_to_next', 'new', v_new_tier_track -> 'gap_to_next',
        'match', abs(coalesce((v_old ->> 'gap_to_next')::numeric, 0) - coalesce((v_new_tier_track ->> 'gap_to_next')::numeric, 0)) <= 0.005
      ));
    end;
  end if;

  -- Citi's crediting split
  if v_old ? 'credited' then
    v_checks := v_checks || jsonb_build_array(jsonb_build_object(
      'field', 'credited', 'old', v_old -> 'credited', 'new', v_new -> 'crediting' -> 'credited',
      'match', abs(coalesce((v_old ->> 'credited')::numeric, 0) - coalesce((v_new -> 'crediting' ->> 'credited')::numeric, 0)) <= 0.005
    ));
    v_checks := v_checks || jsonb_build_array(jsonb_build_object(
      'field', 'accrued_uncredited', 'old', v_old -> 'accrued_uncredited', 'new', v_new -> 'crediting' -> 'accrued_uncredited',
      'match', abs(coalesce((v_old ->> 'accrued_uncredited')::numeric, 0) - coalesce((v_new -> 'crediting' ->> 'accrued_uncredited')::numeric, 0)) <= 0.005
    ));
  end if;

  -- UOB's quarterly group
  if v_window is not null and v_old ? 'quarter' then
    -- Group MEMBERSHIP — the actual list of member period_keys, in
    -- order. This is the one check whose absence let the anchor-aligned
    -- quarter-stride bug (see this migration's header) through
    -- undetected: every other check below compares a downstream
    -- computed verdict, which happens to agree between the two engines
    -- far more often than the member list itself does once the windows
    -- actually diverge (e.g. it still agreed for the anchor-unknown
    -- trailing-window path this harness had only ever been run against
    -- before an anchor was set). Comparing the raw member list catches
    -- the divergence directly, at its source, rather than waiting for it
    -- to (sometimes) surface downstream in forfeited/still_achievable.
    declare
      v_old_members jsonb;
      v_new_members jsonb;
    begin
      select jsonb_agg(m ->> 'period_key' order by ord) into v_old_members
      from jsonb_array_elements(v_old -> 'quarter' -> 'quarter_months') with ordinality as t(m, ord);
      select jsonb_agg(m -> 'period' ->> 'key' order by ord) into v_new_members
      from jsonb_array_elements(v_group -> 'members') with ordinality as t(m, ord);
      v_checks := v_checks || jsonb_build_array(jsonb_build_object(
        'field', 'group.members', 'old', v_old_members, 'new', v_new_members,
        'match', v_old_members is not distinct from v_new_members
      ));
    end;
    v_checks := v_checks || jsonb_build_array(jsonb_build_object(
      'field', 'group.grouping', 'old', v_old -> 'quarter' -> 'grouping', 'new', v_group -> 'grouping',
      'match', (v_old -> 'quarter' ->> 'grouping') is not distinct from (v_group ->> 'grouping')
    ));
    v_checks := v_checks || jsonb_build_array(jsonb_build_object(
      'field', 'group.anchor_unknown', 'old', v_old -> 'quarter' -> 'anchor_unknown', 'new', v_group -> 'anchor_unknown',
      'match', (v_old -> 'quarter' ->> 'anchor_unknown') is not distinct from (v_group ->> 'anchor_unknown')
    ));
    v_checks := v_checks || jsonb_build_array(jsonb_build_object(
      'field', 'group.forfeited', 'old', v_old -> 'quarter' -> 'forfeited', 'new', v_group -> 'forfeited',
      'match', (v_old -> 'quarter' ->> 'forfeited') is not distinct from (v_group ->> 'forfeited')
    ));
    v_checks := v_checks || jsonb_build_array(jsonb_build_object(
      'field', 'group.still_achievable_tier', 'old', v_old -> 'quarter' -> 'still_achievable_tier', 'new', v_group -> 'still_achievable_tier',
      'match', coalesce((v_old -> 'quarter' -> 'still_achievable_tier' ->> 'threshold')::numeric, -1) = coalesce((v_group -> 'still_achievable_tier' ->> 'threshold')::numeric, -1)
            and coalesce((v_old -> 'quarter' -> 'still_achievable_tier' ->> 'payout')::numeric, -1) = coalesce((v_group -> 'still_achievable_tier' ->> 'payout')::numeric, -1)
    ));
    v_checks := v_checks || jsonb_build_array(jsonb_build_object(
      'field', 'group.confirmed_tier', 'old', v_old -> 'quarter' -> 'confirmed_tier', 'new', v_group -> 'confirmed_tier',
      'match', coalesce((v_old -> 'quarter' -> 'confirmed_tier' ->> 'threshold')::numeric, -1) = coalesce((v_group -> 'confirmed_tier' ->> 'threshold')::numeric, -1)
            and coalesce((v_old -> 'quarter' -> 'confirmed_tier' ->> 'payout')::numeric, -1) = coalesce((v_group -> 'confirmed_tier' ->> 'payout')::numeric, -1)
    ));
  end if;

  select bool_and(coalesce((c ->> 'match')::boolean, false)) into v_match
  from jsonb_array_elements(v_checks) c;
  v_match := coalesce(v_match, true);

  return jsonb_build_object(
    'method_id', p_method_id, 'period_key', v_period_key,
    'old', v_old, 'new', v_new, 'new_group', v_group,
    'match', v_match, 'checks', v_checks
  );
end;
$$;

comment on function diff_evaluator_output(text, text) is
  'Standalone, reusable differential-testing artifact — WP1''s own
   acceptance gate before card_period_status() is ever repointed, and the
   exact callable WP7''s validator is expected to reuse rather than
   reimplement comparison logic (design/plan.md''s WP8 note). Returns
   every field compared, matches included, not just mismatches — meant to
   be read, not just asserted on. Not granted to anon/authenticated: an
   internal build/QA tool, called via service_role or direct SQL, not a
   dashboard RPC surface.';

-- ============ GRANTS AND RLS — same posture, new function names ============
-- Per design/rules-engine.md §3.2 and 0007/0008's established pattern:
-- PostgreSQL auto-grants EXECUTE to PUBLIC on function creation
-- independent of any named-role revoke (0007's own DEFENCE IN DEPTH
-- section found this the hard way; SETUP_STATUS.md's security notes flag
-- it as having bitten this codebase twice already). Revoke from PUBLIC
-- and grant to authenticated explicitly for every new function name.
-- diff_evaluator_output is deliberately NOT granted to authenticated —
-- see its own comment above.
--
-- card_period_status() and card_dashboard_status() are NOT touched here:
-- they are unmodified by this migration (still dispatching to the old
-- per-card functions) and their existing 0008 grants are untouched and
-- sufficient — restating them would be a no-op, not a fix for anything
-- this migration could have broken.

revoke execute on function evaluate_period(text, text) from public;
revoke execute on function evaluate_period_group(text, text) from public;
revoke execute on function diff_evaluator_output(text, text) from public;

grant execute on function evaluate_period(text, text) to authenticated;
grant execute on function evaluate_period_group(text, text) to authenticated;
-- diff_evaluator_output: no grant to authenticated or anon, by design.

revoke all on method_conditions from anon, authenticated, public;
