-- Seed data verified against official issuer T&Cs, August 2026.
-- See docs/cardledger-build-spec.md §5 for citations and discrepancy notes.
-- Re-verify against a live statement before production — rates change
-- without notice and this is a point-in-time snapshot.

-- ============ PAYMENT METHODS ============

insert into payment_methods
  (id, display_name, issuer, last4, method_type, period_type, cycle_day, reward_type, has_rules) values
  ('uob_one',       'UOB One',           'UOB',  '1111', 'credit_card', 'statement', null, 'cashback', true),
  ('hsbc_revo',     'HSBC Revolution',   'HSBC', '2222', 'credit_card', 'calendar',  null, 'miles',    true),
  ('paylah',        'DBS PayLah!',       'DBS',  '3333', 'wallet',      'calendar',  null, null,       false);
  -- uob_one cycle_day: UNKNOWN. Set from a real statement before Phase 3. Blocks period_key
  -- resolution for UOB until then — see rules-engine TODO in supabase/functions.

-- citi_cashback: card not yet issued. Staged inactive rather than omitted,
-- because the STAGED method_rules rows below (valid_from '2099-01-01')
-- carry a `not null references payment_methods(id)` foreign key and would
-- otherwise fail to insert. active=false, last4=null, cycle_day=null keep
-- the staged-not-live intent explicit and machine-checkable.
--
-- Everything downstream — ingest routing by last4, the rules engine, the
-- dashboard — must treat active=false as "not live" and never resolve an
-- alert or apply a rule against this row. The partial unique index on
-- payment_methods(issuer, last4) in 0001_schema.sql only applies to
-- active rows, so this staged row will not collide with the real one
-- inserted on card issuance.
--
-- On issuance: `update payment_methods set active = true, last4 = '####',
-- cycle_day = ## where id = 'citi_cashback';` and add the Gmail sender to
-- the Payments/Citi filter.
insert into payment_methods
  (id, display_name, issuer, last4, method_type, period_type, cycle_day, reward_type, has_rules, active) values
  ('citi_cashback', 'Citi Cash Back', 'Citi', null, 'credit_card', 'statement', null, 'cashback', true, false);

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
-- Confirmed from real alert samples. Everything else starts as 'guessed'.

insert into merchants (match_pattern, display_name, category, hsbc_eligible, is_transfer, confidence) values
  ('TIKTOK SHOP',  'TikTok Shop',   'online',  true,  false, 'guessed'),
  ('CHRONO24',     'Chrono24',      'retail',  true,  false, 'guessed');
