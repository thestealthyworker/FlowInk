-- Phase 5 gap-fill, discovered while building the dashboard's manual-entry
-- form (docs/cardledger-build-spec.md §10 AMENDMENT, §14 "cash is
-- invisible"). transactions.method_id is `not null references
-- payment_methods(id)`, and every row 0002_seed.sql inserted is a real
-- card or wallet with a real last4 — there is no payment_methods row a
-- manual (cash / bank transfer / GIRO) entry can point at.
--
-- One generic bucket, not one per manual sub-type: the amendment's own
-- framing ("any spending with no card behind it") treats cash, bank
-- transfer and GIRO as a single class for budgeting purposes — none of
-- them carry card rewards, none have a statement cycle, and splitting
-- them into multiple payment_methods rows would buy nothing the
-- transactions.merchant_raw / category fields don't already capture.
-- method_type = 'cash' is the closest fit in the existing CHECK
-- constraint (payment_methods.method_type in ('credit_card','wallet',
-- 'bank','cash')) for "no card behind it"; period_type = 'calendar' and
-- has_rules = false mirror how paylah is modelled, for the same reason:
-- budget participation only, no card-optimisation engine involvement.
insert into payment_methods
  (id, display_name, issuer, last4, method_type, period_type, cycle_day, reward_type, has_rules, active)
values
  ('manual', 'Manual entry (cash / bank / GIRO)', 'Manual', null, 'cash', 'calendar', null, null, false, true);
