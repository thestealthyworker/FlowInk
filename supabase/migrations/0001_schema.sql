-- FlowInk schema. See docs/architecture.md §4 for design notes.
--
-- Card rules live in the database as data (method_rules), never in code.
-- A rate change is an UPDATE, not a deploy.
--
-- RLS is enabled default-deny on every table at creation time, per
-- docs/architecture.md §10. No policies are added here: Edge
-- Functions and GitHub Actions write with the service_role key, which
-- bypasses RLS by design. Phase 5 adds auth.uid()-scoped SELECT policies
-- for the dashboard.

-- ============ TIMEZONE ============
-- System is Singapore-only (§3: statement rollovers, HSBC's calendar-month
-- cap reset on the 1st, UOB's quarterly gate). Postgres defaults to UTC.
-- Set the database default so anything that omits an explicit zone lands
-- on the right calendar day.
--
-- THIS IS NOT SUFFICIENT ON ITS OWN. Every Phase 3 rules-engine function
-- and every date-boundary calculation MUST STILL compute "today"
-- explicitly as (now() at time zone 'Asia/Singapore')::date rather than
-- relying on this default. A session-level SET, a connection pooler that
-- resets timezone per connection, or a future migration/tool that runs
-- with its own client timezone can all silently reintroduce UTC. Between
-- 00:00 and 07:59 SGT, an unqualified current_date is a day behind —
-- exactly the window this system's own 2-minute cron runs through.
alter database postgres set timezone to 'Asia/Singapore';

-- ============ CONFIG ============

-- Fixed category vocabulary (§4). Repeated verbatim on every column that
-- stores a category rather than centralised in a domain, so the
-- constraint is visible at each call site and does not depend on a
-- shared type surviving unmodified. Keep all four lists below in sync if
-- the vocabulary ever changes.
--   groceries, dining, petrol, commute, transport, bills, online, retail,
--   healthcare, household, other

-- Generalised: not every payment method is a rewards card.
-- PayLah is a wallet with no rules, but its spend is essential to the budget.
create table payment_methods (
  id            text primary key,           -- 'uob_one','citi_cashback','hsbc_revo','paylah'
  display_name  text not null,
  issuer        text not null,
  last4         text,                       -- routing key: present in every alert email
  method_type   text not null check (method_type in ('credit_card','wallet','bank','cash')),
  period_type   text not null check (period_type in ('calendar','statement')),
  cycle_day     int check (cycle_day is null or cycle_day between 1 and 31),  -- statement close day, null if calendar
  reward_type   text check (reward_type in ('cashback','miles')),  -- null for wallets
  has_rules     boolean not null default true,  -- false for PayLah: budget only, no optimisation
  active        boolean not null default true
);

-- At most one *active* method per physical card. Staged/inactive rows
-- (e.g. citi_cashback before issuance, see 0002_seed.sql) are exempt so a
-- config can be staged ahead of the real last4 without colliding with a
-- future live row, and so a retired card's last4 can be reused.
create unique index on payment_methods (issuer, last4) where active and last4 is not null;

alter table payment_methods enable row level security;
alter table payment_methods force row level security;

-- Tiered/threshold rules. Only for methods where has_rules = true.
create table method_rules (
  id            bigserial primary key,
  method_id     text not null references payment_methods(id),
  rule_type     text not null check (rule_type in
                  ('min_spend','tier','category_rate','cap','txn_count','quarterly_gate')),
  categories    text[] check (
                  categories is null or categories <@ array[
                    'groceries','dining','petrol','commute','transport',
                    'bills','online','retail','healthcare','household','other'
                  ]::text[]
                ),                          -- null = applies to all
  threshold     numeric,                    -- min spend / tier entry point
  rate          numeric,                    -- 0.08 = 8%, or mpd for miles
  cap_amount    numeric,                    -- max reward per period
  payout        numeric,                    -- fixed quarterly payout if applicable
  txn_min       int,                        -- min transaction count
  priority      int not null default 0,     -- fill order, highest first
  valid_from    date not null,
  valid_to      date,                       -- null = current
  notes         text
);

create index on method_rules (method_id, valid_from);

alter table method_rules enable row level security;
alter table method_rules force row level security;

-- ============ MERCHANTS ============
-- The piece that actually takes time. Classify once, reuse forever.
-- Created before transactions: transactions.merchant_id references it.

create table merchants (
  id            bigserial primary key,
  match_pattern text not null unique check (length(match_pattern) >= 3),
                                             -- normalised substring. Minimum length guards
                                             -- against a punctuation-only or near-empty
                                             -- pattern becoming a global catch-all that
                                             -- matches every merchant.
  display_name  text not null,
  category      text not null check (category in (
                  'groceries','dining','petrol','commute','transport',
                  'bills','online','retail','healthcare','household','other'
                )),
  known_mcc     text,
  hsbc_eligible boolean,                    -- confirmed 4 mpd category; null = unknown, never assume
  is_transfer   boolean not null default false,  -- known P2P recipients, PayLah top-ups
  confidence    text not null default 'guessed',  -- 'guessed'|'confirmed'
  created_at    timestamptz not null default now()
);

alter table merchants enable row level security;
alter table merchants force row level security;

-- ============ LEDGER ============

create type txn_status as enum ('provisional','confirmed','disputed','reversed');
create type txn_source as enum ('alert','statement','manual');

create table transactions (
  id              uuid primary key default gen_random_uuid(),
  method_id       text not null references payment_methods(id),
  txn_date        date not null,
  posted_date     date,
  merchant_raw    text not null,            -- exactly as received
  merchant_id     bigint references merchants(id),
  amount          numeric(12,2) not null check (amount > 0),  -- SGD, positive = spend
  currency        text not null default 'SGD',
  fx_amount       numeric(12,2),
  mcc             text,                     -- rarely available, nullable
  category        text check (category is null or category in (
                    'groceries','dining','petrol','commute','transport',
                    'bills','online','retail','healthcare','household','other'
                  )),                       -- resolved via merchant_id
  is_transfer     boolean not null default false,  -- P2P / top-up, exclude from spend totals
  status          txn_status not null default 'provisional',
  source          txn_source not null,
  source_ref      text,                     -- Gmail message id / statement file
  period_key      text not null,            -- card period, e.g. 'uob_one:2026-09'. See §3: statement
                                             -- month for UOB/Citi, calendar month for HSBC — never
                                             -- assume calendar months here.
  calendar_month  text not null,            -- 'YYYY-MM' of txn_date. Budgets and spend analysis
                                             -- (§4, §10) always run on this, never on period_key —
                                             -- the two are stored separately and never collapsed.
  reconciled_with uuid references transactions(id),
  created_at      timestamptz not null default now(),
  unique (method_id, source, source_ref),   -- idempotency
  -- source_ref must be present for every alert/statement row. Postgres
  -- treats NULL as distinct from NULL, so two NULL source_ref rows never
  -- collide against the unique constraint above and duplicates would
  -- silently pass through. Only 'manual' entries (Telegram triage
  -- corrections, cash) may legitimately have no source_ref.
  check (source = 'manual' or source_ref is not null)
);

create index on transactions (method_id, period_key);
create index on transactions (calendar_month, category);  -- primary-goal query: category spend by month
create index on transactions (txn_date);
create index on transactions (merchant_id);                -- unindexed FK: merchant leaderboard, triage
create index on transactions (status) where status = 'provisional';

alter table transactions enable row level security;
alter table transactions force row level security;

-- ============ BUDGETS ============
-- Primary goal. Calendar-month based, independent of card statement cycles.

create table budgets (
  id          bigserial primary key,
  category    text not null check (category in (
                'groceries','dining','petrol','commute','transport',
                'bills','online','retail','healthcare','household','other'
              )),
  period      text not null,                -- '2026-09', or 'default'
  monthly_cap numeric(12,2) not null,
  alert_at    numeric not null default 0.8 check (alert_at > 0 and alert_at <= 1),  -- warn at 80%
  unique (category, period)
);

alter table budgets enable row level security;
alter table budgets force row level security;

-- ============ INGEST STATE ============
-- Watermark pattern shared by all ingest jobs. See §7.

create table ingest_state (
  stream     text primary key,        -- 'alerts','statements'
  watermark  bigint not null,         -- Gmail internalDate, epoch ms
  updated_at timestamptz not null default now()
);

alter table ingest_state enable row level security;
alter table ingest_state force row level security;

-- ============ PARSE FAILURES ============
-- Never insert an unvalidated row: rejects and hard-fail parses land here
-- instead. See §8.

create table parse_failures (
  id           bigserial primary key,
  source_ref   text unique not null,      -- Gmail message id
  raw_body     text not null,
  model_output text,
  reason       text not null,
  resolved     boolean not null default false,
  created_at   timestamptz not null default now()
);

alter table parse_failures enable row level security;
alter table parse_failures force row level security;

-- ============ SPEND VIEW ============
-- Encapsulates the anti-double-counting rule (§9, §14): once a
-- statement-sourced row has been matched to the alert-sourced row it
-- confirms (JOB-3 sets reconciled_with), the statement row restates spend
-- already counted via the alert row and must drop out of every spend
-- total. Left to each caller, this rule was on track to be reimplemented
-- by hand in the rules engine, the nudge job and the dashboard — one
-- omission double-counts every reconciled transaction.
--
-- security_invoker = true is required. A plain view is owned by the
-- migration role (postgres) and would execute with that owner's
-- privileges, bypassing RLS on the underlying transactions table
-- entirely — the single most likely way this system's security gets
-- broken later. With security_invoker, the view runs as the querying
-- role and RLS applies exactly as if the caller queried transactions
-- directly.
--
-- Note: this view does not filter is_transfer. That is a distinct rule
-- (PayLah P2P sends and top-ups are not spend, §4) — callers building
-- spend totals still need "and not is_transfer" on top of this view.
create view spend_transactions
  with (security_invoker = true) as
select *
from transactions
where not (source = 'statement' and reconciled_with is not null);

-- ============ SECURITY: DEFENCE IN DEPTH ============
-- Phase 5 owns RLS policies; nothing above adds one, so every table is
-- default-deny until then. The grants below are a separate control: they
-- ensure that a mistake in a later migration — e.g. a Phase 3 rules-engine
-- function created SECURITY DEFINER and owned by postgres — is not
-- silently reachable over PostgREST at /rest/v1/rpc/<fn> or
-- /rest/v1/<table> before Phase 5 makes a deliberate, auditable grant.
revoke execute on all functions in schema public from anon, authenticated;
revoke all on all tables in schema public from anon, authenticated;

-- Extends the same posture to objects created by future migrations
-- (Phase 3's rules engine) that the REVOKE above, run today, cannot see.
alter default privileges in schema public revoke execute on functions from anon, authenticated;
