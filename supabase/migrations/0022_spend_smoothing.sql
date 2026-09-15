-- Spend smoothing: represent a lump-sum payment (an annual subscription,
-- a yearly tax or insurance bill) as a flat monthly figure across N
-- months, for reporting only. The source transaction is never touched —
-- it keeps its real amount, real date, real status, exactly as ingested or
-- entered. This table is purely an overlay: "for the smoothed KPI and the
-- subscriptions tracker, also count 1/N of this transaction's amount in
-- each of N consecutive calendar months starting at start_month." Every
-- existing spend total (Command Center KPIs, budgets, trends) is computed
-- exactly as it already was — untouched by this table's existence — and
-- the smoothed figure is a second, separately labelled number, never a
-- silent replacement (the same "never blend a derived number into a real
-- one" rule the confirmed/provisional split follows throughout the
-- dashboard).
--
-- Deliberately a sidecar table, not a column on `transactions`: bank-
-- sourced rows are immutable from the browser by design
-- (0008_dashboard_rls.sql, "operator updates manual transactions" — only
-- source='manual' rows are ever UPDATE-able), and an annual subscription
-- charge or a yearly bill is exactly the kind of row that is usually
-- bank-sourced, not manual. A sidecar table needs no exception to that
-- rule: it only ever writes its own rows, never `transactions` itself.
create table spend_smoothing (
  id              bigserial primary key,
  transaction_id  uuid not null references transactions(id) on delete cascade,
  label           text not null,
  start_month     text not null check (start_month ~ '^\d{4}-\d{2}$'),
  months          int not null check (months between 2 and 60),
  is_subscription boolean not null default true,
  created_at      timestamptz not null default now(),
  unique (transaction_id)
);

comment on table spend_smoothing is
  'Overlay only -- never mutates transactions. A row here means: for
   reporting, spread transaction_id''s amount evenly across `months`
   consecutive calendar months starting at start_month, instead of
   counting it all in the month it actually posted. is_subscription
   marks which of these are recurring services (surfaced in the
   subscriptions tracker, with an end-month callout) vs one-off lump sums
   like a yearly tax bill (smoothed for the KPI, but not a subscription
   that is going to renew).';

alter table spend_smoothing enable row level security;
alter table spend_smoothing force row level security;

-- Same posture as budgets (0008_dashboard_rls.sql "operator manages
-- budgets"): operator-managed, full CRUD, no ownership scoping beyond
-- is_operator() — a single-operator system, like every other write
-- surface the dashboard owns. anon gets nothing; the explicit revoke is
-- belt-and-braces alongside 0020's default-privileges change, in case
-- this migration is ever applied to a project where that default was
-- reset.
revoke all on spend_smoothing from anon;
grant select, insert, update, delete on spend_smoothing to authenticated;
-- id is bigserial; INSERT needs USAGE on its backing sequence, which
-- table-level grants do not imply (same note as budgets_id_seq).
revoke all on sequence spend_smoothing_id_seq from anon;
grant usage, select on sequence spend_smoothing_id_seq to authenticated;

create policy "operator manages spend_smoothing" on spend_smoothing
  for all to authenticated
  using (is_operator())
  with check (is_operator());
