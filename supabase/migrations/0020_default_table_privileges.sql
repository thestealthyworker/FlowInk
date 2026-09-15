-- Default table and sequence privileges: close the gap 0001 left open.
--
-- 0001 hardened FUNCTIONS for every future migration with
-- `alter default privileges in schema public revoke execute on functions
-- from anon, authenticated`, but for TABLES it only ran a one-time
-- `revoke all on all tables in schema public from anon, authenticated`,
-- which covered the tables that existed at that moment and nothing
-- created afterwards. A hosted Supabase project's default ACL grants anon
-- and authenticated full privileges (DELETE and TRUNCATE included, even
-- for the unauthenticated anon role) on every NEW table and sequence in
-- public. Every table added since 0001 (hsbc_ega_months, app_admin,
-- method_conditions, integration_status) therefore relies on RLS alone
-- to hold back whatever anon inherited — one layer, where this project's
-- own rule (0008: RLS and grants "are both required and do different
-- jobs") calls for two.

-- 1) Remove anything anon already holds on existing tables, views and
--    sequences. The dashboard never reads or writes as anon (every page
--    sits behind middleware.ts's auth gate, and /login talks only to
--    Supabase Auth, not to public tables), and the Edge Functions and
--    GitHub Actions jobs use the service role, so nothing depends on
--    these privileges.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;

-- 2) Close the gap at the source so no future migration has to remember
--    it. Scoped exactly like 0001's function default: ALTER DEFAULT
--    PRIVILEGES binds only objects created by the role running this
--    migration (see 0018's note on the same limitation), which is the
--    role every migration in this directory runs as. authenticated is
--    included deliberately — every table this project adds grants its own
--    explicit, minimal privileges to authenticated (0008, 0022), so
--    removing the broad implicit default cannot break an existing surface;
--    it only stops future tables inheriting DELETE and TRUNCATE nobody
--    asked for. Existing authenticated grants are untouched.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
