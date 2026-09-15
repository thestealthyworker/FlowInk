-- Distinct calendar months that have at least one transaction, for the
-- dashboard's month selector (components/home/MonthSelector.tsx).
--
-- A view rather than a client-side `select calendar_month from
-- transactions` plus de-duplication: PostgREST caps every response at the
-- project's max-rows setting (1000 by default on hosted Supabase), so a
-- plain fetch silently stops returning rows once the ledger grows past
-- that, and the selector would quietly lose whole months with no error.
-- DISTINCT keeps the response to one row per month.
--
-- security_invoker = true for the same reason as spend_transactions
-- (0001): the view runs as the caller, so transactions' own RLS ("operator
-- reads transactions", 0008) governs it and a non-operator sees no months.
-- Every row counts, transfers and reconciled statement rows included —
-- this answers "did anything happen in this month", not "how much was
-- spent".
create view transaction_calendar_months
  with (security_invoker = true) as
  select distinct calendar_month
  from transactions;

revoke all on transaction_calendar_months from anon;
grant select on transaction_calendar_months to authenticated;
