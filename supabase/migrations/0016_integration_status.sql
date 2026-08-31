-- WP3 · optional-integration detection. See design/optional-integrations.md
-- "Detection: one settings/status source, not five ad hoc checks".
--
-- A stranger who has configured only Supabase must get a working, honest
-- app, not a stack of crashes and blank screens. That requires the
-- dashboard to KNOW which optional integrations (Gmail, Anthropic,
-- healthchecks.io, statement-PDF ingestion) are actually configured,
-- without the dashboard itself holding any of their secrets — it only
-- ever authenticates with the publishable key + RLS (0008's own framing).
--
-- This table is that one status source. Written by the background jobs
-- that DO hold the relevant secrets (heartbeat, an Edge Function, for
-- gmail/anthropic/healthchecks; ingest_statements.py, a GitHub Actions
-- script, for statement_ingestion) using the service_role key, which
-- bypasses RLS the same way every other write path in this system does.
-- Read by the dashboard as the operator, same pattern as every other
-- read-only table in 0008_dashboard_rls.sql.
--
-- One row per integration, upserted in place (never appended) — this is
-- current status, not a history/audit log. `key` is constrained to the
-- known, small set this design names so a typo in a writer doesn't
-- silently create an orphan row the dashboard never reads.

create table integration_status (
  key         text primary key
                check (key in ('gmail', 'anthropic', 'healthchecks', 'statement_ingestion')),
  configured  boolean not null,
  detail      text,
  checked_at  timestamptz not null default now()
);

alter table integration_status enable row level security;
alter table integration_status force row level security;
-- Same default-deny-then-explicit-grant posture as every table in
-- 0001_schema.sql / 0008_dashboard_rls.sql.
revoke all on integration_status from anon, authenticated, public;

-- ============ READ SURFACE ============
-- Operator-only, exactly like every other read policy in
-- 0008_dashboard_rls.sql. is_operator() is defined there.

grant select on integration_status to authenticated;

create policy "operator reads integration_status" on integration_status
  for select to authenticated
  using (is_operator());

-- No INSERT/UPDATE/DELETE grant to authenticated: this table is written
-- exclusively by the service-role jobs named above, which bypass RLS by
-- construction (service_role is not subject to these policies at all) —
-- the same reasoning 0001_schema.sql gives for why the base schema ships
-- with no write policies for Edge Functions / GitHub Actions.

-- No seed rows: an empty table is the correct starting state for a fresh
-- deployment (heartbeat and ingest_statements.py have not run yet), and
-- the dashboard treats "no row for this key" the same as "not configured"
-- — see dashboard/lib/data/integration-status.ts.
