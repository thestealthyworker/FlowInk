-- spend_transactions must exclude status = 'reversed' rows.
--
-- Triggered by the backfill loader's refund-handling redesign (see
-- scripts/backfill_statements.py's module docstring, "REFUND HANDLING"):
-- a merchant refund found within one statement is no longer netted out by
-- dropping BOTH the purchase and the credit row (which destroyed the
-- audit trail for a real transaction — the exact thing this project's own
-- spec calls out the statement layer as existing to preserve). Instead
-- the purchase row is kept with status = 'reversed' and only the credit
-- row is skipped. txn_status already has 'reversed' in its enum
-- (0001_schema.sql) for exactly this case.
--
-- That change only holds if every spend-total consumer actually excludes
-- status = 'reversed'. Audited both places 0004_retired_cards.sql already
-- audited for a different flag (payment_methods.active):
--
--   - supabase/functions/nudge/index.ts: both spend queries already add
--     `.neq("status", "reversed")` explicitly (lines ~30 and ~76, present
--     since before this migration) — nudge is safe today regardless of
--     this view.
--   - supabase/migrations/0001_schema.sql's `spend_transactions` view:
--     defined as `select * from transactions where not (source =
--     'statement' and reconciled_with is not null)` — it encapsulates
--     ONLY the reconciled-statement-row double-count rule. It does NOT
--     filter status at all. Its own comment explicitly leaves is_transfer
--     filtering to each caller ("this view does not filter is_transfer
--     ... callers building spend totals still need 'and not is_transfer'
--     on top of this view") — but status = 'reversed' is not comparable
--     to is_transfer: is_transfer is sometimes a deliberate inclusion
--     choice per caller (e.g. a future "transfers" report), while a
--     reversed transaction is never spend, under any view, for any
--     caller. Leaving it to each caller is exactly the failure mode the
--     view's own header comment warns about: "this rule was on track to
--     be reimplemented by hand ... one omission double-counts."
--
-- No current caller queries spend_transactions directly (grep finds only
-- comments referencing it — reconcile.py and nudge/index.ts both query
-- `transactions` directly with their own filters), so nothing is
-- double-counting spend *today*. But the view is the named, documented
-- abstraction future consumers (dashboard, merchant-triage) are expected
-- to build on, and after this backfill change a S$214.75 'reversed'
-- purchase row exists in the table for the first time (see
-- scripts/backfill_statements.py's REFUND HANDLING example). Fixing the view
-- now, rather than trusting every future caller to remember `.neq status
-- reversed` the way nudge/index.ts happens to, is the same reasoning
-- 0001_schema.sql already applied to the reconciled-row rule.
create or replace view spend_transactions
  with (security_invoker = true) as
select *
from transactions
where not (source = 'statement' and reconciled_with is not null)
  and status <> 'reversed';
