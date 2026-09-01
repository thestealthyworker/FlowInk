-- WP2: ingestion routing as data. design/ingestion-routing.md.
--
-- WHAT THIS REPLACES
--
-- `LABEL_TO_METHOD` and `SENDER_DOMAINS` (supabase/functions/ingest-alerts/
-- index.ts) and `DEFAULT_STATEMENT_SENDER_DOMAINS` (scripts/lib/senders.py)
-- are today three hardcoded tables in two runtimes: adding a card, fixing a
-- wrong sender domain, or renaming a Gmail label all require a source edit
-- and (for the alert path) an Edge Function redeploy — a step a stranger
-- following the AI-assisted setup path should never have to take, and one
-- that already bit this exact deployment once (docs/SETUP_STATUS.md's
-- "Traps worth remembering" §1: `label:Payments` silently matched zero
-- messages, discovered only by inspection, not by any error).
--
-- payment_methods already carries `id`, `last4`, `issuer` and is already
-- the row every routing decision resolves *to*. This migration adds the
-- *inbound* side: which Gmail label and which sender domain(s) route to
-- this row, plus the currency the rules engine and the parser both need
-- a per-method default for.
--
-- `alert_senders` / `statement_senders` are `text[]`, not a single `text`
-- column, because Citi already needs two candidate statement domains for
-- one method (senders.py's `citibank.com.sg` / `citi.com`, both unconfirmed
-- guesses kept ready for the day the real one is seen) — a single-column
-- design would force an awkward workaround the day a second real card
-- needed the same thing. The two arrays are independent (not one shared
-- "senders" column) because a bank's statement-notice sender is not
-- necessarily the same subdomain as its transaction-alert sender (HSBC:
-- alerts from notification.hsbc.com.hk, statements from hsbc.com.sg below).
--
-- NULL vs empty array, deliberately: NULL means "not yet configured" (the
-- column was never touched — citi_cashback's alert_senders below, since the
-- card is not issued and index.ts's own comment says not to guess it).
-- Both the Edge Function and Python callers must treat NULL and empty `{}`
-- identically to today's "no expected domain configured" branch: reject,
-- never silently pass. See the regression tests in
-- supabase/functions/ingest-alerts/routing_test.ts and
-- tests/test_senders.py for the explicit assertion of that behaviour.
--
-- currency: not null with a default, unlike the two array columns, because
-- every method — including ones staged before a real card is issued — has
-- an unambiguous home currency the moment it is created, whereas routing
-- config for a not-yet-live card can genuinely be "not decided yet". The
-- CHECK mirrors the ISO-4217-shape check ingest-alerts/index.ts's
-- validate() already applies to a *parsed transaction's* currency
-- (`/^[A-Z]{3}$/`) — same shape rule, now also enforced on the method's
-- declared home currency at the schema level.
alter table payment_methods
  add column alert_label      text,
  add column alert_senders    text[],
  add column statement_senders text[],
  add column currency         text not null default 'SGD' check (currency ~ '^[A-Z]{3}$');

comment on column payment_methods.alert_label is
  'Gmail label routing an alert email to this method, e.g. ''Payments/UOB''. NULL = alert-path routing not configured for this method.';
comment on column payment_methods.alert_senders is
  'Exact From-header domain(s) trusted for this method''s alert emails, e.g. ''{uobgroup.com}''. NULL or ''{}'' MUST be treated identically to "no expected domain configured": reject, never fall through as a pass. Exact match only, no substring/suffix — see ingest-alerts/index.ts''s anti-spoofing check (docs/architecture.md §5, "Routing is data, not code" — the old build spec''s "trap 3" this used to cite does not survive under that number in docs/reference-example-sg.md''s current parser-traps list).';
comment on column payment_methods.statement_senders is
  'Exact From-header domain(s) trusted for this method''s statement emails. May differ from alert_senders (statement notices often come from a different subdomain than transaction alerts, e.g. hsbc_revo below). Same NULL/empty = reject rule as alert_senders.';
comment on column payment_methods.currency is
  'ISO 4217 home currency for this method. Not the same guarantee as a parsed transaction''s currency (validate() in ingest-alerts still requires the model to state one, never assumes this default) — this is metadata about the method, not a fallback for a missing extraction.';

-- At most one method claims a given Gmail label. A NULL alert_label (not
-- yet configured) is exempt by construction — a partial unique index
-- ignores NULLs, so any number of not-yet-routed methods can coexist.
create unique index payment_methods_alert_label_key
  on payment_methods (alert_label) where alert_label is not null;

-- ============ BACKFILL ============
-- Every value below is copied verbatim from the hardcoded constants it
-- replaces, so the shipped SG reference example's behaviour is unchanged
-- by this migration. Traced source of each value:
--
--   alert_label / alert_senders  <- ingest-alerts/index.ts LABEL_TO_METHOD
--                                    and SENDER_DOMAINS (pre-this-change).
--   statement_senders            <- scripts/lib/senders.py
--                                    DEFAULT_STATEMENT_SENDER_DOMAINS
--                                    (pre-this-change).
--
-- citi_cashback.alert_senders is left NULL, not populated with a guess:
-- index.ts's own comment says the confirmed sender is unknown until the
-- card is issued and explicitly warns against guessing here. Its
-- statement_senders DOES carry two guessed domains, because that guess
-- already existed in senders.py's default table before this migration —
-- this migration preserves that existing asymmetry rather than resolving
-- it; resolving it is a product decision for whoever confirms Citi's real
-- sender, not a side effect of moving the table.
--
-- dbs_posb_platinum (retired, 0004) and manual (0009) get no routing
-- columns populated: neither has a live alert or statement source, exactly
-- as today — dbs_posb_platinum is explicitly documented in 0004 as
-- reachable by neither ingest path, and manual has no email source at all.
update payment_methods set
  alert_label = 'Payments/UOB',
  alert_senders = array['uobgroup.com'],
  statement_senders = array['uobgroup.com']
where id = 'uob_one';

update payment_methods set
  alert_label = 'Payments/HSBC',
  alert_senders = array['notification.hsbc.com.hk'],
  statement_senders = array['hsbc.com.sg']
where id = 'hsbc_revo';

update payment_methods set
  alert_label = 'Payments/PayLah',
  alert_senders = array['dbs.com']
  -- statement_senders left NULL: PayLah has no statement source, today or
  -- after this migration (senders.py's DEFAULT_STATEMENT_SENDER_DOMAINS
  -- never listed it either — see reconcilable_method_ids()'s exclusion).
where id = 'paylah';

update payment_methods set
  alert_label = 'Payments/Citi',
  -- alert_senders intentionally left NULL — see comment block above.
  statement_senders = array['citibank.com.sg', 'citi.com']
where id = 'citi_cashback';
