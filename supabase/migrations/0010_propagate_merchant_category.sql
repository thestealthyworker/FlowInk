-- Propagate merchant classification changes to their transactions.
--
-- WHY THIS EXISTS
--
-- `transactions.category` and `transactions.is_transfer` are denormalised
-- copies of the owning merchant's values, written once at ingest time
-- (see supabase/functions/ingest-alerts/index.ts and
-- scripts/backfill_statements.py). Nothing kept them in sync afterwards.
--
-- That made merchant triage silently ineffective. On 2026-08-26 the operator
-- worked through the triage table and reclassified the recurring merchants —
-- most significantly `BUS MRT SINGAPORE`, 34 transactions, from `other` to
-- `transport`. `merchants.category` was updated correctly and the triage UI
-- reported success, but every spend query reads `transactions.category`, so
-- the dashboard still showed S$50 of transport instead of S$725, and `other`
-- still showed 43.4% of spend instead of 23.1%. 131 transactions were stale.
-- Nothing errored. The work simply had no effect on any number the operator
-- would ever look at.
--
-- This is the same class of defect the build spec warns about throughout:
-- a silent divergence that produces a confident wrong number. Fixing the rows
-- once is not enough — the next triage session would reintroduce it.
--
-- The trigger is the right home for this rather than the application layer,
-- because there are three writers with different runtimes: the dashboard
-- (browser, under RLS), ingest-alerts (Deno Edge Function, service_role), and
-- the Python backfill loader (GitHub Actions, service_role). Enforcing it in
-- any one of them leaves the other two able to reintroduce the drift.
--
-- `is_transfer` is propagated for the same reason and is arguably more
-- important: it decides whether spend counts at all (§4 — PayLah top-ups and
-- P2P must be excluded, or the budget double-counts). Marking a merchant as
-- "transfer, not spend" in triage must actually remove its transactions from
-- spend totals.

create or replace function propagate_merchant_classification()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  -- Only touch rows that actually disagree, so a no-op merchant update
  -- (e.g. confirming a category that was already correct) does not rewrite
  -- hundreds of transaction rows for nothing.
  if new.category is distinct from old.category then
    update transactions
       set category = new.category
     where merchant_id = new.id
       and category is distinct from new.category;
  end if;

  if new.is_transfer is distinct from old.is_transfer then
    update transactions
       set is_transfer = new.is_transfer
     where merchant_id = new.id
       and is_transfer is distinct from new.is_transfer;
  end if;

  return new;
end;
$$;

drop trigger if exists merchants_propagate_classification on merchants;

create trigger merchants_propagate_classification
  after update of category, is_transfer on merchants
  for each row
  execute function propagate_merchant_classification();

-- The dashboard calls this implicitly via its UPDATE on merchants, so it needs
-- no separate grant — a trigger function runs as part of the triggering
-- statement. Explicitly revoke direct EXECUTE anyway: Postgres auto-grants it
-- to PUBLIC on function creation, a hole this project has already hit twice
-- (0007_rules_engine.sql and 0008_dashboard_rls.sql).
revoke execute on function propagate_merchant_classification() from public;
revoke execute on function propagate_merchant_classification() from anon, authenticated;

-- One-off reconciliation for any drift predating this trigger. This is a
-- no-op on a database where the 2026-08-26 manual fix already ran, and
-- correct on any that has not.
update transactions t
   set category = m.category
  from merchants m
 where t.merchant_id = m.id
   and t.category is distinct from m.category;

update transactions t
   set is_transfer = m.is_transfer
  from merchants m
 where t.merchant_id = m.id
   and t.is_transfer is distinct from m.is_transfer;
