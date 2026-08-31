-- Phase 3: the rules engine. See docs/cardledger-build-spec.md §9 (rules
-- engine), §3 (the period trap), §5 (seed data + "rules that do not fit
-- the table"). §7 JOB-4 was the original consumer this was built against;
-- the Telegram nudge it described has since been dropped from the
-- project in favour of the Phase 5 web dashboard — see the note further
-- down on what that does and does not change here.
--
-- HARD CONSTRAINT (§9): "The model may parse and classify; it must never
-- decide whether a threshold was met." Everything below is deterministic
-- SQL / PL/pgSQL. No network call, no LLM, in this file.
--
-- Every function is `security invoker` (never `security definer`) per the
-- 0001_schema.sql defence-in-depth comment: a security definer function
-- owned by postgres would run with postgres's privileges regardless of
-- who calls it, which is exactly the kind of RLS bypass that comment
-- warns about. No anon/authenticated grant is added here, and none
-- should ever be — see the DEFENCE IN DEPTH section at the end of this
-- file for a correction to how that is actually enforced (0001's own
-- revoke statement turned out to be insufficient on its own).
--
-- Consumer: originally written for the JOB-4 nudge Edge Function via the
-- service_role client, which bypasses RLS/grants entirely and so was
-- unaffected either way. The Telegram nudge has since been dropped from
-- this project (warnings now render in the Phase 5 web dashboard
-- instead) — every function below is unchanged by that, since none of
-- them assumed a particular caller. The dashboard becomes the consumer,
-- querying through its authenticated session once Phase 5 adds RLS and
-- an explicit per-function execute grant to `authenticated` (neither
-- exists yet, deliberately — see DEFENCE IN DEPTH).
--
-- Every "today" and period-boundary calculation below computes SGT
-- explicitly as (now() at time zone 'Asia/Singapore')::date — see the
-- 0001_schema.sql timezone comment for why the database default alone is
-- not sufficient. Nothing here uses a bare now() or current_date.
--
-- ============ WHY THREE CARD-SPECIFIC FUNCTIONS, NOT ONE GENERIC ONE
-- ============
-- method_rules (§4) stores five generic rule_type rows (min_spend, tier,
-- category_rate, cap, txn_count) shared across cards, and the natural
-- instinct is a single evaluator that walks them uniformly. That breaks
-- down here for reasons the spec itself calls out in §5's "Rules that do
-- not fit the table and must live in engine code":
--   - UOB's cap is a REWARD ceiling in dollars of cashback ("cap on ALL
--     additional cashback combined"). HSBC's cap is a SPEND ceiling in
--     dollars of eligible spend ("first S$1,000 of eligible spend ...
--     spend beyond earns base rate") — same column (cap_amount), two
--     different units. Silently treating them the same way would produce
--     a wrong number for one of the two cards.
--   - HSBC's rate is mpd (miles per dollar, best-partner-equivalent), not
--     a cashback percentage. UOB's tier reward is a flat quarterly dollar
--     PAYOUT, not a rate at all (§5: "the 3.33% figure is derived, not
--     stored"). Citi's reward has a crediting quirk (S$10 blocks, no
--     credit below S$50) with no analogue on the other two cards.
--   - UOB alone has the cross-month, all-or-nothing quarterly gate (§3).
-- Card-specific functions (uob_month_status, hsbc_month_status,
-- citi_month_status) each still read their thresholds/rates/caps/payouts
-- from method_rules at query time — "a rate change is an UPDATE, not a
-- deploy" (§4) still holds — but the ARITHMETIC SHAPE differs per card by
-- design, per the spec's own section, not by omission here. A single
-- dispatcher (card_period_status) gives every caller the one uniform
-- entry point §9 asks for: `{spend, txn_count, tier_hit, reward_accrued,
-- cap_remaining, gap_to_next, days_left, at_risk}` plus card-specific
-- extras (documented per function below).
--
-- ============ TWO GENUINE GAPS IN THE SEED SCHEMA, RESOLVED BELOW ============
-- Both are called out explicitly in the task and in §5/§9 as things that
-- must not be silently guessed:
--
--   1. UOB's quarter anchor. §3/§5: quarters are three consecutive
--      statement months anchored to the CARD'S APPROVAL DATE, not
--      calendar quarters. That date is not stored anywhere in the schema
--      (§13 item 6 lists it as still unresolved, unlike items 2 and 4
--      which are struck through as done). Added below:
--      payment_methods.quarter_anchor_date, nullable, unset for uob_one.
--      uob_quarter_status() checks for it and, while it is null, falls
--      back to a clearly-labelled trailing-3-statement-month window
--      instead of guessing an anchor — see that function's comment.
--
--   2. HSBC's EGA (enhanced tier) balance flag. §5: "Whether the 8 mpd
--      tier applies depends on a bank balance the ingest pipeline has no
--      access to. Default to the standard S$1,000/4 mpd cap unless the
--      operator manually flags EGA eligibility for that month." There was
--      nowhere to record that flag. Added below: method_rules.requires_ega
--      (marks which of the two already-seeded hsbc_revo category_rate/cap
--      row pairs is the enhanced one) and a new hsbc_ega_months table
--      (operator-set, one row per calendar month the operator confirms
--      eligibility for; absence of a row = not eligible, the safe
--      default). Both are genuinely new, not a workaround.

-- ============ SCHEMA ADDITIONS ============

alter table payment_methods
  add column quarter_anchor_date date;

comment on column payment_methods.quarter_anchor_date is
  'First day of the first statement month of this card''s first
   UOB-style quarter (three consecutive statement months), per §3/§5.
   Only meaningful for period_type = ''statement'' cards with a
   cross-month quarterly gate (currently uob_one). NULL means unknown —
   §13 item 6 lists the real approval date as still unresolved at
   handoff. uob_quarter_status() must not guess this; while it is NULL it
   falls back to an explicitly-labelled trailing-window approximation
   (grouping = ''anchor_unknown_trailing_window'') rather than silently
   assuming a boundary that may not match the bank''s real one. Set this
   once the account approval date (or first statement''s period-1 start)
   is confirmed, mirroring how uob_one.cycle_day sat NULL until a real
   statement fixed it (0002_seed.sql / 0005_uob_one_cycle_day.sql).';

alter table method_rules
  add column requires_ega boolean not null default false;

comment on column method_rules.requires_ega is
  'True only for the two hsbc_revo rows that require the operator-set EGA
   (Everyday Global Account, >=S$50,000 sole balance) condition: the 8 mpd
   category_rate row (priority 25) and its S$1,200 cap row (priority 5).
   Every other row, on every card, defaults false and is unaffected. See
   §5 "HSBC''s EGA balance condition" and hsbc_ega_months below — this
   column identifies WHICH rows are gated; that table records WHETHER the
   gate is open for a given month. Without both, hsbc_month_status() would
   have no way to tell the 8 mpd rows from the 4 mpd rows other than
   guessing from cap_amount/rate, which breaks the moment either value is
   updated for a rate change.';

update method_rules
  set requires_ega = true
  where method_id = 'hsbc_revo' and rule_type = 'category_rate' and priority = 25;

update method_rules
  set requires_ega = true
  where method_id = 'hsbc_revo' and rule_type = 'cap' and priority = 5;

-- Operator-set monthly EGA flag. Absence of a row for a given
-- (method_id, calendar_month) means "not eligible" — the safe default
-- per §5. Nothing in the ingest pipeline ever writes to this table; only
-- an operator (or a future dashboard control) does.
create table hsbc_ega_months (
  method_id      text not null references payment_methods(id),
  calendar_month text not null check (calendar_month ~ '^\d{4}-\d{2}$'),
  ega_active     boolean not null default true,
  note           text,
  updated_at     timestamptz not null default now(),
  primary key (method_id, calendar_month)
);

comment on table hsbc_ega_months is
  'Operator-set flag: was the >=S$50,000 sole-account EGA balance
   condition met in this calendar month, for this HSBC card? §5:
   "unknowable from alert data ... default to the standard cap unless the
   operator manually flags EGA eligibility." No row = not eligible.';

alter table hsbc_ega_months enable row level security;
alter table hsbc_ega_months force row level security;
-- No policies added, same as every other table at creation (0001_schema.sql):
-- default-deny until Phase 5 makes a deliberate auth.uid()-scoped grant.
-- RLS force + no policy already makes this table unreachable by
-- anon/authenticated; the blanket function/table revokes below and in
-- 0001_schema.sql are additional, not load-bearing, defence in depth.

-- ============ SGT "TODAY" HELPER ============
-- Single place that implements the non-negotiable timezone rule (see
-- file header). Every function below computes today's date via this
-- helper rather than repeating the expression, so there is exactly one
-- place to audit.
create or replace function sgt_today()
returns date
language sql
security invoker
stable
set search_path = public, pg_temp
as $$
  select (now() at time zone 'Asia/Singapore')::date;
$$;

-- ============ PERIOD RESOLUTION ============
-- §9 step 1: "Resolve the period key from a transaction date and the
-- card's period_type/cycle_day." Behaviourally identical to
-- supabase/functions/_shared/period.ts and scripts/lib/period.py (kept
-- in sync there for the ingest path) — this is the SQL-side copy for the
-- rules engine to resolve "what period is today in, for this card"
-- without a round trip through Edge Function code. Uses date_trunc month
-- arithmetic, not day-of-month arithmetic, for the same reason
-- period.ts's own comment gives: naive "add 1 to the month, keep the
-- day" arithmetic overflows on month-end dates (2026-01-31 + "1 month"
-- must not become 2026-03-03).
create or replace function card_period_key(p_method_id text, p_txn_date date)
returns text
language sql
security invoker
stable
set search_path = public, pg_temp
as $$
  select case
    when pm.period_type = 'calendar' then
      p_method_id || ':' || to_char(p_txn_date, 'YYYY-MM')
    when pm.cycle_day is null then
      -- Matches period.ts: cycle_day unknown, do not guess. See §5 and
      -- 0002_seed.sql's original "UNKNOWN. Set from a real statement
      -- before Phase 3" note (resolved for uob_one in 0005, but this
      -- branch stays general for any future statement-period card whose
      -- cycle_day is not yet known, e.g. citi_cashback pre-issuance).
      p_method_id || ':pending'
    when extract(day from p_txn_date)::int > pm.cycle_day then
      p_method_id || ':' || to_char(date_trunc('month', p_txn_date) + interval '1 month', 'YYYY-MM')
    else
      p_method_id || ':' || to_char(date_trunc('month', p_txn_date), 'YYYY-MM')
  end
  from payment_methods pm
  where pm.id = p_method_id;
