-- UOB One card: set the statement close day now that real evidence exists.
--
-- 0002_seed.sql seeded uob_one with cycle_day = null and a comment marking
-- it "UNKNOWN. Set from a real statement before Phase 3." We now have four
-- real UOB One statements (the backfill extraction set):
--   MAY2026 statement_date = 2026-05-15
--   JUNE2026 statement_date = 2026-06-15
--   JUL2026 statement_date = 2026-07-15
--   AUG2026 statement_date = 2026-08-16
--
-- Three of four land on the 15th. The fourth (August) is one day later
-- because 2026-08-15 falls on a Saturday — UOB, like every SG bank, rolls
-- a weekend/holiday close date to the next business day. The nominal
-- (contractual) close day is 15; the calendar just doesn't always cooperate.
--
-- cycle_day is a single fixed integer (payment_methods.cycle_day, 1-31) —
-- there is no way to encode "15, except when that's a Saturday" in this
-- column. 15 is the correct value to store: it is the day the other three
-- of four real statements actually closed on, and scripts/lib/period.py /
-- supabase/functions/_shared/period.ts's `resolve_period_key` already
-- treats a day *equal to* cycle_day as still belonging to the closing
-- statement (`d.day > cycle_day` rolls forward, not `>=`) — the same rule
-- a non-shifted 15th-of-the-month close needs.
--
-- This is a separate migration from 0004_retired_cards.sql, not folded
-- into it: 0004 is a fully audited, already-reviewed migration about a
-- different payment method (dbs_posb_platinum) with its own detailed
-- justification comment. Mixing an unrelated column update for uob_one
-- into it would force re-review of an unchanged migration and blur two
-- independent audit trails. See scripts/backfill_statements.py's dry-run
-- report / the task handoff notes for the one-transaction business-day-
-- shift edge case this value does NOT resolve (UOB AUG2026, "INTERESTS",
-- 2026-08-16 — falls on cycle_day + 1, so a fixed cycle_day=15 assumption
-- assigns it to 2026-09 instead of the 2026-08 statement it is actually
-- printed in). That is a known, reported limitation of a single fixed
-- cycle_day column, not a bug in this migration.

update payment_methods
set cycle_day = 15
where id = 'uob_one';
