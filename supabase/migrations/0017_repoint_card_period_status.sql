-- WP4 Part 1: the cutover. Repoints card_period_status() from the
-- hand-written per-card dispatcher (0007_rules_engine.sql: uob_month_status
-- / uob_quarter_status / hsbc_month_status / citi_month_status) to the
-- generic evaluator (evaluate_period() / evaluate_period_group(),
-- 0015_generic_rules_engine.sql). Gated on 27c9ad5 (0015's own QA
-- follow-up): the anchor-stride deviation between the two engines'
-- quarterly-window arithmetic is now documented at length in 0015's header
-- and at evaluate_period_group()'s v_window_start assignment, and
-- diff_evaluator_output() (also 0015) now asserts on group MEMBERSHIP and
-- gate_cleared, not just downstream verdicts, closing the gap that let the
-- stride bug through undetected. Re-verified directly against this
-- migration's own target database before writing this file:
--   - anchor NULL (every seeded card, today): diff_evaluator_output()
--     clean (match = true) across uob_one/hsbc_revo/citi_cashback for
--     every period in qa-wp1's boundary fixture.
--   - anchor artificially set on uob_one (temporarily, inside a rolled-
--     back transaction, never committed): the ONLY fields that diverge are
--     group.members (and, downstream of that, group.forfeited /
--     group.still_achievable_tier for periods where the divergence flips
--     the verdict) — spend, reward_accrued, cap, gates, tier_hit and
--     gap_to_next all still match. Exactly the divergence 0015's header
--     documents (uob_one:2026-05 groups [2026-03..05] old vs [2026-05..07]
--     new; uob_one:2026-08 groups [2026-04..06] old vs [2026-08..10] new,
--     flipping forfeited from true to false), nothing else.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--   - Does NOT touch 0007_rules_engine.sql. uob_month_status,
--     uob_quarter_status, hsbc_month_status, citi_month_status,
--     hsbc_ega_active, hsbc_ega_months all stay exactly as they are —
--     alive, granted, callable — for one release cycle: a rollback path,
--     and the correctness oracle diff_evaluator_output() keeps comparing
--     against.
--   - Does NOT touch card_dashboard_status(): it already just loops
--     card_period_status() per has_rules=true method (0007) and needs no
--     change now that card_period_status()'s own body is generic.
--   - Does NOT change any grant this function already carries
--     (0008_dashboard_rls.sql: authenticated only, explicitly re-revoked
--     from PUBLIC there) — this migration only replaces the function
--     body via CREATE OR REPLACE, which does not reset an existing
--     function's ACL. The revoke/grant pair below is restated anyway, not
--     because anything is known to be wrong, but because this codebase's
--     own history (0007's DEFENCE IN DEPTH section, SETUP_STATUS.md) shows
--     the PUBLIC auto-grant-on-CREATE gap has bitten it twice already —
--     stating it explicitly here costs nothing and removes any doubt.
--     Verified empirically after applying this migration by connecting as
--     both anon and authenticated (SET ROLE, not by reading pg_proc/ACL
--     text) — see this WP's own verification notes.
--
-- WHY diff_evaluator_output() HAD TO BE REWIRED HERE (this WAS caught
-- pre-push, not shipped)
-- diff_evaluator_output() (0015) sourced its "old"/oracle side with
-- `v_old := card_period_status(p_method_id, v_period_key);` — i.e. through
-- the very function this migration repoints. Once card_period_status()
-- dispatches to the generic evaluator, that call stopped reaching 0007's
-- per-card functions at all: the harness started comparing the generic
-- evaluator against itself, and its flat-scalar parsing of the old side
-- (`v_old ->> 'spend'`, expecting a bare number) crashed outright on the
-- new nested `spend.total` shape the generic evaluator returns instead
-- (`select diff_evaluator_output('uob_one','uob_one:2026-01')` ->
-- `invalid input syntax for type numeric`). A differential harness that
-- sources both sides through the same repointable indirection stops being
-- an independent oracle at exactly the moment card_period_status() is
-- repointed — the one moment it matters most. So this migration also
-- replaces diff_evaluator_output() (CREATE OR REPLACE, same signature),
-- changing only how its "old" side is sourced: instead of calling
-- card_period_status(), it now calls 0007's uob_month_status /
-- uob_quarter_status / hsbc_month_status / citi_month_status directly,
-- reproducing inline the same if/elsif dispatch on method_id that
-- card_period_status() itself used to run before this migration (0007
-- lines ~1098-1111). Duplicating that dispatch inside the harness is
-- correct, not a shortcut: the harness's whole job is to preserve the old
-- behaviour independently of whatever card_period_status() currently
-- points at. Every other line of diff_evaluator_output() — the "new" side,
-- every field comparison, the checks it asserts — is unchanged from 0015.
-- Re-verified against qa-wp1's fixture both before and after this
-- migration applies: 30 of 31 cases match (only qa_norules — has_rules
-- true but no handler in either dispatch — diverges, by design) in both
-- runs, confirming the oracle survived the cutover rather than silently
-- starting to compare the new engine against itself.
--
-- WHAT CHANGES FOR A CALLER
-- card_period_status(method_id, period_key) now returns evaluate_period()'s
-- self-describing shape (design/rules-engine.md §3.1, as amended by
-- 27c9ad5) instead of 0007's per-card flat shape — reward_tracks[],
-- gates[], cap, crediting, has_group/aggregation_window, at_risk.value/
-- reasons, estimate_caveats[], etc., in place of the old bonus_spend/
-- gate_cleared/cap_amount/quarter-shaped fields the old dispatcher
-- returned depending on which of the three `if/elsif` branches matched.
-- Every dashboard read path that consumed the old shape is updated in this
-- same work package (WP4 Part 2) to read the new one instead — see that
-- part's own commit for the client-side follow-through; this migration
-- only changes what the database returns.
--
-- THE GROUP ASSEMBLY, SERVER-SIDE, DATA-DRIVEN
-- evaluate_period() alone never populates its own `group` key (it returns
-- it as a literal null, by design — see 0015's comment at that field) so
-- that a client never has to know out-of-band which method_ids are
-- multi-period aggregated. card_period_status() is the one place that
-- knowledge is assembled, and it does so exactly the way evaluate_period()
-- itself already tells a caller to: by reading its own `has_group` flag
-- (`payment_methods.aggregation_window is not null`, computed inside
-- evaluate_period() already, not re-queried here) rather than a hardcoded
-- `method_id = 'uob_one'` check. A future quarterly (or any other
-- multi-period) card needs zero changes to this function — only its own
-- payment_methods.aggregation_window/aggregation_anchor_date row.
--
-- The resolved period key from evaluate_period()'s OWN output
-- (`v_result -> 'period' ->> 'key'`) is passed to evaluate_period_group(),
-- not the original (possibly null) p_period_key argument — the same
-- "resolve once, use everywhere" reasoning diff_evaluator_output() itself
-- documents (0015), avoiding a race across a period boundary between two
-- independent card_current_period_key() calls.
--
-- No group assembly is attempted for any of evaluate_period()'s early-
-- return shapes (unknown method, has_rules = false, inactive, cycle_day
-- unresolved, invalid period_key) — none of them carry a `has_group` key
-- at all, so the coalesce-to-false guard below skips them without a
-- separate branch for each.
create or replace function card_period_status(p_method_id text, p_period_key text default null)
returns jsonb
language plpgsql
security invoker
stable
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
begin
  v_result := evaluate_period(p_method_id, p_period_key);

  if coalesce((v_result ->> 'has_group')::boolean, false) then
    v_result := jsonb_set(
      v_result,
      '{group}',
      evaluate_period_group(p_method_id, v_result -> 'period' ->> 'key')
    );
  end if;

  return v_result;
end;
$$;

comment on function card_period_status(text, text) is
  'Repointed (WP4 Part 1) from 0007''s hand-written if/elsif dispatcher to
   the generic evaluator (evaluate_period() + evaluate_period_group(),
   0015_generic_rules_engine.sql). Assembles `group` server-side from
   evaluate_period()''s own has_group flag — payment_methods.
   aggregation_window is not null — so no caller needs out-of-band
   knowledge of which method_ids are multi-period aggregated. 0007''s
   uob_month_status/uob_quarter_status/hsbc_month_status/citi_month_status
   remain live, granted, and untouched as the rollback path and as
   diff_evaluator_output()''s oracle for one release cycle.';

-- Defence in depth, restated rather than relied upon — see this
-- migration's header note. No-op if these grants already hold (they
-- should, from 0008_dashboard_rls.sql, since CREATE OR REPLACE does not
-- reset an existing function's ACL).
revoke execute on function card_period_status(text, text) from public;
grant execute on function card_period_status(text, text) to authenticated;

-- ============ diff_evaluator_output(): REWIRED, NOT UNTOUCHED ============
-- See this migration's header ("WHY diff_evaluator_output() HAD TO BE
-- REWIRED HERE") for the full story: 0015's version sourced its "old"
-- side via card_period_status(), which this migration just repointed to
-- the generic evaluator — so left as-is, the harness would silently
-- compare the new engine against itself (and in fact crashes outright,
-- since the old side's flat-scalar parsing chokes on the new nested
-- shape). Every line below is identical to 0015's diff_evaluator_output()
-- EXCEPT the "old" side, which now calls 0007's per-card functions
-- directly instead of going through card_period_status() — reproducing
-- inline the exact if/elsif dispatch card_period_status() itself ran
-- before this migration.
create or replace function diff_evaluator_output(p_method_id text, p_period_key text default null)
returns jsonb
language plpgsql
security invoker
stable
set search_path = public, pg_temp
as $$
declare
  v_has_rules boolean;
  v_window int;
  v_period_key text := p_period_key;
  v_old jsonb;
  v_new jsonb;
  v_group jsonb := null;
  v_checks jsonb := '[]'::jsonb;
  v_match boolean := true;
  v_old_active boolean;
  v_new_active boolean;
begin
  select has_rules, aggregation_window into v_has_rules, v_window
  from payment_methods where id = p_method_id;
  if not found then
    return jsonb_build_object('method_id', p_method_id, 'error', 'unknown payment method');
  end if;
  if not v_has_rules then
    return jsonb_build_object('method_id', p_method_id, 'note',
      'not a rules-engine method (has_rules = false) — nothing to diff');
  end if;

  -- Resolve to one concrete period_key up front so both sides are
  -- compared for the exact same period even when p_period_key was left
  -- null — resolving it twice (once per side, independently) would race
  -- across a period boundary in principle, however unlikely in practice.
  if v_period_key is null then
    v_period_key := card_current_period_key(p_method_id);
  end if;

  -- "Old" side: 0007's per-card functions, called directly — NOT via
  -- card_period_status(), which this migration repoints to the generic
  -- evaluator. This is the same if/elsif dispatch card_period_status()
  -- itself ran pre-repoint (0007_rules_engine.sql), duplicated here so the
  -- harness's oracle stays independent of whatever card_period_status()
  -- currently points at.
  if p_method_id = 'uob_one' then
    v_old := uob_month_status(v_period_key);
    if not (v_old ? 'error') then
      v_old := v_old || jsonb_build_object('quarter', uob_quarter_status(v_period_key));
    end if;
  elsif p_method_id = 'hsbc_revo' then
    v_old := hsbc_month_status(v_period_key);
  elsif p_method_id = 'citi_cashback' then
    v_old := citi_month_status(v_period_key);
  else
    v_old := jsonb_build_object('method_id', p_method_id,
      'error', 'no rules-engine handler implemented for this method_id');
  end if;

  v_new := evaluate_period(p_method_id, v_period_key);

  v_old_active := coalesce((v_old ->> 'active')::boolean, true);
  v_new_active := coalesce((v_new ->> 'active')::boolean, true);

  v_checks := v_checks || jsonb_build_array(jsonb_build_object(
    'field', 'active', 'old', v_old_active, 'new', v_new_active, 'match', v_old_active = v_new_active
  ));
  if v_old_active <> v_new_active then
    v_match := false;
  end if;

  if (v_old ? 'error') or (v_new ? 'error') then
    v_checks := v_checks || jsonb_build_array(jsonb_build_object(
      'field', 'error', 'old', v_old -> 'error', 'new', v_new -> 'error',
      'match', (v_old ? 'error') = (v_new ? 'error')
    ));
    if (v_old ? 'error') <> (v_new ? 'error') then
      v_match := false;
    end if;
    return jsonb_build_object(
      'method_id', p_method_id, 'period_key', v_period_key,
      'old', v_old, 'new', v_new, 'new_group', v_group,
      'match', v_match, 'checks', v_checks
    );
  end if;

  if not v_old_active or not v_new_active then
    -- Inert-card guard on both sides — nothing further to compare, this
    -- IS the check (Citi's short-circuit, preserved).
    return jsonb_build_object(
      'method_id', p_method_id, 'period_key', v_period_key,
      'old', v_old, 'new', v_new, 'new_group', v_group,
      'match', v_match, 'checks', v_checks
    );
  end if;

  if v_window is not null then
    v_group := evaluate_period_group(p_method_id, v_period_key);
  end if;

  -- spend / txn_count
  v_checks := v_checks || jsonb_build_array(jsonb_build_object(
    'field', 'spend', 'old', v_old -> 'spend', 'new', v_new -> 'spend' -> 'total',
    'match', abs(coalesce((v_old ->> 'spend')::numeric, 0) - coalesce((v_new -> 'spend' ->> 'total')::numeric, 0)) <= 0.005
  ));
  v_checks := v_checks || jsonb_build_array(jsonb_build_object(
    'field', 'txn_count', 'old', v_old -> 'txn_count', 'new', v_new -> 'spend' -> 'txn_count',
    'match', coalesce((v_old ->> 'txn_count')::int, 0) = coalesce((v_new -> 'spend' ->> 'txn_count')::int, 0)
  ));

  -- reward_accrued (raw, pre-crediting)
  v_checks := v_checks || jsonb_build_array(jsonb_build_object(
    'field', 'reward_accrued', 'old', v_old -> 'reward_accrued', 'new', v_new -> 'reward_accrued',
    'match', abs(coalesce((v_old ->> 'reward_accrued')::numeric, 0) - coalesce((v_new ->> 'reward_accrued')::numeric, 0)) <= 0.005
  ));

  -- cap_remaining / cap_exhausted (only when old actually has a cap)
  if v_old ? 'cap_amount' and (v_old -> 'cap_amount') is not null then
    v_checks := v_checks || jsonb_build_array(jsonb_build_object(
      'field', 'cap_remaining', 'old', v_old -> 'cap_remaining', 'new', v_new -> 'cap' ->> 'remaining',
      'match', abs(coalesce((v_old ->> 'cap_remaining')::numeric, 0) - coalesce((v_new -> 'cap' ->> 'remaining')::numeric, 0)) <= 0.005
    ));
    v_checks := v_checks || jsonb_build_array(jsonb_build_object(
      'field', 'cap_exhausted', 'old', v_old -> 'cap_exhausted', 'new', v_new -> 'cap' -> 'exhausted',
      'match', coalesce((v_old ->> 'cap_exhausted')::boolean, false) = coalesce((v_new -> 'cap' ->> 'exhausted')::boolean, false)
    ));
  end if;

  -- at_risk
  v_checks := v_checks || jsonb_build_array(jsonb_build_object(
    'field', 'at_risk', 'old', v_old -> 'at_risk', 'new', v_new -> 'at_risk' -> 'value',
    'match', coalesce((v_old ->> 'at_risk')::boolean, false) = coalesce((v_new -> 'at_risk' ->> 'value')::boolean, false)
  ));

  -- gates[] / gate_cleared: old exposes one aggregate boolean (v_gate_ok,
  -- ANDed across however many gate rows the card has — 0007 lines 406-414
  -- / 955-960); new exposes the per-row detail in gates[] plus nothing
  -- pre-aggregated, so aggregate it here the same way old did (bool_and,
  -- vacuously true when there are no gate rows, matching v_gate_ok's
  -- `:= true` initial value). Not every card has a gate row at all — HSBC
  -- has none, hence no `gate_cleared` field in old's output — so this is
  -- skipped, not defaulted, when old has nothing to compare against.
  if v_old ? 'gate_cleared' then
    declare
      v_new_gates_cleared boolean;
    begin
      select bool_and(coalesce((g ->> 'cleared')::boolean, false)) into v_new_gates_cleared
      from jsonb_array_elements(coalesce(v_new -> 'gates', '[]'::jsonb)) g;
      v_new_gates_cleared := coalesce(v_new_gates_cleared, true);
      v_checks := v_checks || jsonb_build_array(jsonb_build_object(
        'field', 'gate_cleared', 'old', v_old -> 'gate_cleared', 'new', to_jsonb(v_new_gates_cleared),
        'match', coalesce((v_old ->> 'gate_cleared')::boolean, true) = v_new_gates_cleared
      ));
    end;
  end if;

  -- tier_hit / gap_to_next (only when a tier track exists — uob_one)
  if v_new -> 'reward_tracks' is not null and jsonb_path_exists(v_new -> 'reward_tracks', '$[*] ? (@.kind == "tier")') then
    declare
      v_new_tier_track jsonb;
      v_new_current jsonb;
      v_old_tier_hit jsonb := v_old -> 'tier_hit';
    begin
      select track into v_new_tier_track
      from jsonb_array_elements(v_new -> 'reward_tracks') track
      where track ->> 'kind' = 'tier' limit 1;

      select elem into v_new_current
      from jsonb_array_elements(v_new_tier_track -> 'thresholds') elem
      where (elem ->> 'is_current_tier')::boolean = true limit 1;

      v_checks := v_checks || jsonb_build_array(jsonb_build_object(
        'field', 'tier_hit',
        'old', v_old_tier_hit,
        'new', case when v_new_current is not null
          then jsonb_build_object('threshold', v_new_current -> 'value', 'payout', v_new_current -> 'payout')
          else null end,
        'match', coalesce((v_old_tier_hit ->> 'threshold')::numeric, -1) = coalesce((v_new_current ->> 'value')::numeric, -1)
              and coalesce((v_old_tier_hit ->> 'payout')::numeric, -1) = coalesce((v_new_current ->> 'payout')::numeric, -1)
      ));
      v_checks := v_checks || jsonb_build_array(jsonb_build_object(
        'field', 'gap_to_next', 'old', v_old -> 'gap_to_next', 'new', v_new_tier_track -> 'gap_to_next',
        'match', abs(coalesce((v_old ->> 'gap_to_next')::numeric, 0) - coalesce((v_new_tier_track ->> 'gap_to_next')::numeric, 0)) <= 0.005
      ));
    end;
  end if;

  -- Citi's crediting split
  if v_old ? 'credited' then
    v_checks := v_checks || jsonb_build_array(jsonb_build_object(
      'field', 'credited', 'old', v_old -> 'credited', 'new', v_new -> 'crediting' -> 'credited',
      'match', abs(coalesce((v_old ->> 'credited')::numeric, 0) - coalesce((v_new -> 'crediting' ->> 'credited')::numeric, 0)) <= 0.005
    ));
    v_checks := v_checks || jsonb_build_array(jsonb_build_object(
      'field', 'accrued_uncredited', 'old', v_old -> 'accrued_uncredited', 'new', v_new -> 'crediting' -> 'accrued_uncredited',
      'match', abs(coalesce((v_old ->> 'accrued_uncredited')::numeric, 0) - coalesce((v_new -> 'crediting' ->> 'accrued_uncredited')::numeric, 0)) <= 0.005
    ));
  end if;

  -- UOB's quarterly group
  if v_window is not null and v_old ? 'quarter' then
    -- Group MEMBERSHIP — the actual list of member period_keys, in
    -- order. This is the one check whose absence let the anchor-aligned
    -- quarter-stride bug (see 0015's header) through undetected: every
    -- other check below compares a downstream computed verdict, which
    -- happens to agree between the two engines far more often than the
    -- member list itself does once the windows actually diverge.
    -- Comparing the raw member list catches the divergence directly, at
    -- its source, rather than waiting for it to (sometimes) surface
    -- downstream in forfeited/still_achievable.
    declare
      v_old_members jsonb;
      v_new_members jsonb;
    begin
      select jsonb_agg(m ->> 'period_key' order by ord) into v_old_members
      from jsonb_array_elements(v_old -> 'quarter' -> 'quarter_months') with ordinality as t(m, ord);
      select jsonb_agg(m -> 'period' ->> 'key' order by ord) into v_new_members
      from jsonb_array_elements(v_group -> 'members') with ordinality as t(m, ord);
      v_checks := v_checks || jsonb_build_array(jsonb_build_object(
        'field', 'group.members', 'old', v_old_members, 'new', v_new_members,
        'match', v_old_members is not distinct from v_new_members
      ));
    end;
    v_checks := v_checks || jsonb_build_array(jsonb_build_object(
      'field', 'group.grouping', 'old', v_old -> 'quarter' -> 'grouping', 'new', v_group -> 'grouping',
      'match', (v_old -> 'quarter' ->> 'grouping') is not distinct from (v_group ->> 'grouping')
    ));
    v_checks := v_checks || jsonb_build_array(jsonb_build_object(
      'field', 'group.anchor_unknown', 'old', v_old -> 'quarter' -> 'anchor_unknown', 'new', v_group -> 'anchor_unknown',
      'match', (v_old -> 'quarter' ->> 'anchor_unknown') is not distinct from (v_group ->> 'anchor_unknown')
    ));
    v_checks := v_checks || jsonb_build_array(jsonb_build_object(
      'field', 'group.forfeited', 'old', v_old -> 'quarter' -> 'forfeited', 'new', v_group -> 'forfeited',
      'match', (v_old -> 'quarter' ->> 'forfeited') is not distinct from (v_group ->> 'forfeited')
    ));
    v_checks := v_checks || jsonb_build_array(jsonb_build_object(
      'field', 'group.still_achievable_tier', 'old', v_old -> 'quarter' -> 'still_achievable_tier', 'new', v_group -> 'still_achievable_tier',
      'match', coalesce((v_old -> 'quarter' -> 'still_achievable_tier' ->> 'threshold')::numeric, -1) = coalesce((v_group -> 'still_achievable_tier' ->> 'threshold')::numeric, -1)
            and coalesce((v_old -> 'quarter' -> 'still_achievable_tier' ->> 'payout')::numeric, -1) = coalesce((v_group -> 'still_achievable_tier' ->> 'payout')::numeric, -1)
    ));
    v_checks := v_checks || jsonb_build_array(jsonb_build_object(
      'field', 'group.confirmed_tier', 'old', v_old -> 'quarter' -> 'confirmed_tier', 'new', v_group -> 'confirmed_tier',
      'match', coalesce((v_old -> 'quarter' -> 'confirmed_tier' ->> 'threshold')::numeric, -1) = coalesce((v_group -> 'confirmed_tier' ->> 'threshold')::numeric, -1)
            and coalesce((v_old -> 'quarter' -> 'confirmed_tier' ->> 'payout')::numeric, -1) = coalesce((v_group -> 'confirmed_tier' ->> 'payout')::numeric, -1)
    ));
  end if;

  select bool_and(coalesce((c ->> 'match')::boolean, false)) into v_match
  from jsonb_array_elements(v_checks) c;
  v_match := coalesce(v_match, true);

  return jsonb_build_object(
    'method_id', p_method_id, 'period_key', v_period_key,
    'old', v_old, 'new', v_new, 'new_group', v_group,
    'match', v_match, 'checks', v_checks
  );
end;
$$;

comment on function diff_evaluator_output(text, text) is
  'Standalone, reusable differential-testing artifact — WP1''s own
   acceptance gate before card_period_status() is ever repointed, and the
   exact callable WP7''s validator is expected to reuse rather than
   reimplement comparison logic (design/plan.md''s WP8 note). Returns
   every field compared, matches included, not just mismatches — meant to
   be read, not just asserted on. Not granted to anon/authenticated: an
   internal build/QA tool, called via service_role or direct SQL, not a
   dashboard RPC surface.
   REWIRED in 0017 (WP4 Part 1): its "old" side now calls 0007''s
   uob_month_status/uob_quarter_status/hsbc_month_status/citi_month_status
   directly instead of going through card_period_status(), because that
   migration repoints card_period_status() to the generic evaluator this
   function exists to check — sourcing "old" through it would have made
   the harness compare the new engine against itself. See 0017''s header.';

-- Defence in depth, restated rather than relied upon (same reasoning as
-- card_period_status() above): CREATE OR REPLACE does not reset an
-- existing function's ACL, so this is a no-op if 0015's grants already
-- hold. diff_evaluator_output is still deliberately NOT granted to
-- authenticated or anon — an internal build/QA tool, not a dashboard RPC
-- surface.
revoke execute on function diff_evaluator_output(text, text) from public;