$$;

create or replace function card_current_period_key(p_method_id text)
returns text
language sql
security invoker
stable
set search_path = public, pg_temp
as $$
  select card_period_key(p_method_id, sgt_today());
$$;

-- Period boundaries + "is this the period in progress right now" +
-- days remaining. Returns an empty result set (no row) for an unknown
-- method_id, a malformed period_key, or (for a statement-period card) an
-- unset cycle_day — callers check `if not found` / `if v_bounds is null`
-- rather than getting a wrong date range.
--
-- KNOWN LIMITATION, not fixed here (task instruction: document precisely
-- and move on rather than inventing a holiday calendar): cycle_day is a
-- single fixed integer. UOB (like every SG bank) rolls a weekend/holiday
-- statement close to the next business day — 2026-08-15 fell on a
-- Saturday and the real August statement closed 2026-08-16. A fixed
-- cycle_day=15 has no way to encode that shift, so both the ingest path
-- (period.ts / period.py, see 0005_uob_one_cycle_day.sql's detailed
-- comment) and this function assign day-16 transactions to the NEXT
-- statement month. One real loaded transaction is affected: UOB
-- 2026-08-16, "INTERESTS", S$37.51 — resolves to period_key
-- 'uob_one:2026-09' instead of the 'uob_one:2026-08' statement it is
-- actually printed on. Fixing this precisely requires an SG bank-holiday
-- calendar (which changes yearly and this system has no source for) —
-- out of scope here, exactly as 0005's comment already concluded for the
-- ingest side. This function computes period_end using the same fixed
-- cycle_day, so it stays consistent with what is actually stored in
-- transactions.period_key; it does not independently re-derive a
-- "corrected" boundary that would disagree with the data on disk.
create or replace function card_period_bounds(p_method_id text, p_period_key text)
returns table(period_start date, period_end date, is_current boolean, days_left int)
language plpgsql
security invoker
stable
set search_path = public, pg_temp
as $$
declare
  v_period_type text;
  v_cycle_day int;
  v_suffix text;
  v_year int;
  v_month int;
  v_month_first date;
  v_month_last date;
  v_start date;
  v_end date;
  v_today date := sgt_today();
