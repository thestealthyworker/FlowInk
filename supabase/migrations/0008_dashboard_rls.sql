-- Phase 5: dashboard RLS. See docs/architecture.md §9 (dashboard as an
-- input surface, especially the amendment dated 2026-08-25 which makes
-- the dashboard a write surface, not read-only) and §10 (security model).
--
-- Every table has had RLS enabled + FORCE ROW LEVEL SECURITY since
-- 0001_schema.sql, with zero policies (default-deny) and all grants
-- revoked from anon/authenticated. This migration is the first to add
-- policies and grants — deliberately, now that the dashboard exists to
-- consume them.
--
-- ============ WHY NOT auth.uid() IS NOT NULL / auth.role() = 'authenticated' ============
--
-- Supabase's /auth/v1/signup endpoint is public and reachable with the
-- publishable key. Any policy that only checks "is this request
-- authenticated at all" grants access to every stranger who self-registers
-- an account, not just the operator. This is a single-operator system —
-- exactly one person's session should ever pass these policies — so every
-- policy below is pinned to a single auth.uid(), never to the broader
-- "authenticated" role membership alone.
--
-- ============ HOW THE OPERATOR'S UID GETS SET ============
--
-- The uid does not exist until the operator account has actually been
-- created (step 2 below), so it cannot be baked into this migration as a
-- literal (and should not be — a hardcoded uid in a versioned file is
-- exactly the kind of placeholder that ships unmodified into a template
-- and either grants access to the wrong account or, worse, to no
-- account, silently locking the operator out with no visible error).
-- Instead:
--
--   1. This migration creates an empty `app_admin` allow-list table (at
--      most one meaningful row, enforced by convention not a CHECK, since
--      Postgres does not have a max-cardinality constraint short of a
--      trigger and this is a single-operator system where a stray second
--      row is nobody's realistic failure mode) and an `is_operator()``
--      helper that every policy calls.
--   2. Create the operator account *before* ever visiting the dashboard's
--      /login page: in Supabase Studio, Authentication > Users > Add
--      user, setting an email and password directly (skip "send an
--      invite/magic link"), or via the Admin API's `createUser` method.
--      This is what puts a real row in auth.users with a real uid — the
--      dashboard's /login form calls `signInWithPassword()`, which
--      (unlike a magic link) never creates an account as a side effect,
--      and there is no sign-up UI to do that for you.
--   3. Deploy the dashboard (Task 2) and sign in with that email and
--      password at /login.
--   4. Look up that uid — Supabase Studio's Authentication > Users page
--      shows it next to the email, or query it directly:
--
--        select id, email from auth.users where email = 'YOUR_EMAIL_HERE';
--
--   5. Insert it into the allow-list, once, via the SQL editor or `psql`
--      (never via a table the dashboard itself can write, since a
--      self-service allow-list defeats the whole point):
--
--        insert into app_admin (user_id)
--        select id from auth.users where email = 'YOUR_EMAIL_HERE'
--        on conflict (user_id) do nothing;
--
-- Until step 5 runs, is_operator() returns false for every uid, including
-- the operator's own — fail-closed by construction, not fail-open. This
-- is also how a compromised or rotated auth account gets re-pointed
-- later: delete the old row, insert the new uid, no migration required.
--
-- ============ WHY is_operator() IS security definer (THE ONE DEVIATION
-- FROM THIS PROJECT'S security invoker RULE) ============
--
-- 0007_rules_engine.sql established, correctly, that every rules-engine
-- function is `security invoker`: those functions read business data
-- (transactions, method_rules) and a security definer there would let
-- any caller read that data with the function owner's privileges,
-- bypassing RLS entirely.
--
-- is_operator() is a different kind of function: it is the permission
-- check itself, not a business-data accessor. It reads exactly one small
-- allow-list table, returns a single boolean, executes a fixed query with
-- no caller-supplied SQL (no injection surface), and has its search_path
-- pinned explicitly (the classic security-definer footgun — an
-- unqualified table name resolving against a search_path the caller
-- controls — is closed by `set search_path = public, pg_temp` below).
-- `app_admin` deliberately has NO grants to anon/authenticated and NO
-- policies, so if is_operator() were security invoker instead, every RLS
-- policy that calls it would fail with permission denied for every
-- caller, including the operator — the opposite of the intended
-- fail-closed-until-configured behaviour. security definer here is
-- narrow, auditable, and is the standard Postgres/Supabase idiom for
-- exactly this "look up membership in a permissions table the caller
-- cannot read directly" pattern.

create table app_admin (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  added_at   timestamptz not null default now()
);

alter table app_admin enable row level security;
alter table app_admin force row level security;
-- No policies, no grants to anon/authenticated/public: this table is not
-- part of the dashboard's read or write surface at all. Only service_role
-- (via the SQL editor / psql, per the runbook above) touches it.
revoke all on app_admin from anon, authenticated, public;

create or replace function is_operator()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from app_admin where user_id = auth.uid());
$$;

-- Close the PostgreSQL auto-grant-to-PUBLIC hole documented at length in
-- 0007_rules_engine.sql's DEFENCE IN DEPTH section: every new function is
-- granted EXECUTE to PUBLIC automatically at creation, independent of any
-- earlier REVOKE targeting named roles. Re-stated per function here
-- rather than assumed inherited from 0007's ALTER DEFAULT PRIVILEGES,
-- since that statement is scoped to the role that issued it and this
-- migration's connecting role is not guaranteed identical — cheap
-- insurance, and it is what this project already does everywhere else.
revoke execute on function is_operator() from public;
grant execute on function is_operator() to authenticated;
-- Not granted to anon: an anonymous request has auth.uid() = null and
-- is_operator() would already evaluate to false, but there is no reason
-- for anon to be able to call it at all.

-- ============ READ SURFACE ============
-- SELECT on the tables/view the dashboard's read views need. All six are
-- scoped to is_operator() so a self-registered stranger reading their own
-- (nonexistent) data is not a distinction that matters — they read
-- nothing, ever, regardless of what they sign up as.

grant select on
  transactions,
  merchants,
  budgets,
  payment_methods,
  method_rules,
  hsbc_ega_months,
  spend_transactions
to authenticated;

create policy "operator reads transactions" on transactions
  for select to authenticated
  using (is_operator());

create policy "operator reads merchants" on merchants
  for select to authenticated
  using (is_operator());

create policy "operator reads payment_methods" on payment_methods
  for select to authenticated
  using (is_operator());

create policy "operator reads method_rules" on method_rules
  for select to authenticated
  using (is_operator());

-- hsbc_ega_months is not in the task's named read surface, but
-- card_dashboard_status() (granted below) transitively calls
-- hsbc_ega_active(), which selects from this table. Without a SELECT
-- grant + policy here, calling card_dashboard_status() as authenticated
-- would raise permission denied on hsbc_ega_months the moment it reaches
-- the hsbc_revo branch — not a hypothetical, it is unconditionally on the
-- call path since hsbc_revo has_rules = true. Read-only: writing this
-- flag (the EGA balance condition, §5) is an operator action out of
-- Phase 5's scope; absence of a row already defaults safely to "not
-- eligible" per that table's own comment in 0007.
create policy "operator reads hsbc_ega_months" on hsbc_ega_months
  for select to authenticated
  using (is_operator());

-- spend_transactions is a view with security_invoker = true (0001), so it
-- runs with the caller's own privileges against transactions and is
-- governed by the "operator reads transactions" policy above — no
-- separate policy object exists for a view, only the SELECT grant on the
-- view itself (already included above) plus the underlying table's RLS.

-- ============ WRITE SURFACE — budgets: full CRUD ============
-- Budgets are planned interactively in the dashboard (docs/architecture.md
-- §9, "Manual entry and the dashboard as an input surface"):
-- no other insertion path exists, the table is currently empty, and the
-- operator needs to create, revise and delete caps by category/period.

grant select, insert, update, delete on budgets to authenticated;
-- id is bigserial; INSERT needs USAGE on its backing sequence, which
-- table-level grants do not imply.
grant usage, select on sequence budgets_id_seq to authenticated;

create policy "operator manages budgets" on budgets
  for all to authenticated
  using (is_operator())
  with check (is_operator());

-- ============ WRITE SURFACE — transactions: INSERT + manual-only UPDATE/DELETE ============
-- docs/architecture.md §9: manual entry for non-card spend (cash, bank transfer,
-- GIRO) is the second reason the dashboard accepts input. Bank-sourced
-- history (source in ('alert','statement')) must stay immutable from the
-- browser — a bug or a hostile session must never rewrite ingested data,
-- which is the ledger's audit trail and the input to the rules engine.
--
-- INSERT is restricted to source = 'manual' in the WITH CHECK, not just
-- gated by is_operator(): without it, an authenticated session could
-- insert a row claiming source = 'statement' or 'alert' with an
-- arbitrary source_ref, forging what looks like ingested history. The
-- table's own CHECK (source = 'manual' or source_ref is not null)
-- constraint is unaffected either way; this is an additional, narrower
-- rule at the RLS layer.
--
-- UPDATE and DELETE both require source = 'manual' in USING (so a
-- bank-sourced row is not even selectable as an update/delete target) and
-- UPDATE additionally requires it in WITH CHECK (so a manual row cannot
-- be updated to claim a different source and, e.g., escape this
-- restriction's own reach going forward).

grant select, insert, update, delete on transactions to authenticated;

create policy "operator inserts manual transactions" on transactions
  for insert to authenticated
  with check (is_operator() and source = 'manual');

create policy "operator updates manual transactions" on transactions
  for update to authenticated
  using (is_operator() and source = 'manual')
  with check (is_operator() and source = 'manual');

create policy "operator deletes manual transactions" on transactions
  for delete to authenticated
  using (is_operator() and source = 'manual');

-- ============ WRITE SURFACE — merchants: category triage only ============
-- Task 4 (merchant triage table): the operator assigns a category and
-- flags "transfer, not spend" for merchants sitting at confidence =
-- 'guessed'. No other column should be reachable from the browser —
-- match_pattern in particular is the unique key every future ingest
-- lookup matches against, and a bad edit there silently misclassifies
-- every future transaction from that merchant, not just past ones.
--
-- RLS (row-level: which merchants) and a column-level GRANT (which
-- columns) are both required and do different jobs: the RLS policy alone
-- cannot restrict which columns an UPDATE touches, only which rows it may
-- target. No INSERT or DELETE policy exists for merchants at all, so both
-- remain default-deny — new merchants are created by the ingest pipeline
-- (service_role, bypasses RLS) only.

grant select on merchants to authenticated;
grant update (category, is_transfer, confidence) on merchants to authenticated;

create policy "operator updates merchant triage fields" on merchants
  for update to authenticated
  using (is_operator())
  with check (is_operator());

-- ============ RULES-ENGINE RPC ============
-- card_dashboard_status() (Task 2's card-optimisation data) and every
-- function it transitively calls. security invoker functions check the
-- EXECUTE privilege of the CALLING role at each nested call, not just at
-- the top-level RPC entry point — granting only card_dashboard_status()
-- and leaving the rest ungranted would fail with permission denied the
-- first time it calls card_period_status(), which is unconditional.
-- Full call graph, verified against 0007_rules_engine.sql directly rather
-- than assumed:
--   card_dashboard_status -> card_period_status
--   card_period_status    -> uob_month_status, uob_quarter_status,
--                             hsbc_month_status, citi_month_status
--   uob_month_status, uob_quarter_status, hsbc_month_status,
--   citi_month_status     -> card_current_period_key, card_period_bounds
--   card_current_period_key -> card_period_key, sgt_today
--   card_period_bounds    -> sgt_today
--   hsbc_month_status     -> hsbc_ega_active (reads hsbc_ega_months,
--                             granted above)
--
-- All are `security invoker` and `stable` already (0007) and untouched
-- here beyond the grant. None are granted to anon or PUBLIC: re-revoked
-- from PUBLIC explicitly first, for the same reason as is_operator()
-- above (the automatic PostgreSQL grant-to-PUBLIC-on-creation gap that
-- 0007's own DEFENCE IN DEPTH section found and fixed for the functions
-- that existed at the time this migration's connecting role last ran
-- ALTER DEFAULT PRIVILEGES — restated explicitly here rather than relied
-- upon, since none of these functions are new and the ALTER DEFAULT
-- PRIVILEGES statement only affects objects created AFTER it ran).

revoke execute on function
  sgt_today(),
  card_period_key(text, date),
  card_current_period_key(text),
  card_period_bounds(text, text),
  hsbc_ega_active(text, text),
  uob_month_status(text),
  uob_quarter_status(text),
  hsbc_month_status(text),
  citi_month_status(text),
  card_period_status(text, text),
  card_dashboard_status()
from public;

grant execute on function
  sgt_today(),
  card_period_key(text, date),
  card_current_period_key(text),
  card_period_bounds(text, text),
  hsbc_ega_active(text, text),
  uob_month_status(text),
  uob_quarter_status(text),
  hsbc_month_status(text),
  citi_month_status(text),
  card_period_status(text, text),
  card_dashboard_status()
to authenticated;

-- ============ EVERYTHING ELSE STAYS DEFAULT-DENY ============
-- ingest_state, parse_failures: no grants, no policies, not part of the
-- dashboard's surface at all. Untouched by this migration, exactly as
-- 0001_schema.sql left them.
