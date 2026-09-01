-- WP7 QA follow-up, Fix 4: txn_min = 0 is a degenerate, always-cleared
-- gate, not a real requirement. evaluate_period()/evaluate_period_group()
-- (0015_generic_rules_engine.sql) read every txn_min via
-- coalesce(txn_min, 0) — a row with txn_min = 0 behaves IDENTICALLY to
-- one with txn_min left null, while still looking to a human reviewer
-- like a real "at least 0 transactions" requirement was intentionally
-- set. scripts/lib/rules_validator.py's schema stage now rejects it for
-- WP7's own AI-authored path (see that module's _rule_schema_issues), but
-- this migration's own trigger (method_rules_validate(), 0018) previously
-- only rejected txn_min < 0 — leaving a gap for any OTHER writer of this
-- table (an operator's hand-edit via edit_method_rule(), a future script,
-- direct SQL under an operator session) to still write the same
-- degenerate value with nothing catching it. This migration closes that
-- gap at the one place every INSERT/UPDATE on method_rules already goes
-- through, matching this codebase's own "layered checks, not a single
-- point of trust" convention (see 0018's header on why the Python
-- validator sits ON TOP of this trigger rather than replacing it).
--
-- Every other line of method_rules_validate() is unchanged from 0018 —
-- see that migration for the full history of each check.
create or replace function method_rules_validate()
returns trigger
language plpgsql
as $$
begin
  if new.valid_from is null then
    raise exception 'method_rules.valid_from is required (rule id %)', coalesce(new.id, -1);
  end if;
  if new.valid_to is not null and new.valid_to < new.valid_from then
    raise exception 'valid_to (%) is before valid_from (%)', new.valid_to, new.valid_from;
  end if;

  if new.rate is not null and new.rate <= 0 then
    raise exception 'rate must be positive, got %', new.rate;
  end if;
  if new.threshold is not null and new.threshold < 0 then
    raise exception 'threshold must not be negative, got %', new.threshold;
  end if;
  if new.cap_amount is not null and new.cap_amount <= 0 then
    raise exception 'cap_amount must be positive, got %', new.cap_amount;
  end if;
  if new.payout is not null and new.payout < 0 then
    raise exception 'payout must not be negative, got %', new.payout;
  end if;
  -- WP7 QA follow-up (this migration): was `< 0` only, which let the
  -- degenerate txn_min = 0 through — see this file's header.
  if new.txn_min is not null and new.txn_min <= 0 then
    raise exception 'txn_min must be positive, or null (0 is a degenerate always-cleared gate — coalesce(txn_min, 0) in evaluate_period() treats it identically to null), got %', new.txn_min;
  end if;
  if new.priority is null then
    new.priority := 0;
  end if;

  -- Rule-type-specific required fields. Mirrors the columns
  -- evaluate_period() (0015) actually reads for each rule_type — a row
  -- missing the field its own type needs would silently evaluate as a
  -- zero-effect no-op rather than raise, which is worse than rejecting it
  -- at write time.
  case new.rule_type
    when 'category_rate' then
      if new.rate is null then
        raise exception 'category_rate rows require rate';
      end if;
    when 'tier' then
      if new.threshold is null then
        raise exception 'tier rows require threshold';
      end if;
      if coalesce(new.reward_form, 'fixed_payout') = 'fixed_payout' and new.payout is null then
        raise exception 'tier rows require payout (or reward_form = ''rate'' with rate set)';
      end if;
    when 'cap' then
      if new.cap_amount is null then
        raise exception 'cap rows require cap_amount';
      end if;
      if new.cap_basis is null then
        raise exception 'cap rows require cap_basis (''reward'' or ''spend'') — see 0015''s comment on this column';
      end if;
    when 'min_spend' then
      if new.threshold is null then
        raise exception 'min_spend rows require threshold';
      end if;
    when 'txn_count' then
      if new.txn_min is null then
        raise exception 'txn_count rows require txn_min';
      end if;
    when 'quarterly_gate' then
      -- Legacy rule_type (0001's original CHECK constraint) never
      -- consumed by evaluate_period()/evaluate_period_group() (0015) —
      -- UOB's quarterly mechanic is driven entirely by payment_methods.
      -- aggregation_window/aggregation_anchor_date now. No type-specific
      -- requirement to enforce; accepted only because 0001's own CHECK
      -- still allows the value and this trigger does not narrow it.
      null;
    else
      -- Unreachable: method_rules_rule_type_check (0001) already
      -- restricts rule_type to the six values handled above.
      null;
  end case;

  if new.categories is not null and array_length(new.categories, 1) = 0 then
    raise exception 'categories, if provided, must be non-empty (use null for "applies to all")';
  end if;

  return new;
end;
$$;