begin
  select period_type, cycle_day into v_period_type, v_cycle_day
  from payment_methods where id = p_method_id;
  if not found then
    return;
  end if;

  v_suffix := split_part(p_period_key, ':', 2);
  if v_suffix !~ '^\d{4}-\d{2}$' then
    return; -- covers 'pending' and any malformed key
  end if;
  v_year := split_part(v_suffix, '-', 1)::int;
  v_month := split_part(v_suffix, '-', 2)::int;
  v_month_first := make_date(v_year, v_month, 1);
  v_month_last := (v_month_first + interval '1 month - 1 day')::date;

  if v_period_type = 'calendar' then
    v_start := v_month_first;
    v_end := v_month_last;
  else
    if v_cycle_day is null then
      return;
    end if;
    -- Clamp so a cycle_day beyond the month's real length (e.g. 31 in
    -- February) lands on the month's actual last day, not an error.
    v_end := make_date(v_year, v_month, least(v_cycle_day, extract(day from v_month_last)::int));
    v_start := ((v_end - interval '1 month')::date) + 1;
  end if;

  return query select
    v_start,
    v_end,
    (p_period_key = card_current_period_key(p_method_id)),
    greatest(0, (v_end - v_today))::int;
end;
$$;

-- ============ HSBC EGA LOOKUP ============
create or replace function hsbc_ega_active(p_method_id text, p_calendar_month text)
returns boolean
language sql
security invoker
stable
set search_path = public, pg_temp
as $$
  select coalesce(
    (select ega_active from hsbc_ega_months
     where method_id = p_method_id and calendar_month = p_calendar_month),
    false
  );
$$;

-- ============ UOB ONE — per statement month ============
-- §9 evaluation order, applied to UOB's specific mechanics (§5):
--   1. period resolved via card_period_bounds (above)
--   2. spend/txn_count summed from confirmed+provisional, excluding
--      transfers and the reconciled-statement double-count (via the
--      spend_transactions view, 0001_schema.sql / 0006)
--   3. method_rules matched against valid_from/valid_to as of the
--      period's own close date (period_end), NOT today — so a past
--      period is judged by the rules that applied when it closed, even
--      if rates have since changed (§4: "a rate change is an UPDATE").
--   4. tiers highest-first (by threshold desc); category rates walked in
--      priority desc order, each row claiming whichever of its
--      categories aren't already claimed by a higher-priority row for
--      the same spend tier, decrementing the shared S$120/month
--      additional-cashback cap as it goes.
--   5. returns the §9 contract shape plus UOB-specific fields.
--
-- DOCUMENTED ASSUMPTION: the standalone txn_count gate row (10
-- transactions) and each tier row's own txn_min both require 10 posted
-- transactions for TIER qualification. The additional-cashback
-- category_rate rows carry no txn_min in the seed data (§5) — this
-- function gates them on spend threshold only, exactly as stored, rather
-- than inventing an unstated extra requirement. `gate_cleared` in the
-- returned JSON exposes the txn-count result independently so a caller
-- can see it either way; if the real T&C ties the 10-txn gate to
-- category cashback too, the fix is adding txn_min to those rows, not
-- changing this function.
--
-- CATEGORY-VS-MERCHANT CAVEAT (§6): UOB's selected-merchant/SP/Shell
-- bonuses are merchant-specific (Grab, McDonald's, Shopee, SimplyGo /
-- Singapore Power / Shell), but transactions.category is a coarse
-- 11-value bucket, not a merchant flag — there is no per-card eligibility
-- flag on `merchants` the way HSBC has `hsbc_eligible`. This function
-- matches on category (the finest dimension the schema currently
-- exposes for UOB), which will overstate reward if the 'bills' or
-- 'commute'/'transport' bucket contains non-qualifying billers or
-- non-qualifying rides that quarter. Flagged here and in the final
-- report rather than presented as exact — §5's own petrol note ("verify
-- petrol merchant code before relying on this") makes the same point.
create or replace function uob_month_status(p_period_key text default null)
returns jsonb
language plpgsql
security invoker
stable
set search_path = public, pg_temp
as $$
declare
  v_period_key text := coalesce(p_period_key, card_current_period_key('uob_one'));
  v_bounds record;
  v_as_of date;
  v_spend numeric := 0;
  v_txn_count int := 0;
  v_gate_ok boolean := true;
  v_tier_row record;
  v_tier_hit jsonb := null;
  v_gap_to_next numeric := null;
  v_cap_amount numeric;
  v_cap_remaining numeric;
  v_reward_accrued numeric := 0;
  v_claimed text[] := '{}';
  v_all_categories text[] := array[
    'groceries','dining','petrol','commute','transport',
    'bills','online','retail','healthcare','household','other'
  ];
  r record;
  v_candidate_cats text[];
  v_cat_spend numeric;
  v_row_reward numeric;
  v_applied numeric;
  v_reasons text[] := '{}';
  v_txns_needed int;
  v_spend_needed_for_gate numeric;
  v_cap_exhausted boolean;
