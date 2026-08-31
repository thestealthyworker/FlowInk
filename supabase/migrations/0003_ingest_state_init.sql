-- Seed the initial watermarks to "now" at migration-apply time, not
-- epoch 0.
--
-- Per docs/cardledger-build-spec.md §12 Phase 0, the Payments/* Gmail
-- filters were applied to EXISTING mail before this system goes live. An
-- epoch-0 watermark makes the first ingest tick pull every matching
-- message ever received under those labels — anything older than 90 days
-- fails the ingest validator (§8), which writes to parse_failures and, by
-- the watermark contract in §7, deliberately refuses to advance past a
-- failure. That refusal is correct for a single bad message; it is not
-- self-draining for an entire historical backlog, because every failing
-- message re-blocks the same watermark on every 2-minute tick, forever.
-- The previous comment here claimed this was self-draining. It is not —
-- that was the bug.
--
-- Seeding "now" means JOB-1's first run only sees mail that arrives after
-- this migration is applied. Backfilling older Payments/* mail (recovery
-- from an extended outage, or importing history predating go-live) is a
-- deliberate manual operation: move the watermark back by hand and
-- re-run, relying on the (method_id, source, source_ref) unique
-- constraint in 0001_schema.sql to reject duplicates on replay. It is
-- not, and must never become, something JOB-1 does automatically.
insert into ingest_state (stream, watermark) values
  ('alerts',     (extract(epoch from now()) * 1000)::bigint),
  ('statements', (extract(epoch from now()) * 1000)::bigint);
