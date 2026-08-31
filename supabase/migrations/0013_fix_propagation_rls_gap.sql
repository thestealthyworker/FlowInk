-- Fix propagate_merchant_classification() (0010): it has never actually
-- worked for bank-sourced transactions, only manually-entered ones.
--
-- WHY THIS EXISTS
--
-- 0010's trigger runs `security invoker` — deliberately, to match this
-- project's default posture of never running triggers/functions with
-- elevated privilege. But that means its own `update transactions set
-- category = ... where merchant_id = new.id` executes AS the calling
-- role (authenticated, when triggered by a dashboard triage action) and
-- is therefore subject to RLS on transactions. 0008's UPDATE policy on
-- transactions is scoped to `source = 'manual'` only:
--
--   create policy "operator updates manual transactions" on transactions
--     for update to authenticated
--     using (is_operator() and source = 'manual')
--     with check (is_operator() and source = 'manual');
--
-- So the trigger's UPDATE silently matches zero rows for every
-- alert/statement-sourced transaction — no error, no log, just a no-op.
-- Confirmed live: 11 transactions across 2 real merchants had a category
-- that no longer matched their own (already-triaged) merchant's category
-- — 7 source='alert', 4 source='statement', 0 source='manual'. The exact
-- RLS boundary the manual-only policy draws is the exact set of rows this
-- trigger has never been able to touch. Discovered via the operator
-- reporting a triaged "Grab" merchant (category='transport', confirmed)
-- whose own transactions still showed category='other' in the dashboard.
--
-- THE FIX
--
-- This project already has one deliberate, documented exception to
-- "never security definer": is_operator() itself (0008, "THE ONE
-- DEVIATION"). This trigger fits the identical justification. It cannot
-- be used to edit anything arbitrary — it only ever copies a value the
-- operator already approved (the merchant's own category/is_transfer,
-- set via the existing, RLS-gated merchant-triage UPDATE) onto that same
-- merchant's own transactions. It never reads or writes anything else,
-- and direct EXECUTE stays revoked from every role exactly as 0010 left
-- it — this function is only ever meant to fire as a trigger side effect
-- of a merchants UPDATE that already passed its own RLS check, never to
-- be called directly.

create or replace function propagate_merchant_classification()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
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

-- Trigger definition itself is unchanged (still fires after update of
-- category, is_transfer on merchants) — only the function's privilege
-- mode changed, so no drop/recreate of the trigger object is needed. This
-- is a plain `create or replace function` under the same signature and
-- owner (the migration role), which Postgres accepts as an in-place swap.

revoke execute on function propagate_merchant_classification() from public;
revoke execute on function propagate_merchant_classification() from anon, authenticated;

-- Same one-off reconciliation 0010 ran, re-run now that the trigger can
-- actually reach these rows. No-op for source='manual' rows (already
-- correct) and for any category/is_transfer pair that already matches.
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