begin
  if v_period_key like '%:pending' then
    return jsonb_build_object('method_id', 'uob_one', 'period_key', v_period_key,
      'error', 'cycle_day not set for uob_one; period cannot be resolved');
  end if;

  select * into v_bounds from card_period_bounds('uob_one', v_period_key);
  if v_bounds is null then
    return jsonb_build_object('method_id', 'uob_one', 'period_key', v_period_key,
      'error', 'invalid or unresolvable period_key');
  end if;
  v_as_of := v_bounds.period_end;

  select coalesce(sum(amount), 0), count(*) into v_spend, v_txn_count
  from spend_transactions
  where method_id = 'uob_one' and period_key = v_period_key
    and status in ('confirmed', 'provisional') and not is_transfer;

  for r in
    select txn_min from method_rules
    where method_id = 'uob_one' and rule_type = 'txn_count'
      and valid_from <= v_as_of and (valid_to is null or valid_to >= v_as_of)
  loop
    if v_txn_count < coalesce(r.txn_min, 0) then
      v_gate_ok := false;
    end if;
  end loop;

  for v_tier_row in
    select threshold, payout, txn_min from method_rules
    where method_id = 'uob_one' and rule_type = 'tier'
      and valid_from <= v_as_of and (valid_to is null or valid_to >= v_as_of)
    order by threshold desc
  loop
    if v_tier_hit is null and v_spend >= v_tier_row.threshold and v_txn_count >= coalesce(v_tier_row.txn_min, 0) then
      v_tier_hit := jsonb_build_object('threshold', v_tier_row.threshold, 'payout', v_tier_row.payout);
    elsif v_tier_hit is null and v_spend < v_tier_row.threshold then
      -- Overwritten on every unmet iteration; since rows are walked
      -- threshold-desc, the LAST overwrite before a match (or before the
      -- loop ends) is the nearest unmet tier above current spend.
      v_gap_to_next := v_tier_row.threshold - v_spend;
    end if;
  end loop;

  select cap_amount into v_cap_amount
  from method_rules
  where method_id = 'uob_one' and rule_type = 'cap'
    and valid_from <= v_as_of and (valid_to is null or valid_to >= v_as_of)
  limit 1;
  v_cap_remaining := v_cap_amount;

  for r in
    select categories, threshold, rate from method_rules
    where method_id = 'uob_one' and rule_type = 'category_rate'
      and valid_from <= v_as_of and (valid_to is null or valid_to >= v_as_of)
    order by priority desc
  loop
    if r.threshold is not null and v_spend < r.threshold then
      continue;
    end if;
    if r.categories is null then
      v_candidate_cats := array(select unnest(v_all_categories) except select unnest(v_claimed));
    else
      v_candidate_cats := array(select unnest(r.categories) except select unnest(v_claimed));
    end if;
    if array_length(v_candidate_cats, 1) is null then
      continue;
    end if;

    select coalesce(sum(amount), 0) into v_cat_spend
    from spend_transactions
    where method_id = 'uob_one' and period_key = v_period_key
      and status in ('confirmed', 'provisional') and not is_transfer
      and category = any(v_candidate_cats);

    v_row_reward := v_cat_spend * r.rate;
    v_applied := least(v_row_reward, coalesce(v_cap_remaining, v_row_reward));
    v_reward_accrued := v_reward_accrued + v_applied;
    if v_cap_remaining is not null then
      v_cap_remaining := v_cap_remaining - v_applied;
    end if;
    v_claimed := v_claimed || v_candidate_cats;
  end loop;

  -- Structured "why" for a dashboard to render without reimplementing any
  -- threshold logic in TypeScript (per the dashboard-consumption design:
  -- expose queryable reasons, not a pre-formatted message). Reasons
  -- reflect the CURRENT snapshot regardless of days_left/is_current — a
  -- caller combines this with is_current/days_left itself to decide
  -- urgency; this function does not presume how close to "risk" counts as
  -- worth surfacing.
  if v_spend < 600 then
    v_reasons := v_reasons || 'below_min_spend'::text;
  end if;
  if v_txn_count < 10 then
    v_reasons := v_reasons || 'below_txn_count'::text;
  end if;
  v_txns_needed := greatest(0, 10 - v_txn_count);
  v_spend_needed_for_gate := greatest(0, 600 - v_spend);
  v_cap_exhausted := v_cap_remaining is not null and v_cap_remaining <= 0;

  return jsonb_build_object(
    'method_id', 'uob_one',
    'period_key', v_period_key,
    'period_start', v_bounds.period_start,
    'period_end', v_bounds.period_end,
    'is_current', v_bounds.is_current,
    'days_left', v_bounds.days_left,
    'spend', round(v_spend, 2),
    'txn_count', v_txn_count,
    'gate_cleared', v_gate_ok,
    'tier_hit', v_tier_hit,
    'gap_to_next', round(coalesce(v_gap_to_next, 0), 2),
    'txns_needed', v_txns_needed,
    'spend_needed_for_gate', round(v_spend_needed_for_gate, 2),
    'cap_amount', v_cap_amount,
    'cap_unit', 'reward_sgd',
    'cap_remaining', round(v_cap_remaining, 2),
    'cap_exhausted', v_cap_exhausted,
    'reward_accrued', round(v_reward_accrued, 2),
    'reward_unit', 'cashback_sgd_additional',
    'at_risk_reasons', to_jsonb(v_reasons),
    'at_risk', v_bounds.is_current and v_bounds.days_left <= 5 and not (v_gate_ok and v_spend >= 600)
  );
end;
$$;

-- ============ UOB ONE — quarterly gate ============
-- §3/§5: quarters are three consecutive STATEMENT months anchored to card
-- approval, all-or-nothing — miss the minimum spend or txn count in any
-- one of the three and the WHOLE quarter's flat payout (S$60/100/200) is
-- forfeited. This does not degrade to "whatever lower tier the weak
-- month hit" for the OTHER months' tiers — the payout tier itself must be
-- uniformly cleared by all three months. That is what this function
-- checks: for each of the three thresholds (2000/1000/600, highest
-- first), do the three months in the quarter all clear it (and its
-- 10-txn gate)? `still_achievable_tier` is the best the quarter can still
-- land on given what has been observed so far (closed and in-progress
-- months only — future months are given the benefit of the doubt, since
-- they have no data yet); `confirmed_tier` is only populated once all
-- three months have actually closed. `forfeited` = even Tier 1 is no
-- longer achievable, i.e. a closed or in-progress month has already spent
-- and/or transacted below S$600 / 10 txns.
--
-- ANCHOR UNKNOWN (see payment_methods.quarter_anchor_date comment above):
-- while quarter_anchor_date is NULL for uob_one, this function cannot
-- know the bank's real quarter boundary and does NOT guess one. It falls
-- back to a trailing 3-statement-month window ending at the target
-- period and sets grouping = 'anchor_unknown_trailing_window' and
-- anchor_unknown = true so callers (the nudge included) can decide
-- whether to treat the payout figure as authoritative. This still gives
-- useful early-warning signal — a month that has already missed Tier 1 is
-- a real problem regardless of which exact 3-month window the bank
-- counts it in — but it is not the confirmed answer until the anchor is
-- set.
create or replace function uob_quarter_status(p_period_key text default null)
returns jsonb
language plpgsql
security invoker
stable
set search_path = public, pg_temp
as $$
declare
  v_period_key text := coalesce(p_period_key, card_current_period_key('uob_one'));
  v_bounds record;
  v_anchor date;
  v_suffix text;
  v_year int;
  v_month int;
  v_target date;
  v_months_diff int;
  v_quarter_start date;
  v_grouping text;
  v_months date[3];
  v_statuses jsonb := '[]'::jsonb;
  v_mstatus jsonb;
  v_thresholds numeric[] := array[2000, 1000, 600];
  v_thr numeric;
  v_still_achievable jsonb := null;
  v_confirmed jsonb := null;
  v_forfeited boolean;
  v_any_current_at_risk boolean;
  v_ok boolean;
  v_all_closed_ok boolean;
  v_spend numeric;
  v_txn int;
  v_is_current boolean;
  v_days_left int;
  v_closed boolean;
  v_payout numeric;
  i int;
  v_blocking_months jsonb := '[]'::jsonb;
  v_period_key_i text;
begin
  select * into v_bounds from card_period_bounds('uob_one', v_period_key);
  if v_bounds is null then
    return jsonb_build_object('method_id', 'uob_one', 'quarter_period_key', v_period_key,
      'error', 'invalid or unresolvable period_key');
  end if;

  select quarter_anchor_date into v_anchor from payment_methods where id = 'uob_one';

  v_suffix := split_part(v_period_key, ':', 2);
  v_year := split_part(v_suffix, '-', 1)::int;
  v_month := split_part(v_suffix, '-', 2)::int;
  v_target := make_date(v_year, v_month, 1);

  if v_anchor is not null then
    v_months_diff := (extract(year from v_target)::int - extract(year from v_anchor)::int) * 12
                    + (extract(month from v_target)::int - extract(month from v_anchor)::int);
    v_quarter_start := (date_trunc('month', v_anchor) + (floor(v_months_diff / 3.0)::int * interval '1 month'))::date;
    v_grouping := 'anchor_aligned';
  else
    v_quarter_start := (date_trunc('month', v_target) - interval '2 month')::date;
    v_grouping := 'anchor_unknown_trailing_window';
  end if;

  v_months := array[
    v_quarter_start,
    (v_quarter_start + interval '1 month')::date,
    (v_quarter_start + interval '2 month')::date
  ];

  for i in 1..3 loop
    v_mstatus := uob_month_status('uob_one:' || to_char(v_months[i], 'YYYY-MM'));
    v_statuses := v_statuses || jsonb_build_array(v_mstatus);
  end loop;

  foreach v_thr in array v_thresholds loop
    v_ok := true;
    v_all_closed_ok := true;
    for i in 1..3 loop
      v_mstatus := v_statuses -> (i - 1);
      if v_mstatus ? 'error' then
        -- A month in the window has no resolvable period (e.g. before
        -- the card existed) — cannot confirm or rule out any tier from
        -- it. Treat as neither pass nor fail, same as a future month.
        continue;
      end if;
      v_spend := (v_mstatus ->> 'spend')::numeric;
      v_txn := (v_mstatus ->> 'txn_count')::int;
      v_is_current := (v_mstatus ->> 'is_current')::boolean;
      v_days_left := (v_mstatus ->> 'days_left')::int;
      v_closed := (not v_is_current) and v_days_left = 0;

      -- Only a CLOSED month's shortfall is a hard, unrecoverable failure
      -- for "still achievable" — an in-progress month can still catch up
      -- before it closes, and treating today's snapshot of the current
      -- month as a forfeiting failure would falsely report the quarter
      -- as forfeited on day 1 of a new statement month, before there has
      -- been any real chance to spend. A future month (not yet started)
      -- is likewise given the benefit of the doubt. The current month's
      -- own time pressure is instead surfaced via its own `at_risk` flag
      -- (uob_month_status: true only once days_left <= 5), which feeds
      -- the quarter's `at_risk` below — so this still escalates, just not
      -- before day 1.
      if v_closed then
        if v_spend < v_thr or v_txn < 10 then
          v_ok := false;
        end if;
      end if;
      if not v_closed or v_spend < v_thr or v_txn < 10 then
        v_all_closed_ok := false;
      end if;
    end loop;
    if v_ok and v_still_achievable is null then
      v_still_achievable := jsonb_build_object('threshold', v_thr);
    end if;
    if v_all_closed_ok and v_confirmed is null then
      v_confirmed := jsonb_build_object('threshold', v_thr);
    end if;
  end loop;

  v_forfeited := v_still_achievable is null;

  -- Structured "what caused this and what it would forfeit" for a
  -- dashboard: the specific closed month(s) that failed even Tier 1
  -- (S$600 / 10 txns), the bar below which the whole quarter's payout is
  -- forfeited regardless of the other two months. Only populated when
  -- forfeited — an at-risk-but-not-yet-forfeited quarter's "why" already
  -- lives in quarter_months[*].at_risk_reasons for the in-progress month.
  if v_forfeited then
    for i in 1..3 loop
      v_mstatus := v_statuses -> (i - 1);
      if v_mstatus ? 'error' then
        continue;
      end if;
      v_spend := (v_mstatus ->> 'spend')::numeric;
      v_txn := (v_mstatus ->> 'txn_count')::int;
      v_is_current := (v_mstatus ->> 'is_current')::boolean;
      v_days_left := (v_mstatus ->> 'days_left')::int;
      v_closed := (not v_is_current) and v_days_left = 0;
      if v_closed and (v_spend < 600 or v_txn < 10) then
        v_period_key_i := v_mstatus ->> 'period_key';
        v_blocking_months := v_blocking_months || jsonb_build_array(jsonb_build_object(
          'period_key', v_period_key_i,
          'spend', v_spend,
          'txn_count', v_txn,
          'spend_short', greatest(0, 600 - v_spend),
          'txn_short', greatest(0, 10 - v_txn)
        ));
      end if;
    end loop;
  end if;

  if v_still_achievable is not null then
    select payout into v_payout from method_rules
    where method_id = 'uob_one' and rule_type = 'tier'
      and threshold = (v_still_achievable ->> 'threshold')::numeric
      and valid_from <= v_bounds.period_end and (valid_to is null or valid_to >= v_bounds.period_end)
    limit 1;
    v_still_achievable := v_still_achievable || jsonb_build_object('payout', v_payout);
  end if;
  if v_confirmed is not null then
    select payout into v_payout from method_rules
    where method_id = 'uob_one' and rule_type = 'tier'
      and threshold = (v_confirmed ->> 'threshold')::numeric
      and valid_from <= v_bounds.period_end and (valid_to is null or valid_to >= v_bounds.period_end)
    limit 1;
    v_confirmed := v_confirmed || jsonb_build_object('payout', v_payout);
  end if;

  select bool_or((s ->> 'at_risk')::boolean) into v_any_current_at_risk
  from jsonb_array_elements(v_statuses) s;

  return jsonb_build_object(
    'method_id', 'uob_one',
    'quarter_period_key', v_period_key,
    'grouping', v_grouping,
    'anchor_unknown', v_anchor is null,
    'quarter_months', v_statuses,
    'still_achievable_tier', v_still_achievable,
    'confirmed_tier', v_confirmed,
    'forfeited', v_forfeited,
    'blocking_months', v_blocking_months,
    'at_risk', v_forfeited or coalesce(v_any_current_at_risk, false),
    'approx_payout_at_stake', case when v_forfeited then null
      else (v_still_achievable ->> 'payout')::numeric end
  );
end;
$$;

-- ============ HSBC REVOLUTION — per calendar month ============
-- §5: 4 mpd standard / 8 mpd enhanced (EGA), categories {dining, retail,
-- online, commute}, base 0.4 mpd (1X) on everything else. Rate is already
-- stored as effective mpd at the 2.5:1 best-partner ratio (§5's insert
-- comment: "10 reward points per S$1 ... = 4 mpd effective") — this
-- function does not re-derive it, it just multiplies spend * rate, and
-- labels the result accordingly. §5 also notes the ratio is
-- partner-dependent (3:1 for KrisFlyer specifically, 2.5:1 for others) —
-- that conversion choice is a redemption-time decision, not something
-- this function should collapse into a single number; `reward_unit` says
-- explicitly which basis reward_accrued is on.
--
-- CAP IS A SPEND CEILING, NOT A REWARD CEILING (§5: "first S$1,000 of
-- ELIGIBLE SPEND per calendar month. Spend beyond earns base rate"). This
-- is the opposite unit from UOB/Citi's caps (dollars of cashback) — see
-- the file header note on why this isn't handled by one generic cap-walk
-- across all three cards.
--
-- HSBC's payment-method condition (contactless/online required for the
-- bonus rate on non-travel categories) is explicitly unknowable from
-- alert data per §5 — "assume bonus, correct at reconciliation, label as
-- estimate." This function does exactly that: it does not attempt to
-- infer payment method, and reward_accrued here is always an estimate
-- until reconciliation, which is out of Phase 3's scope.
create or replace function hsbc_month_status(p_period_key text default null)
returns jsonb
language plpgsql
security invoker
stable
set search_path = public, pg_temp
as $$
declare
  v_period_key text := coalesce(p_period_key, card_current_period_key('hsbc_revo'));
  v_bounds record;
  v_as_of date;
  v_calendar_month text;
  v_ega boolean;
  v_spend numeric := 0;
  v_txn_count int := 0;
  v_bonus_categories text[];
  v_bonus_rate numeric;
  v_base_rate numeric;
  v_cap_amount numeric;
  v_bonus_spend numeric := 0;
  v_base_spend numeric;
  v_capped_bonus numeric;
  v_overflow numeric;
  v_reward numeric;
  v_reasons text[] := '{}';
  v_cap_exhausted boolean;
begin
  select * into v_bounds from card_period_bounds('hsbc_revo', v_period_key);
  if v_bounds is null then
    return jsonb_build_object('method_id', 'hsbc_revo', 'period_key', v_period_key,
      'error', 'invalid or unresolvable period_key');
  end if;
  v_as_of := v_bounds.period_end;
  v_calendar_month := split_part(v_period_key, ':', 2);
  v_ega := hsbc_ega_active('hsbc_revo', v_calendar_month);

  select coalesce(sum(amount), 0), count(*) into v_spend, v_txn_count
  from spend_transactions
  where method_id = 'hsbc_revo' and period_key = v_period_key
    and status in ('confirmed', 'provisional') and not is_transfer;

  select categories, rate into v_bonus_categories, v_bonus_rate
  from method_rules
  where method_id = 'hsbc_revo' and rule_type = 'category_rate' and requires_ega = v_ega
    and valid_from <= v_as_of and (valid_to is null or valid_to >= v_as_of)
  order by priority desc limit 1;

  select cap_amount into v_cap_amount
  from method_rules
  where method_id = 'hsbc_revo' and rule_type = 'cap' and requires_ega = v_ega
    and valid_from <= v_as_of and (valid_to is null or valid_to >= v_as_of)
  order by priority desc limit 1;

  select rate into v_base_rate
  from method_rules
  where method_id = 'hsbc_revo' and rule_type = 'category_rate' and categories is null
    and valid_from <= v_as_of and (valid_to is null or valid_to >= v_as_of)
  limit 1;

  if v_bonus_categories is not null then
    select coalesce(sum(amount), 0) into v_bonus_spend
    from spend_transactions
    where method_id = 'hsbc_revo' and period_key = v_period_key
      and status in ('confirmed', 'provisional') and not is_transfer
      and category = any(v_bonus_categories);
  end if;
  v_base_spend := v_spend - v_bonus_spend;

  if v_cap_amount is not null and v_bonus_spend > v_cap_amount then
    v_capped_bonus := v_cap_amount;
    v_overflow := v_bonus_spend - v_cap_amount;
  else
    v_capped_bonus := v_bonus_spend;
    v_overflow := 0;
  end if;

  v_reward := (v_capped_bonus * coalesce(v_bonus_rate, 0))
            + (v_overflow * coalesce(v_base_rate, 0))
            + (v_base_spend * coalesce(v_base_rate, 0));

  -- HSBC has no minimum-spend/txn-count gate (§5) — nothing is ever
  -- forfeited, so the only "reason" a dashboard needs is whether there is
  -- unused bonus-rate headroom left as the month winds down. cap_exhausted
  -- is informational (further spend this month earns base rate only), not
  -- a risk in the missing-reward sense the other two cards have.
  v_cap_exhausted := v_cap_amount is not null and v_bonus_spend >= v_cap_amount;
  if v_cap_amount is not null and v_bonus_spend < v_cap_amount then
    v_reasons := v_reasons || 'unused_bonus_cap_headroom'::text;
  end if;

  return jsonb_build_object(
    'method_id', 'hsbc_revo',
    'period_key', v_period_key,
    'period_start', v_bounds.period_start,
    'period_end', v_bounds.period_end,
    'is_current', v_bounds.is_current,
    'days_left', v_bounds.days_left,
    'spend', round(v_spend, 2),
    'txn_count', v_txn_count,
    'ega_active', v_ega,
    'rate_tier', case when v_ega then 'enhanced_8mpd' else 'standard_4mpd' end,
    'bonus_categories', v_bonus_categories,
    'bonus_spend', round(v_bonus_spend, 2),
    'base_spend', round(v_base_spend, 2),
    'bonus_rate_mpd', v_bonus_rate,
    'base_rate_mpd', v_base_rate,
    'tier_hit', null,
    'cap_amount', v_cap_amount,
    'cap_unit', 'spend_sgd',
    'cap_remaining', round(greatest(coalesce(v_cap_amount, 0) - v_bonus_spend, 0), 2),
    'cap_exhausted', v_cap_exhausted,
    'gap_to_next', round(greatest(coalesce(v_cap_amount, 0) - v_bonus_spend, 0), 2),
    'reward_accrued', round(v_reward, 2),
    'reward_unit', 'miles_best_partner_equivalent_2.5to1',
    'at_risk_reasons', to_jsonb(v_reasons),
    'at_risk', v_bounds.is_current and v_bounds.days_left <= 5
               and v_cap_amount is not null and v_bonus_spend < v_cap_amount
  );
end;
$$;

-- ============ CITI CASH BACK — per statement month ============
-- §5/§9: card not yet issued (payment_methods.active = false, every
-- method_rules row staged at valid_from = '2099-01-01'). This function is
-- fully implemented — "build it, but it must be inert until a real row
-- exists" — and is doubly inert until issuance:
--   1. The active-flag guard below returns immediately with no query
--      against transactions or the staged rules at all.
--   2. Even without that guard, valid_from = '2099-01-01' means no real
--      period's as-of date will ever match those rows, so cap/rate
--      lookups would come back null and reward_accrued would compute as
--      0 regardless.
-- Both are kept: the explicit guard makes the inertness readable at the
-- top of the function rather than an emergent property of a date
-- comparison someone has to trace through.
--
-- Crediting quirk (§5, §9): "cashback accrues in S$10 blocks and is only
-- credited once accrual reaches S$50." Modelled as: round the raw
-- computed reward down to the nearest S$10 (the "block"); once that
-- blocked total reaches S$50, it is `credited`; below S$50 it is
-- `accrued_uncredited` — its own distinct state, never silently folded
-- into reward_accrued as if it were available now.
create or replace function citi_month_status(p_period_key text default null)
returns jsonb
language plpgsql
security invoker
stable
set search_path = public, pg_temp
as $$
declare
  v_active boolean;
  v_period_key text;
  v_bounds record;
  v_as_of date;
  v_spend numeric := 0;
  v_txn_count int := 0;
  v_gate_ok boolean := true;
  v_min_spend numeric;
  v_cap_amount numeric;
  v_cap_remaining numeric;
  v_reward_accrued numeric := 0;
  v_claimed text[] := '{}';
  v_all_categories text[] := array[
    'groceries','dining','petrol','commute','transport',
    'bills','online','retail','healthcare','household','other'
  ];
  r record;
  v_candidate_cats text[];
  v_cat_spend numeric;
  v_row_reward numeric;
  v_applied numeric;
  v_base_rate numeric;
  v_blocked numeric;
  v_credited numeric;
  v_uncredited numeric;
  v_reasons text[] := '{}';
  v_cap_exhausted boolean;
begin
  select active into v_active from payment_methods where id = 'citi_cashback';
  if not coalesce(v_active, false) then
    return jsonb_build_object(
      'method_id', 'citi_cashback',
      'active', false,
      'note', 'card not yet issued (§5) — inert until payment_methods.citi_cashback.active = true and a real last4 is set'
    );
  end if;

  v_period_key := coalesce(p_period_key, card_current_period_key('citi_cashback'));
  select * into v_bounds from card_period_bounds('citi_cashback', v_period_key);
  if v_bounds is null then
    return jsonb_build_object('method_id', 'citi_cashback', 'active', true, 'period_key', v_period_key,
      'error', 'invalid or unresolvable period_key');
  end if;
  v_as_of := v_bounds.period_end;

  select coalesce(sum(amount), 0), count(*) into v_spend, v_txn_count
  from spend_transactions
  where method_id = 'citi_cashback' and period_key = v_period_key
    and status in ('confirmed', 'provisional') and not is_transfer;

  select threshold into v_min_spend
  from method_rules
  where method_id = 'citi_cashback' and rule_type = 'min_spend'
    and valid_from <= v_as_of and (valid_to is null or valid_to >= v_as_of)
  limit 1;
  if v_min_spend is not null and v_spend < v_min_spend then
    v_gate_ok := false;
  end if;

  select cap_amount into v_cap_amount
  from method_rules
  where method_id = 'citi_cashback' and rule_type = 'cap'
    and valid_from <= v_as_of and (valid_to is null or valid_to >= v_as_of)
  limit 1;
  v_cap_remaining := v_cap_amount;

  select rate into v_base_rate
  from method_rules
  where method_id = 'citi_cashback' and rule_type = 'category_rate' and categories is null
    and valid_from <= v_as_of and (valid_to is null or valid_to >= v_as_of)
  limit 1;

  if v_gate_ok then
    for r in
      select categories, threshold, rate from method_rules
      where method_id = 'citi_cashback' and rule_type = 'category_rate'
        and valid_from <= v_as_of and (valid_to is null or valid_to >= v_as_of)
      order by priority desc
    loop
      if r.threshold is not null and v_spend < r.threshold then
        continue;
      end if;
      if r.categories is null then
        v_candidate_cats := array(select unnest(v_all_categories) except select unnest(v_claimed));
      else
        v_candidate_cats := array(select unnest(r.categories) except select unnest(v_claimed));
      end if;
      if array_length(v_candidate_cats, 1) is null then
        continue;
      end if;

      select coalesce(sum(amount), 0) into v_cat_spend
      from spend_transactions
      where method_id = 'citi_cashback' and period_key = v_period_key
        and status in ('confirmed', 'provisional') and not is_transfer
        and category = any(v_candidate_cats);

      v_row_reward := v_cat_spend * r.rate;
      v_applied := least(v_row_reward, coalesce(v_cap_remaining, v_row_reward));
      v_reward_accrued := v_reward_accrued + v_applied;
      if v_cap_remaining is not null then
        v_cap_remaining := v_cap_remaining - v_applied;
      end if;
      v_claimed := v_claimed || v_candidate_cats;
    end loop;
  else
    -- Gate missed: everything drops to the 0.2% base rate, per §5 — no
    -- bonus category row applies at all this statement month.
    v_reward_accrued := v_spend * coalesce(v_base_rate, 0);
    if v_cap_remaining is not null and v_reward_accrued > v_cap_remaining then
      v_reward_accrued := v_cap_remaining;
    end if;
    if v_cap_remaining is not null then
      v_cap_remaining := v_cap_remaining - v_reward_accrued;
    end if;
  end if;

  v_blocked := floor(v_reward_accrued / 10) * 10;
  if v_blocked >= 50 then
    v_credited := v_blocked;
    v_uncredited := round(v_reward_accrued - v_blocked, 2);
  else
    v_credited := 0;
    v_uncredited := v_blocked;
  end if;

  if not v_gate_ok then
    v_reasons := v_reasons || 'below_min_spend'::text;
  end if;
  v_cap_exhausted := v_cap_remaining is not null and v_cap_remaining <= 0;
  if v_cap_exhausted then
    v_reasons := v_reasons || 'cap_exhausted'::text;
  end if;

  return jsonb_build_object(
    'method_id', 'citi_cashback',
    'active', true,
    'period_key', v_period_key,
    'period_start', v_bounds.period_start,
    'period_end', v_bounds.period_end,
    'is_current', v_bounds.is_current,
    'days_left', v_bounds.days_left,
    'spend', round(v_spend, 2),
    'txn_count', v_txn_count,
    'gate_cleared', v_gate_ok,
    'min_spend', v_min_spend,
    'spend_needed_for_gate', round(greatest(coalesce(v_min_spend, 0) - v_spend, 0), 2),
    'tier_hit', null,
    'cap_amount', v_cap_amount,
    'cap_unit', 'reward_sgd',
    'cap_remaining', round(v_cap_remaining, 2),
    'cap_exhausted', v_cap_exhausted,
    'gap_to_next', round(case when v_gate_ok then 0 else greatest(v_min_spend - v_spend, 0) end, 2),
    'reward_accrued', round(v_reward_accrued, 2),
    'reward_unit', 'cashback_sgd',
    'credited', v_credited,
    'accrued_uncredited', v_uncredited,
    'at_risk_reasons', to_jsonb(v_reasons),
    'at_risk', v_bounds.is_current and v_bounds.days_left <= 5 and not v_gate_ok
  );
end;
$$;

-- ============ DISPATCHER ============
-- The single uniform entry point §9 describes, one active has_rules
-- payment method at a time. Originally written for JOB-4 (nudge); the
-- Telegram nudge/merchant-triage/webhook functions have since been
-- dropped from this project in favour of warnings rendered directly in
-- the web dashboard (Phase 5) — this function and its jsonb contract are
-- unchanged by that: the dashboard becomes the caller instead, querying
-- through its authenticated session once Phase 5 wires up RLS and an
-- explicit execute grant to `authenticated` (neither exists yet — see the
-- DEFENCE IN DEPTH section below). Nothing here reimplements threshold
-- logic in application code either way.
create or replace function card_period_status(p_method_id text, p_period_key text default null)
returns jsonb
language plpgsql
security invoker
stable
set search_path = public, pg_temp
as $$
declare
  v_has_rules boolean;
  v_result jsonb;
begin
  select has_rules into v_has_rules from payment_methods where id = p_method_id;
  if not found then
    return jsonb_build_object('method_id', p_method_id, 'error', 'unknown payment method');
  end if;
  if not v_has_rules then
    return jsonb_build_object('method_id', p_method_id, 'has_rules', false,
      'note', 'no card rules configured for this method (e.g. a wallet) — budget-only, see §4');
  end if;

  if p_method_id = 'uob_one' then
    v_result := uob_month_status(p_period_key);
    if v_result ? 'error' then
      return v_result;
    end if;
    return v_result || jsonb_build_object('quarter', uob_quarter_status(p_period_key));
  elsif p_method_id = 'hsbc_revo' then
    return hsbc_month_status(p_period_key);
  elsif p_method_id = 'citi_cashback' then
    return citi_month_status(p_period_key);
  else
    return jsonb_build_object('method_id', p_method_id,
      'error', 'no rules-engine handler implemented for this method_id');
  end if;
end;
$$;

-- ============ DASHBOARD BULK VIEW ============
-- One query for the entire card section, rather than the dashboard
-- looping card_period_status per method itself. Always reports each
-- card's CURRENT period (a dashboard "state right now" view has no use
-- for an arbitrary period_key spanning multiple differently-cycled
-- cards), filtered on has_rules only — a wallet like PayLah has nothing
-- to show here and is excluded. `active` is deliberately NOT filtered:
-- citi_cashback pre-issuance is has_rules = true but active = false, and
-- is included so the dashboard can render it as "not yet issued" (via its
-- status.active = false, the same inert guard card_period_status already
-- applies) rather than the card mysteriously being absent from the row
-- set with no explanation. A retired has_rules card, if one is ever
-- added, would surface the same way.
create or replace function card_dashboard_status()
returns table(method_id text, display_name text, status jsonb)
language plpgsql
security invoker
stable
set search_path = public, pg_temp
as $$
declare
  m record;
begin
  -- Column names qualified explicitly: the RETURNS TABLE OUT parameters
  -- above (method_id, display_name, status) are in scope as PL/pgSQL
  -- variables for the whole function body, including inside this FOR
  -- loop's query — an unqualified `display_name` here is ambiguous
  -- between the OUT parameter and payment_methods.display_name, and
  -- Postgres rejects it rather than guessing.
  for m in
    select payment_methods.id, payment_methods.display_name from payment_methods
    where payment_methods.has_rules = true
    order by payment_methods.id
  loop
    method_id := m.id;
    display_name := m.display_name;
    status := card_period_status(m.id, null);
    return next;
  end loop;
end;
$$;

-- ============ DEFENCE IN DEPTH ============
-- Belt-and-suspenders alongside the `alter default privileges` statement
-- in 0001_schema.sql — WITH ONE CORRECTION discovered while verifying
-- this migration against the live project, worth recording precisely
-- rather than silently folding into the fix:
--
-- 0001_schema.sql's statement was
--   `alter default privileges in schema public revoke execute on
--    functions from anon, authenticated;`
-- and this migration originally re-stated the same pattern
--   `revoke execute on all functions in schema public from anon,
--    authenticated;`
-- Both looked sufficient and both passed silently — until the functions
-- above were checked with has_function_privilege() against a live
-- project, which showed anon_can_exec = true and authenticated_can_exec
-- = true on EVERY function created here, in direct contradiction of the
-- comment on both statements.
--
-- The reason: PostgreSQL grants EXECUTE on a newly created function to
-- the PUBLIC pseudo-role automatically, as a built-in default independent
-- of `ALTER DEFAULT PRIVILEGES`. Every role — anon and authenticated
-- included — is implicitly a member of PUBLIC. Revoking a privilege from
-- two NAMED roles (anon, authenticated) only ever prevents an explicit
-- grant to those specific roles from being added; it does nothing to the
-- separate PUBLIC grant, so anon/authenticated kept the privilege anyway,
-- inherited via PUBLIC. This was verified by creating a disposable probe
-- function immediately after 0001-style statements were in place:
-- has_function_privilege('anon', ...) still returned true. The only
-- statement that actually closes this is one that targets PUBLIC itself:
--   `... REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;`
-- (confirmed empirically the same way — a fresh probe function created
-- after this correction returns anon_can_exec = false, service_role_can_exec
-- = true, exactly as intended).
--
-- This gap existed in 0001_schema.sql from Phase 1 but had zero practical
-- effect until now: migrations 0001-0006 created no functions at all, so
-- there was nothing for the ineffective revoke to fail to protect. This
-- migration is the first to create functions, which is what surfaced it.
-- 0001_schema.sql itself is not edited (it is already applied; correcting
-- an applied migration file after the fact invites drift between the
-- file and what actually ran) — the corrected statement is issued fresh
-- here, both as an immediate REVOKE (fixes the functions already created
-- above) and as a session-scoped ALTER DEFAULT PRIVILEGES (fixes every
-- function any FUTURE migration creates, correctly this time, superseding
-- 0001's own version of that statement for the current role going
-- forward).
--
-- Phase 5 will need to GRANT EXECUTE on specific dashboard-facing
-- functions to `authenticated` once its RLS policies exist — that grant
-- must be explicit and per-function at that point, never a blanket
-- re-opening of this revoke.
revoke execute on all functions in schema public from public;
alter default privileges in schema public revoke execute on functions from public;
revoke all on hsbc_ega_months from anon, authenticated, public;
