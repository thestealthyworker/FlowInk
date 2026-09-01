-- WP5: the config review and edit surface. See dashboard/app/(protected)/
-- config/page.tsx for the UI this migration exists to serve.
--
-- WHY THIS MIGRATION EXISTS
-- WP7 (built after this one) adds an AI research path that proposes
-- method_rules rows and validates them through a five-stage checker whose
-- key safety property is: a rule the AI could not cite a source for must
-- land inert, never live. That property is only real if there is
-- somewhere for a human to see and decide on those rows before they can
-- affect a real evaluate_period() answer. This migration:
--   1. Adds the pending/provenance columns method_rules needs for that
--      review workflow (there were none before this migration — every
--      existing row is implicitly "live" the moment its valid_from/
--      valid_to window covers today).
--   2. Adds ONE validated write path — submit_method_rule() for
--      proposing a row, a BEFORE INSERT OR UPDATE trigger that runs the
--      same field-level validation no matter which function (or a raw
--      UPDATE) touches the row — so WP7's AI-authored proposals and an
--      operator's hand-typed correction are checked identically, never
--      by two parallel code paths.
--   3. Adds approve_method_rule()/reject_method_rule() for the review
--      queue, and preview_method_rule() so "approve" is judged against
--      the rule's actual computed effect on a real period, not raw JSON.
--   4. Splits the Singapore example cards out of 0002_seed.sql (see that
--      file's new header) into load_example_data_singapore()/
--      clear_example_data(), invoked only when an operator asks for them
--      — a fresh deployment now starts with an empty payment_methods
--      configuration, not someone else's card list.
--
-- ============ THE CONTRACT WP7 MUST WRITE TO ============
-- WP7's validator, for every rule it proposes, must call:
--
--   select submit_method_rule(
--     p_method_id       => ...,           -- existing payment_methods.id
--     p_rule_type       => ...,           -- 'min_spend'|'tier'|'category_rate'|'cap'|'txn_count'
--     p_categories      => ...,           -- text[] or null
--     p_threshold       => ..., p_rate => ..., p_cap_amount => ...,
--     p_payout          => ..., p_txn_min => ..., p_priority => ...,
--     p_valid_from      => ...,           -- date, required
--     p_valid_to        => ...,           -- date or null
--     p_notes           => ...,           -- human-readable explanation
--     p_cap_basis, p_reward_form, p_gate_scope, p_credit_block_size,
--     p_credit_floor, p_estimate_caveat, p_condition_key => ...,  -- 0015 columns, as needed
--     p_proposed_by     => 'ai',
--     p_source_citations => '[{"title": "...", "url": "...", "quote": "..."}, ...]'::jsonb,
--     p_ai_rationale    => 'plain-language explanation of what was found and why this rule follows from it',
--     p_ai_confidence   => 0.0 to 1.0 or null
--   );
--
-- submit_method_rule() computes the new row's status ITSELF, from
-- is_operator() at call time — it never trusts p_proposed_by or any other
-- caller-supplied value for that decision. A call made under a real
-- operator dashboard session lands 'active' immediately. service_role
-- (WP7's expected calling context — bypasses RLS entirely, per this
-- codebase's existing convention: "Edge Functions and GitHub Actions
-- write with the service_role key, which bypasses RLS by design", 0001's
-- header) lands 'pending_review', unconditionally: under that role
-- is_operator() reads auth.uid() as null and evaluates false, so EVERY
-- row WP7 proposes lands 'pending_review' regardless of how confident
-- the AI was or what p_proposed_by is set to. There is no parameter
-- that lets a caller mark its own proposal 'active' directly — that is
-- the enforced half of the gate this migration owns.
--
-- A non-operator AUTHENTICATED session is stricter still, not merely
-- "also pending_review": this function is `security invoker`, so its
-- INSERT still needs the "operator inserts method_rules" RLS policy
-- below (`with check (is_operator())`) to pass. A non-operator session
-- fails that check and the INSERT is blocked outright — the statement
-- errors and rolls back, it does not silently land a pending_review row.
-- An unauthenticated (anon) request has no INSERT grant on method_rules
-- at all and is refused before RLS is even reached. The one path that
-- actually returns a 'pending_review' row without an operator session is
-- a role that bypasses RLS by grant, i.e. service_role.
--
-- method_rules' full new-column contract, for WP7's five-stage validator
-- to populate:
--   status             text: 'active' | 'pending_review' | 'rejected'.
--                       Never write this column directly — always via
--                       submit_method_rule()/approve_method_rule()/
--                       reject_method_rule(), which are the only things
--                       that assign it a value under this migration's
--                       invariants (see above).
--   proposed_by         text: 'operator' | 'ai'. Provenance label only —
--                       carries no authority over `status` (see above).
--   source_citations     jsonb, null unless proposed_by = 'ai'. Free-shape
--                       array, but the review UI (ReviewQueue.tsx) reads
--                       each element as {title?, url?, quote?} when
--                       present — populate what you actually have; an
--                       array with zero elements (found nothing to cite)
--                       is exactly the case that must reach the reviewer
--                       as "no source" rather than being omitted.
--   ai_rationale        text, free-form: what the AI concluded and why,
--                       in a reviewer's terms — shown verbatim above the
--                       citations in the review card.
--   ai_confidence        numeric 0..1 or null: the AI's own self-rated
--                       confidence, shown as a plain label
--                       (low/medium/high) never a bare decimal.
--   reviewed_at/
--   reviewed_by/
--   review_note          set only by approve_method_rule()/
--                       reject_method_rule() (or automatically, to
--                       now()/auth.uid(), by submit_method_rule() itself
--                       when a row lands 'active' on creation because the
--                       caller was a real operator session).
--
-- WHAT WP7 MUST NOT DO: insert into method_rules directly, or call any
-- function other than submit_method_rule() to create a row. Doing so
-- bypasses the BEFORE INSERT trigger's field validation only if RLS lets
-- the statement through at all (it will not, for the authenticated role
-- — see the INSERT policy below) and, more importantly, bypasses this
-- migration's one documented guarantee that an AI-authored row can never
-- be born 'active'.

-- ============ SCHEMA: method_rules review/provenance columns ============

alter table method_rules
  add column status text not null default 'active'
    check (status in ('active', 'pending_review', 'rejected')),
  add column proposed_by text not null default 'operator'
    check (proposed_by in ('operator', 'ai')),
  add column source_citations jsonb,
  add column ai_rationale text,
  add column ai_confidence numeric check (ai_confidence is null or (ai_confidence >= 0 and ai_confidence <= 1)),
  add column reviewed_at timestamptz,
  add column reviewed_by uuid references auth.users(id),
  add column review_note text;

comment on column method_rules.status is
  'active: counted by evaluate_period()/evaluate_period_group() when its
   valid_from/valid_to window covers the period (unchanged behaviour,
   just now gated on this column too — see the "and status = ''active''"
   filter added to every method_rules lookup inside evaluate_period() by
   this same migration). pending_review: exists, fully validated, but
   invisible to every evaluator query — an AI-proposed rule sits here
   until an operator decides. rejected: reviewed and declined; kept
   (never deleted) as a record of what was proposed and turned down. Set
   ONLY by submit_method_rule() / approve_method_rule() /
   reject_method_rule() — see this migration''s header for why no other
   write path may set it, and never write it directly.';

comment on column method_rules.proposed_by is
  'Provenance label: who authored this row. operator: typed or edited by
   the signed-in operator via the dashboard. ai: proposed by WP7''s
   research pipeline via submit_method_rule(p_proposed_by => ''ai'', ...).
   Carries NO authority over `status` — see this migration''s header.';

comment on column method_rules.source_citations is
  'jsonb array of {title?, url?, quote?} the AI is claiming this rule
   from, or an empty array/null if it found nothing to cite. Only ever
   populated by an ai-proposed row (submit_method_rule''s
   p_source_citations); null for every operator-authored row, which is
   its own citation (the operator typed it, on their own authority).
   Rendered as-is in the review queue — never fabricated or backfilled by
   this codebase if absent.';

comment on column method_rules.ai_rationale is
  'Free text: what the AI concluded and why, in the reviewer''s terms —
   e.g. "UOB One T&C clause 4.1 lists SP Group under bills at 1% at every
   tier; no cap interaction found." Only set on ai-proposed rows.';

comment on column method_rules.ai_confidence is
  'The AI''s own self-rated confidence in this specific rule, 0..1, or
   null if it did not provide one. Never computed or inferred by this
   codebase — passed through from WP7 verbatim and shown as a plain
   low/medium/high label, not a bare number a reviewer has to interpret.';

comment on column method_rules.reviewed_at is
  'When this row''s status was last decided — set to now() by
   submit_method_rule() itself for an operator-authored row born active,
   and by approve_method_rule()/reject_method_rule() for a reviewed
   ai-proposed row. Null only for a row still pending_review.';

comment on column method_rules.reviewed_by is
  'auth.uid() of the operator who decided this row''s status — same
   timing as reviewed_at. References auth.users(id) so a stale/deleted
   account does not silently orphan the audit trail without a trace
   (on delete cascade would remove it; deliberately no ON DELETE clause
   here so the FK raises instead of quietly losing the reviewer''s
   identity — the operator account this system is built around should
   never actually be deleted while its own review history still exists).';

comment on column method_rules.review_note is
  'Free text set alongside a decision — required in practice by
   reject_method_rule()''s caller-side default (dashboard/lib/actions/
   methodRules.ts prefills "Rejected by operator" when the operator
   leaves it blank, satisfying the requirement that a rejection is never
   silent) but not enforced by a NOT NULL here, since an approval note is
   optional and this column serves both.';

-- valid_to must not precede valid_from — defence in depth alongside
-- method_rules_validate() below (a raw UPDATE that somehow bypassed the
-- trigger, which nothing in this codebase does, would still be caught
-- here). NOT VALID skipped deliberately: this table's existing seed rows
-- (0002) all have valid_to null, so a full validation scan is cheap and
-- correctness-relevant enough to run now rather than deferring it.
alter table method_rules
  add constraint method_rules_valid_to_after_valid_from
  check (valid_to is null or valid_to >= valid_from);

-- Fast lookup for the review queue's primary query (WHERE status =
-- 'pending_review') and for the live evaluator's new status filter,
-- which now runs on every evaluate_period() call for every method_id.
create index on method_rules (method_id, status);
create index on method_rules (status) where status = 'pending_review';

-- ============ VALIDATION: the ONE path every write goes through ============
-- BEFORE INSERT OR UPDATE, not a check spread across submit_method_rule()
-- and a separate edit function: whichever of this migration's functions
-- (or, in principle, any future direct UPDATE) touches a row, this fires
-- identically. This is what makes "AI-proposed and hand-edited rules go
-- through the same validation" true by construction rather than by two
-- call sites happening to agree today.
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
  if new.txn_min is not null and new.txn_min < 0 then
    raise exception 'txn_min must not be negative, got %', new.txn_min;
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

create trigger method_rules_validate_trigger
  before insert or update on method_rules
  for each row execute function method_rules_validate();

-- ============ THE SHARED WRITE PATH ============

-- The ONE insert entrypoint for a new method_rules row — used for an
-- operator adding/correcting a rule from the dashboard AND for WP7's
-- AI-proposed rules. status is computed here, never accepted as input;
-- see this migration's header for the full invariant.
create or replace function submit_method_rule(
  p_method_id text,
  p_rule_type text,
  p_categories text[],
  p_threshold numeric,
  p_rate numeric,
  p_cap_amount numeric,
  p_payout numeric,
  p_txn_min int,
  p_priority int,
  p_valid_from date,
  p_valid_to date default null,
  p_notes text default null,
  p_cap_basis text default null,
  p_reward_form text default null,
  p_gate_scope text default null,
  p_credit_block_size numeric default null,
  p_credit_floor numeric default null,
  p_estimate_caveat text default null,
  p_condition_key text default null,
  p_proposed_by text default 'operator',
  p_source_citations jsonb default null,
  p_ai_rationale text default null,
  p_ai_confidence numeric default null
)
returns method_rules
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_row method_rules;
begin
  if p_proposed_by not in ('operator', 'ai') then
    raise exception 'p_proposed_by must be ''operator'' or ''ai'', got %', p_proposed_by;
  end if;

  -- THE gate: never derived from p_proposed_by or any other
  -- caller-supplied value. A real, signed-in operator session (RLS's own
  -- is_operator()) is the only thing that can produce status = 'active'
  -- here. Everything else that actually reaches this line —
  -- service_role (WP7's expected calling context) above all — lands
  -- pending_review, full stop.
  --
  -- A non-operator authenticated session does NOT reach a pending_review
  -- row via this path: this function is `security invoker`, so its
  -- INSERT still has to clear the "operator inserts method_rules" RLS
  -- policy below (`with check (is_operator())`), which such a session
  -- fails — the INSERT is blocked outright (the whole statement errors
  -- and rolls back), not silently downgraded to pending_review. Only a
  -- caller RLS lets through at all — an operator, or a role like
  -- service_role that bypasses RLS entirely — ever sees this function
  -- return; the strictness lives in the grant/policy layer, not just in
  -- v_status here.
  v_status := case when is_operator() then 'active' else 'pending_review' end;

  insert into method_rules (
    method_id, rule_type, categories, threshold, rate, cap_amount, payout, txn_min, priority,
    valid_from, valid_to, notes, cap_basis, reward_form, gate_scope, credit_block_size, credit_floor,
    estimate_caveat, condition_key, status, proposed_by, source_citations, ai_rationale, ai_confidence,
    reviewed_at, reviewed_by
  ) values (
    p_method_id, p_rule_type, p_categories, p_threshold, p_rate, p_cap_amount, p_payout, p_txn_min,
    coalesce(p_priority, 0), p_valid_from, p_valid_to, p_notes, p_cap_basis, p_reward_form, p_gate_scope,
    p_credit_block_size, p_credit_floor, p_estimate_caveat, p_condition_key, v_status, p_proposed_by,
    p_source_citations, p_ai_rationale, p_ai_confidence,
    case when v_status = 'active' then now() else null end,
    case when v_status = 'active' then auth.uid() else null end
  )
  returning * into v_row;

  return v_row;
end;
$$;

comment on function submit_method_rule is
  'The single insert path for a method_rules row (this migration''s hard
   requirement). WP7''s validator must call this, never a raw INSERT —
   see this migration''s header for the full contract and the
   status-derivation invariant. security invoker: runs as the calling
   role, so INSERT still needs that role''s own grant + RLS to succeed
   (granted to authenticated below, gated by is_operator() in the
   "operator inserts method_rules" policy) — service_role bypasses RLS
   entirely as usual for this codebase''s ingest-style writers.';

-- Edit an EXISTING row''s proposal/rule fields — same trigger validation
-- as submit_method_rule''s insert (method_rules_validate fires on UPDATE
-- too), so a hand-correction to an AI''s proposed rate/threshold/cap
-- before approving it is checked identically to a brand-new proposal.
-- Does not touch status/reviewed_*: editing a still-pending row leaves it
-- pending (still requires an explicit approve), and editing an already-
-- active row does not silently re-trigger a review.
create or replace function edit_method_rule(
  p_rule_id bigint,
  p_rate numeric,
  p_threshold numeric,
  p_cap_amount numeric,
  p_payout numeric,
  p_txn_min int,
  p_categories text[],
  p_notes text,
  p_valid_to date default null
)
returns method_rules
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_row method_rules;
begin
  update method_rules
    set rate = p_rate,
        threshold = p_threshold,
        cap_amount = p_cap_amount,
        payout = p_payout,
        txn_min = p_txn_min,
        categories = p_categories,
        notes = p_notes,
        valid_to = p_valid_to
    where id = p_rule_id
    returning * into v_row;

  if not found then
    raise exception 'method_rules row % not found', p_rule_id;
  end if;

  return v_row;
end;
$$;

-- ============ THE REVIEW QUEUE ============

create or replace function approve_method_rule(p_rule_id bigint, p_review_note text default null)
returns method_rules
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_row method_rules;
begin
  update method_rules
    set status = 'active', reviewed_at = now(), reviewed_by = auth.uid(), review_note = p_review_note
    where id = p_rule_id and status = 'pending_review'
    returning * into v_row;

  if not found then
    raise exception 'rule % is not awaiting review (already decided, or does not exist)', p_rule_id;
  end if;

  return v_row;
end;
$$;

create or replace function reject_method_rule(p_rule_id bigint, p_review_note text)
returns method_rules
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_row method_rules;
begin
  update method_rules
    set status = 'rejected', reviewed_at = now(), reviewed_by = auth.uid(),
        review_note = coalesce(nullif(btrim(p_review_note), ''), 'Rejected by operator (no reason given).')
    where id = p_rule_id and status = 'pending_review'
    returning * into v_row;

  if not found then
    raise exception 'rule % is not awaiting review (already decided, or does not exist)', p_rule_id;
  end if;

  return v_row;
end;
$$;

comment on function reject_method_rule is
  'Rejecting is exactly as easy as approving (one call, same shape) but
   never silent: the row is kept (status = ''rejected'', never deleted)
   and always carries a review_note — a caller-supplied reason, or a
   generic placeholder if none was given, never null.';

-- Show a reviewer what a pending rule will actually DO before they
-- decide, against the same evaluate_period() (0015) the live dashboard
-- already renders — not a re-implementation. Computes the period's
-- current, real answer, then temporarily flips this ONE row to active,
-- computes the answer again, and unconditionally rolls back that
-- temporary flip via a caught exception (a plpgsql EXCEPTION block's
-- implicit savepoint rolls back the UPDATE; the jsonb already computed
-- into a local variable survives, since plpgsql variables are not
-- transactional state) — so the rule never becomes even briefly visible
-- to any other session, and this function's own status stays exactly
-- 'pending_review' whether the preview succeeds or errors.
create or replace function preview_method_rule(p_rule_id bigint, p_period_key text default null)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_rule method_rules;
  v_without jsonb;
  v_with jsonb;
  v_resolved_period text;
begin
  select * into v_rule from method_rules where id = p_rule_id;
  if not found then
    raise exception 'rule % not found', p_rule_id;
  end if;

  v_without := evaluate_period(v_rule.method_id, p_period_key);
  v_resolved_period := coalesce(p_period_key, v_without -> 'period' ->> 'key');

  begin
    update method_rules set status = 'active' where id = p_rule_id;
    v_with := evaluate_period(v_rule.method_id, v_resolved_period);
    -- Always unwind the simulated flip, success or not — the sentinel
    -- message below is never a real error, only a jump to the handler.
    raise exception using errcode = 'P0001', message = '__flowink_preview_rollback__';
  exception when others then
    if sqlerrm is distinct from '__flowink_preview_rollback__' then
      raise;
    end if;
    -- else: expected unwind, v_with already captured above.
  end;

  return jsonb_build_object(
    'rule_id', p_rule_id,
    'method_id', v_rule.method_id,
    'period_key', v_resolved_period,
    'without_rule', v_without,
    'with_rule', v_with
  );
end;
$$;

comment on function preview_method_rule is
  'What makes approving a real decision rather than a rubber stamp: runs
   the real evaluate_period() twice for the rule''s method_id and a real
   period (defaults to the card''s current period, i.e. real transaction
   data) — once as today''s live config, once with exactly this pending
   row hypothetically active — and returns both so the review UI can show
   the reviewer the actual before/after (reward_accrued, cap headroom,
   which tracks fire) rather than raw JSON plus a button. Never commits
   the hypothetical flip.';

-- ============ REPOINT THE EVALUATOR: pending/rejected rules are never live ============
-- Every method_rules lookup evaluate_period() (0015) and
-- evaluate_period_group() (0015) run gets "and status = 'active'" added
-- to its existing valid_from/valid_to window filter — the change that
-- actually makes pending_review inert rather than merely labelled.
-- Bodies otherwise byte-for-byte identical to 0015's (as amended by
-- 27c9ad5) — CREATE OR REPLACE, not a new function, so every existing
-- grant, comment and caller (card_period_status, 0017) is untouched.
create or replace function evaluate_period(p_method_id text, p_period_key text default null)
returns jsonb
language plpgsql
security invoker
stable
set search_path = public, pg_temp
as $$
declare
  v_method record;
  v_period_key text;
  v_bounds record;
  v_as_of date;
  v_calendar_month text;
  v_spend numeric := 0;
  v_txn_count int := 0;
  v_conditions jsonb := '{}'::jsonb;
  v_condition_keys text[];
  v_ck text;
  v_gates jsonb := '[]'::jsonb;
  v_bonus_locked boolean := false;
  v_any_gate_failed boolean := false;
  v_reasons text[] := '{}';
  v_estimate_caveats text[] := '{}';
  v_reward_tracks jsonb := '[]'::jsonb;
  v_reward_accrued numeric := 0;
  v_cap_row record;
  v_cap_remaining numeric;
  v_base_row record;
  v_base_rate numeric;
  v_claimed text[] := '{}';
  v_all_categories text[] := array[
    'groceries', 'dining', 'petrol', 'commute', 'transport',
    'bills', 'online', 'retail', 'healthcare', 'household', 'other'
  ];
  r record;
  v_g_required numeric;
  v_g_actual numeric;
  v_g_cleared boolean;
  v_candidate_cats text[];
  v_cat_spend numeric;
  v_row_reward numeric;
  v_applied numeric;
  v_spend_cap_overflow numeric := 0;
  v_overflow_reward numeric;
  v_base_track_idx int := null;
  v_tier_thresholds jsonb := '[]'::jsonb;
  v_tier_hit jsonb := null;
  v_gap_to_next numeric := null;
  v_t_reached boolean;
  v_t_is_current boolean;
  v_crediting jsonb := null;
  v_at_risk boolean := false;
begin
  select * into v_method from payment_methods where id = p_method_id;
  if not found then
    return jsonb_build_object('method_id', p_method_id, 'error', 'unknown payment method');
  end if;

  if not v_method.has_rules then
    return jsonb_build_object('method_id', p_method_id, 'display_name', v_method.display_name,
      'has_rules', false, 'note', 'no card rules configured for this method (e.g. a wallet)');
  end if;

  if not v_method.active then
    return jsonb_build_object(
      'method_id', p_method_id, 'display_name', v_method.display_name,
      'currency', v_method.currency, 'active', false,
      'note', 'card not yet active — inert until payment_methods.active = true'
    );
  end if;

  v_period_key := coalesce(p_period_key, card_current_period_key(p_method_id));
  if v_period_key like '%:pending' then
    return jsonb_build_object('method_id', p_method_id, 'display_name', v_method.display_name,
      'period_key', v_period_key,
      'error', 'cycle_day not set for ' || p_method_id || '; period cannot be resolved');
  end if;

  select * into v_bounds from card_period_bounds(p_method_id, v_period_key);
  if v_bounds is null then
    return jsonb_build_object('method_id', p_method_id, 'display_name', v_method.display_name,
      'period_key', v_period_key, 'error', 'invalid or unresolvable period_key');
  end if;
  v_as_of := v_bounds.period_end;
  v_calendar_month := split_part(v_period_key, ':', 2);

  select coalesce(sum(amount), 0), count(*) into v_spend, v_txn_count
  from spend_transactions
  where method_id = p_method_id and period_key = v_period_key
    and status in ('confirmed', 'provisional') and not is_transfer;

  select array_agg(distinct condition_key) into v_condition_keys
  from method_rules
  where method_id = p_method_id and condition_key is not null and status = 'active'
    and valid_from <= v_as_of and (valid_to is null or valid_to >= v_as_of);

  if v_condition_keys is not null then
    foreach v_ck in array v_condition_keys loop
      v_conditions := v_conditions || jsonb_build_object(v_ck, coalesce(
        (select condition_met from method_conditions
         where method_id = p_method_id and calendar_month = v_calendar_month and condition_key = v_ck),
        false
      ));
    end loop;
  end if;

  for r in
    select rule_type, threshold, txn_min, gate_scope from method_rules
    where method_id = p_method_id and rule_type in ('min_spend', 'txn_count') and status = 'active'
      and valid_from <= v_as_of and (valid_to is null or valid_to >= v_as_of)
      and (condition_key is null or coalesce((v_conditions ->> condition_key)::boolean, false))
  loop
    if r.rule_type = 'txn_count' then
      v_g_required := coalesce(r.txn_min, 0);
      v_g_actual := v_txn_count;
      v_g_cleared := v_txn_count >= v_g_required;
    else
      v_g_required := coalesce(r.threshold, 0);
      v_g_actual := v_spend;
      v_g_cleared := v_spend >= v_g_required;
    end if;

    v_gates := v_gates || jsonb_build_array(jsonb_build_object(
      'kind', r.rule_type, 'cleared', v_g_cleared,
      'required', v_g_required, 'actual', v_g_actual,
      'scope', coalesce(r.gate_scope, 'tier_only')
    ));

    if not v_g_cleared then
      v_any_gate_failed := true;
      v_reasons := v_reasons || ('below_' || r.rule_type);
      if r.gate_scope = 'all_rewards' then
        v_bonus_locked := true;
      end if;
    end if;
  end loop;

  for r in
    select threshold, payout, txn_min from method_rules
    where method_id = p_method_id and rule_type = 'tier' and status = 'active'
      and valid_from <= v_as_of and (valid_to is null or valid_to >= v_as_of)
      and (condition_key is null or coalesce((v_conditions ->> condition_key)::boolean, false))
    order by threshold desc
  loop
    v_t_reached := v_spend >= r.threshold and v_txn_count >= coalesce(r.txn_min, 0);
    v_t_is_current := false;

    if v_tier_hit is null and v_t_reached then
      v_tier_hit := jsonb_build_object('threshold', r.threshold, 'payout', r.payout);
      v_t_is_current := true;
    elsif v_tier_hit is null and v_spend < r.threshold then
      v_gap_to_next := r.threshold - v_spend;
    end if;

    v_tier_thresholds := v_tier_thresholds || jsonb_build_array(jsonb_build_object(
      'value', r.threshold, 'reached', v_t_reached, 'is_current_tier', v_t_is_current,
      'payout', r.payout,
      'gap', case when not v_t_reached then round(greatest(0, r.threshold - v_spend), 2) else null end,
      'txn_min', coalesce(r.txn_min, 0)
    ));
  end loop;

  if jsonb_array_length(v_tier_thresholds) > 0 then
    v_reward_tracks := v_reward_tracks || jsonb_build_array(jsonb_build_object(
      'kind', 'tier', 'label', 'Spend tiers',
      'reward_form', 'fixed_payout', 'unit', v_method.reward_unit,
      'thresholds', v_tier_thresholds,
      'accrued', round(coalesce((v_tier_hit ->> 'payout')::numeric, 0), 2),
      'gap_to_next', round(coalesce(v_gap_to_next, 0), 2)
    ));
  end if;

  select cap_amount, cap_basis, credit_block_size, credit_floor
    into v_cap_row
  from method_rules
  where method_id = p_method_id and rule_type = 'cap' and status = 'active'
    and valid_from <= v_as_of and (valid_to is null or valid_to >= v_as_of)
    and (condition_key is null or coalesce((v_conditions ->> condition_key)::boolean, false))
  order by priority desc
  limit 1;
  v_cap_remaining := v_cap_row.cap_amount;

  select rate into v_base_rate
  from method_rules
  where method_id = p_method_id and rule_type = 'category_rate' and categories is null and status = 'active'
    and valid_from <= v_as_of and (valid_to is null or valid_to >= v_as_of)
    and (condition_key is null or coalesce((v_conditions ->> condition_key)::boolean, false))
  limit 1;

  if v_bonus_locked then
    v_row_reward := v_spend * coalesce(v_base_rate, 0);
    if v_cap_row.cap_basis = 'spend' then
      v_applied := least(v_spend, coalesce(v_cap_remaining, v_spend)) * coalesce(v_base_rate, 0);
      if v_cap_remaining is not null then
        v_cap_remaining := v_cap_remaining - least(v_spend, v_cap_remaining);
      end if;
    else
      v_applied := least(v_row_reward, coalesce(v_cap_remaining, v_row_reward));
      if v_cap_remaining is not null then
        v_cap_remaining := v_cap_remaining - v_applied;
      end if;
    end if;
    v_reward_accrued := v_reward_accrued + v_applied;
    v_reward_tracks := v_reward_tracks || jsonb_build_array(jsonb_build_object(
      'kind', 'category_rate', 'label', 'Base rate (bonus categories locked this period)',
      'reward_form', 'rate', 'unit', v_method.reward_unit,
      'categories', null, 'threshold', null, 'threshold_met', true,
      'matched_spend', round(v_spend, 2), 'rate', v_base_rate, 'accrued', round(v_applied, 2),
      'cap', case when v_cap_row.cap_basis is not null then jsonb_build_object(
        'basis', v_cap_row.cap_basis, 'amount', v_cap_row.cap_amount,
        'remaining', round(v_cap_remaining, 2),
        'exhausted', v_cap_remaining is not null and v_cap_remaining <= 0
      ) else null end
    ));
  else
    for r in
      select categories, threshold, rate, notes, reward_form, estimate_caveat
      from method_rules
      where method_id = p_method_id and rule_type = 'category_rate' and status = 'active'
        and valid_from <= v_as_of and (valid_to is null or valid_to >= v_as_of)
        and (condition_key is null or coalesce((v_conditions ->> condition_key)::boolean, false))
      order by priority desc
    loop
      if r.threshold is not null and v_spend < r.threshold then
        v_reward_tracks := v_reward_tracks || jsonb_build_array(jsonb_build_object(
          'kind', 'category_rate',
          'label', coalesce(nullif(split_part(r.notes, '.', 1), ''), 'Category bonus') || '.',
          'reward_form', coalesce(r.reward_form, 'rate'), 'unit', v_method.reward_unit,
          'categories', to_jsonb(r.categories), 'threshold', r.threshold, 'threshold_met', false,
          'matched_spend', 0, 'rate', r.rate, 'accrued', 0, 'cap', null
        ));
        continue;
      end if;

      v_candidate_cats := coalesce(r.categories, v_all_categories);
      v_candidate_cats := (select array_agg(c) from unnest(v_candidate_cats) c where c <> all(v_claimed));

      if v_candidate_cats is null or array_length(v_candidate_cats, 1) is null then
        v_reward_tracks := v_reward_tracks || jsonb_build_array(jsonb_build_object(
          'kind', 'category_rate',
          'label', coalesce(nullif(split_part(r.notes, '.', 1), ''), 'Category bonus') || '.',
          'reward_form', coalesce(r.reward_form, 'rate'), 'unit', v_method.reward_unit,
          'categories', to_jsonb(r.categories), 'threshold', r.threshold, 'threshold_met', true,
          'matched_spend', 0, 'rate', r.rate, 'accrued', 0, 'cap', null
        ));
        continue;
      end if;

      select coalesce(sum(amount), 0) into v_cat_spend
      from spend_transactions
      where method_id = p_method_id and period_key = v_period_key
        and status in ('confirmed', 'provisional') and not is_transfer
        and category = any(v_candidate_cats);

      v_row_reward := v_cat_spend * coalesce(r.rate, 0);
      v_applied := v_row_reward;
      v_spend_cap_overflow := 0;

      if v_cap_row.cap_basis = 'spend' and r.categories is not null then
        if v_cap_remaining is not null then
          if v_cat_spend > v_cap_remaining then
            v_spend_cap_overflow := v_cat_spend - greatest(v_cap_remaining, 0);
          end if;
          v_applied := least(v_cat_spend, greatest(v_cap_remaining, 0)) * coalesce(r.rate, 0);
          v_cap_remaining := v_cap_remaining - least(v_cat_spend, greatest(v_cap_remaining, 0));
        end if;
      elsif v_cap_row.cap_basis = 'reward' then
        if v_cap_remaining is not null then
          v_applied := least(v_row_reward, greatest(v_cap_remaining, 0));
          v_cap_remaining := v_cap_remaining - v_applied;
        end if;
      end if;

      v_reward_accrued := v_reward_accrued + v_applied;
      v_claimed := v_claimed || v_candidate_cats;

      if r.estimate_caveat is not null and v_cat_spend > 0 then
        v_estimate_caveats := array_append(v_estimate_caveats, r.estimate_caveat);
      end if;

      v_reward_tracks := v_reward_tracks || jsonb_build_array(jsonb_build_object(
        'kind', 'category_rate',
        'label', coalesce(nullif(split_part(r.notes, '.', 1), ''), 'Category bonus') || '.',
        'reward_form', coalesce(r.reward_form, 'rate'), 'unit', v_method.reward_unit,
        'categories', to_jsonb(r.categories), 'threshold', r.threshold, 'threshold_met', true,
        'matched_spend', round(v_cat_spend, 2), 'rate', r.rate, 'accrued', round(v_applied, 2),
        'overflow_spend', case when v_spend_cap_overflow > 0 then round(v_spend_cap_overflow, 2) else null end,
        'cap', case when v_cap_row.cap_basis is not null then jsonb_build_object(
          'basis', v_cap_row.cap_basis, 'amount', v_cap_row.cap_amount,
          'remaining', round(v_cap_remaining, 2),
          'exhausted', v_cap_remaining is not null and v_cap_remaining <= 0
        ) else null end
      ));
    end loop;

    -- Spend-basis cap overflow routes to the base rate, same as 27c9ad5's
    -- fix to 0015: not re-derived here, folded straight into
    -- v_reward_accrued via v_overflow_reward exactly as that fix did.
    if v_cap_row.cap_basis = 'spend' then
      select coalesce(sum((t.value ->> 'overflow_spend')::numeric), 0) into v_overflow_reward
      from jsonb_array_elements(v_reward_tracks) t
      where (t.value ->> 'overflow_spend') is not null;
      if v_overflow_reward > 0 then
        v_overflow_reward := v_overflow_reward * coalesce(v_base_rate, 0);
        v_reward_accrued := v_reward_accrued + v_overflow_reward;
        for r in select ord, track from jsonb_array_elements(v_reward_tracks) with ordinality as t(track, ord)
                 where (t.track ->> 'categories') is null loop
          v_reward_tracks := jsonb_set(
            v_reward_tracks, array[(r.ord - 1)::text, 'accrued'],
            to_jsonb(round(coalesce((r.track ->> 'accrued')::numeric, 0) + v_overflow_reward, 2))
          );
        end loop;
      end if;
    end if;
  end if;

  if v_cap_row.credit_block_size is not null then
    declare
      v_floor numeric := coalesce(v_cap_row.credit_floor, 0);
      v_blocked numeric := floor(v_reward_accrued / v_cap_row.credit_block_size) * v_cap_row.credit_block_size;
    begin
      if v_blocked >= v_floor then
        v_crediting := jsonb_build_object(
          'block_size', v_cap_row.credit_block_size, 'floor', v_floor,
          'credited', v_blocked, 'accrued_uncredited', round(v_reward_accrued - v_blocked, 2)
        );
      else
        v_crediting := jsonb_build_object(
          'block_size', v_cap_row.credit_block_size, 'floor', v_floor,
          'credited', 0, 'accrued_uncredited', v_blocked
        );
      end if;
    end;
  end if;

  if v_any_gate_failed then
    v_at_risk := true;
  end if;
  if jsonb_array_length(v_tier_thresholds) > 0 and v_tier_hit is null then
    v_at_risk := true;
  end if;
  if v_cap_row.cap_basis = 'spend' and v_cap_remaining is not null and v_cap_remaining > 0 then
    v_at_risk := true;
    v_reasons := v_reasons || 'unused_bonus_cap_headroom'::text;
  end if;
  if v_cap_row.cap_basis is not null and v_cap_remaining is not null and v_cap_remaining <= 0 then
    v_reasons := v_reasons || 'cap_exhausted'::text;
  end if;
  v_at_risk := v_at_risk and v_bounds.is_current and v_bounds.days_left <= 5;

  return jsonb_build_object(
    'method_id', p_method_id,
    'display_name', v_method.display_name,
    'currency', v_method.currency,
    'period', jsonb_build_object(
      'key', v_period_key,
      'start', v_bounds.period_start, 'end', v_bounds.period_end,
      'is_current', v_bounds.is_current, 'days_left', v_bounds.days_left,
      'kind', v_method.period_type
    ),
    'spend', jsonb_build_object('total', round(v_spend, 2), 'txn_count', v_txn_count),
    'gates', v_gates,
    'reward_tracks', v_reward_tracks,
    'reward_accrued', round(v_reward_accrued, 2),
    'cap', case when v_cap_row.cap_basis is not null then jsonb_build_object(
      'basis', v_cap_row.cap_basis, 'amount', v_cap_row.cap_amount,
      'remaining', round(v_cap_remaining, 2),
      'exhausted', v_cap_remaining is not null and v_cap_remaining <= 0
    ) else null end,
    'crediting', v_crediting,
    'group', null,
    'has_group', v_method.aggregation_window is not null,
    'aggregation_window', v_method.aggregation_window,
    'at_risk', jsonb_build_object('value', v_at_risk, 'reasons', to_jsonb(v_reasons)),
    'estimate_caveats', to_jsonb(v_estimate_caveats),
    'active', true
  );
end;
$$;

comment on function evaluate_period is
  'WP5 (0018) amendment: every method_rules lookup now additionally
   requires status = ''active'', on top of 0015''s original valid_from/
   valid_to window filter — a pending_review or rejected row is invisible
   to this function no matter what dates it carries. Otherwise
   byte-for-byte 0015''s body (as amended by 27c9ad5). See preview_
   method_rule() (this migration) for how the review UI still shows a
   pending row''s effect without making it live.';

-- Same amendment, same reason, on evaluate_period_group()'s own two
-- direct method_rules reads (its per-member calls into evaluate_period()
-- above already inherit the filter; these two local tier-threshold walks
-- are separate queries and would not otherwise pick up a pending row's
-- exclusion). Body otherwise byte-for-byte 0015's (as amended by
-- 27c9ad5).
create or replace function evaluate_period_group(p_method_id text, p_period_key text default null)
returns jsonb
language plpgsql
security invoker
stable
set search_path = public, pg_temp
as $$
declare
  v_period_key text := coalesce(p_period_key, card_current_period_key(p_method_id));
  v_bounds record;
  v_anchor date;
  v_window int;
  v_target date;
  v_months_diff int;
  v_window_start date;
  v_grouping text;
  v_periods date[];
  v_statuses jsonb := '[]'::jsonb;
  v_mstatus jsonb;
  v_thr numeric;
  v_txn_min int;
  v_payout numeric;
  v_still_achievable jsonb := null;
  v_confirmed jsonb := null;
  v_forfeited boolean;
  v_ok boolean;
  v_all_closed_ok boolean;
  v_spend numeric;
  v_txn int;
  v_is_current boolean;
  v_days_left int;
  v_closed boolean;
  v_any_current_at_risk boolean;
  v_blocking_members jsonb := '[]'::jsonb;
  v_min_thr numeric;
  v_min_txn_min int;
  i int;
begin
  select * into v_bounds from card_period_bounds(p_method_id, v_period_key);
  if v_bounds is null then
    return jsonb_build_object('method_id', p_method_id, 'group_period_key', v_period_key,
      'error', 'invalid or unresolvable period_key');
  end if;

  select aggregation_anchor_date, aggregation_window into v_anchor, v_window
  from payment_methods where id = p_method_id;

  if v_window is null then
    return jsonb_build_object('method_id', p_method_id, 'group_period_key', v_period_key,
      'error', 'no aggregation_window configured for this method');
  end if;

  v_target := make_date(
    split_part(split_part(v_period_key, ':', 2), '-', 1)::int,
    split_part(split_part(v_period_key, ':', 2), '-', 2)::int,
    1
  );

  if v_anchor is not null then
    v_months_diff := (extract(year from v_target)::int - extract(year from v_anchor)::int) * 12
                    + (extract(month from v_target)::int - extract(month from v_anchor)::int);
    v_window_start := (date_trunc('month', v_anchor)
      + (floor(v_months_diff / v_window::numeric)::int * v_window * interval '1 month'))::date;
    v_grouping := 'anchor_aligned';
  else
    v_window_start := (date_trunc('month', v_target) - (v_window - 1) * interval '1 month')::date;
    v_grouping := 'anchor_unknown_trailing_window';
  end if;

  v_periods := array(select (v_window_start + (n * interval '1 month'))::date from generate_series(0, v_window - 1) n);

  for i in 1..v_window loop
    v_mstatus := evaluate_period(p_method_id, p_method_id || ':' || to_char(v_periods[i], 'YYYY-MM'));
    v_statuses := v_statuses || jsonb_build_array(v_mstatus);
  end loop;

  select threshold, txn_min into v_min_thr, v_min_txn_min
  from method_rules
  where method_id = p_method_id and rule_type = 'tier' and status = 'active'
    and valid_from <= v_bounds.period_end and (valid_to is null or valid_to >= v_bounds.period_end)
  order by threshold asc limit 1;

  for v_thr, v_txn_min, v_payout in
    select threshold, coalesce(txn_min, 0), payout from method_rules
    where method_id = p_method_id and rule_type = 'tier' and status = 'active'
      and valid_from <= v_bounds.period_end and (valid_to is null or valid_to >= v_bounds.period_end)
    order by threshold desc
  loop
    v_ok := true;
    v_all_closed_ok := true;
    for i in 1..v_window loop
      v_mstatus := v_statuses -> (i - 1);
      if v_mstatus ? 'error' or v_mstatus ? 'has_rules' then
        continue;
      end if;
      v_spend := (v_mstatus -> 'spend' ->> 'total')::numeric;
      v_txn := (v_mstatus -> 'spend' ->> 'txn_count')::int;
      v_is_current := (v_mstatus -> 'period' ->> 'is_current')::boolean;
      v_days_left := (v_mstatus -> 'period' ->> 'days_left')::int;
      v_closed := (not v_is_current) and v_days_left = 0;

      if v_closed then
        if v_spend < v_thr or v_txn < v_txn_min then
          v_ok := false;
        end if;
      end if;
      if not v_closed or v_spend < v_thr or v_txn < v_txn_min then
        v_all_closed_ok := false;
      end if;
    end loop;
    if v_ok and v_still_achievable is null then
      v_still_achievable := jsonb_build_object('threshold', v_thr, 'payout', v_payout);
    end if;
    if v_all_closed_ok and v_confirmed is null then
      v_confirmed := jsonb_build_object('threshold', v_thr, 'payout', v_payout);
    end if;
  end loop;

  v_forfeited := v_still_achievable is null;

  if v_forfeited and v_min_thr is not null then
    for i in 1..v_window loop
      v_mstatus := v_statuses -> (i - 1);
      if v_mstatus ? 'error' or v_mstatus ? 'has_rules' then
        continue;
      end if;
      v_spend := (v_mstatus -> 'spend' ->> 'total')::numeric;
      v_txn := (v_mstatus -> 'spend' ->> 'txn_count')::int;
      v_is_current := (v_mstatus -> 'period' ->> 'is_current')::boolean;
      v_days_left := (v_mstatus -> 'period' ->> 'days_left')::int;
      v_closed := (not v_is_current) and v_days_left = 0;
      if v_closed and (v_spend < v_min_thr or v_txn < v_min_txn_min) then
        v_blocking_members := v_blocking_members || jsonb_build_array(jsonb_build_object(
          'period_key', v_mstatus -> 'period' ->> 'key',
          'spend', v_spend, 'txn_count', v_txn,
          'spend_short', greatest(0, v_min_thr - v_spend),
          'txn_short', greatest(0, v_min_txn_min - v_txn)
        ));
      end if;
    end loop;
  end if;

  select bool_or(coalesce((s -> 'at_risk' ->> 'value')::boolean, false)) into v_any_current_at_risk
  from jsonb_array_elements(v_statuses) s;

  return jsonb_build_object(
    'method_id', p_method_id,
    'group_period_key', v_period_key,
    'window', v_window,
    'grouping', v_grouping,
    'anchor_unknown', v_anchor is null,
    'members', v_statuses,
    'still_achievable_tier', v_still_achievable,
    'confirmed_tier', v_confirmed,
    'forfeited', v_forfeited,
    'blocking_members', v_blocking_members,
    'at_risk', v_forfeited or coalesce(v_any_current_at_risk, false),
    'approx_payout_at_stake', case when v_forfeited then null
      else (v_still_achievable ->> 'payout')::numeric end
  );
end;
$$;

-- ============ EXAMPLE DATA: split out of 0002_seed.sql ============
-- See 0002_seed.sql's own updated header. A fresh deployment now ends
-- this migration with an EMPTY payment_methods table (aside from the
-- unrelated 'manual' and 'dbs_posb_platinum' infrastructure rows 0009/
-- 0004 insert regardless) — no example cards, no example rules. Loading
-- the Singapore walkthrough set is now an explicit, reversible operator
-- action from the dashboard (dashboard/components/config/
-- ExampleDataControls.tsx), not something a fresh clone inherits.
--
-- is_example tags exactly which rows a "load"/"clear" round-trip owns, so
-- clearing never touches a real card the operator added or edited by
-- hand under the same or a different id.

alter table payment_methods add column is_example boolean not null default false;
comment on column payment_methods.is_example is
  'true only for rows inserted by load_example_data_singapore(). Marks
   exactly what clear_example_data() is allowed to delete — an operator
   who "adopts" a loaded example card (edits its rules and keeps using
   it) keeps this flag true, so clearing later would still remove it;
   documented in the dashboard copy next to the clear action for exactly
   this reason.';

alter table merchants add column is_example boolean not null default false;
comment on column merchants.is_example is
  'Same tagging convention as payment_methods.is_example — the 2 example
   merchant seeds (TikTok Shop, Chrono24) load_example_data_singapore()
   inserts, for clear_example_data() to find again.';

-- security definer (the one other deviation from this project's
-- security-invoker convention, alongside is_operator() itself —
-- 0008_dashboard_rls.sql's justification applies identically here: this
-- is a fixed-shape, auditable, no-caller-SQL admin action gated by
-- is_operator() as its first statement, not a business-data accessor. Using
-- definer here avoids granting broad INSERT/DELETE on payment_methods/
-- method_rules/merchants to `authenticated` just for these two narrow
-- actions — the dashboard's operator-facing write surface for those
-- tables otherwise stays exactly UPDATE (active toggle) / INSERT+UPDATE
-- (method_rules, via the functions above), per the grants below.
create or replace function load_example_data_singapore()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not is_operator() then
    raise exception 'only the signed-in operator can load example data';
  end if;
  if exists (select 1 from payment_methods where id in ('uob_one', 'hsbc_revo', 'citi_cashback')) then
    raise exception 'example cards already exist (or a real card reuses one of their ids) — clear example data first';
  end if;

  insert into payment_methods
    (id, display_name, issuer, last4, method_type, period_type, cycle_day, reward_type, has_rules,
     active, currency, aggregation_window, reward_unit, is_example)
  values
    ('uob_one', 'UOB One', 'UOB', '1111', 'credit_card', 'statement', 15, 'cashback', true,
     true, 'SGD', 3, 'cashback_sgd_additional', true),
    ('hsbc_revo', 'HSBC Revolution', 'HSBC', '2222', 'credit_card', 'calendar', null, 'miles', true,
     true, 'SGD', null, 'miles_best_partner_equivalent_2.5to1', true),
    ('citi_cashback', 'Citi Cash Back', 'Citi', '5555', 'credit_card', 'statement', 20, 'cashback', true,
     true, 'SGD', null, 'cashback_sgd', true);

  -- Same rates/thresholds/notes as 0002_seed.sql's original example rows,
  -- with the 0015 columns (cap_basis/reward_form/gate_scope/
  -- credit_block_size/credit_floor/estimate_caveat) set inline instead of
  -- via a separate backfill, valid_from moved off citi_cashback's old
  -- 2099-01-01 "not yet issued" staging date (this demo card is live from
  -- day one), and status/proposed_by/reviewed_* set as if an operator had
  -- typed them — this is worked example data, not an AI proposal, so it
  -- is born 'active' with no review step. See docs/reference-example-sg.md's
  -- "Sources" section for the original T&C citations these numbers came from.
  insert into method_rules
    (method_id, rule_type, categories, threshold, rate, cap_amount, payout, txn_min, priority,
     valid_from, notes, cap_basis, reward_form, gate_scope, status, proposed_by, reviewed_at, reviewed_by)
  values
    ('uob_one', 'txn_count', null, null, null, null, null, 10, 100, '2025-07-01',
     'Posted transactions only. Gate applies per statement month, not per quarter. T&C clause 3.1.',
     null, null, 'tier_only', 'active', 'operator', now(), auth.uid()),

    ('uob_one', 'tier', null, 2000, null, null, 200, 10, 30, '2025-07-01',
     'Tier 3. Flat S$200/quarter. Effective rate ~3.33% is derived (200/6000), not stored.',
     null, 'fixed_payout', null, 'active', 'operator', now(), auth.uid()),
    ('uob_one', 'tier', null, 1000, null, null, 100, 10, 20, '2025-07-01',
     'Tier 2. Flat S$100/quarter. Effective rate ~3.33% is derived (100/3000).',
     null, 'fixed_payout', null, 'active', 'operator', now(), auth.uid()),
    ('uob_one', 'tier', null, 600, null, null, 60, 10, 10, '2025-07-01',
     'Tier 1. Flat S$60/quarter. Effective rate ~3.33% is derived (60/1800).',
     null, 'fixed_payout', null, 'active', 'operator', now(), auth.uid()),

    ('uob_one', 'category_rate', '{groceries}', 2000, 0.0467, null, null, null, 30, '2025-07-01',
     'Groceries at Tier 3', null, 'rate', null, 'active', 'operator', now(), auth.uid()),
    ('uob_one', 'category_rate', '{groceries}', 1000, 0.0267, null, null, null, 20, '2025-07-01',
     'Groceries at Tier 2', null, 'rate', null, 'active', 'operator', now(), auth.uid()),

    ('uob_one', 'category_rate', '{transport,commute}', 2000, 0.0667, null, null, null, 30, '2025-07-01',
     'Selected merchants at Tier 3: Grab, McDonald''s, Shopee, SimplyGo. Excludes Grab/Shopee wallet top-ups.',
     null, 'rate', null, 'active', 'operator', now(), auth.uid()),
    ('uob_one', 'category_rate', '{transport,commute}', 600, 0.05, null, null, null, 10, '2025-07-01',
     'Selected merchants at Tiers 1 and 2. Same exclusions.',
     null, 'rate', null, 'active', 'operator', now(), auth.uid()),

    ('uob_one', 'category_rate', '{petrol}', 2000, 0.0167, null, null, null, 30, '2025-07-01',
     'Shell only, Tier 3 only. No bonus at Tiers 1 or 2 — verify petrol merchant code before relying on this.',
     null, 'rate', null, 'active', 'operator', now(), auth.uid()),

    ('uob_one', 'category_rate', '{bills}', 600, 0.01, null, null, null, 10, '2025-07-01',
     'Singapore Power (SP) only, 1% at every tier including Tier 1.',
     null, 'rate', null, 'active', 'operator', now(), auth.uid()),

    ('uob_one', 'cap', null, null, null, 120, null, null, 0, '2025-07-01',
     'Additional cashback cap per statement month. Quarterly cashback (the S$60/100/200 tier payout) sits outside this cap.',
     'reward', null, null, 'active', 'operator', now(), auth.uid()),

    ('citi_cashback', 'min_spend', null, 800, null, null, null, null, 100, '2026-01-01',
     'Below S$800/statement month everything drops to 0.2% base. Excludes bill payments, education, government/tax/fines, insurance, SimplyGo transit, and more.',
     null, null, 'all_rewards', 'active', 'operator', now(), auth.uid()),
    ('citi_cashback', 'category_rate', '{petrol,commute}', null, 0.08, null, null, null, 30, '2026-01-01',
     '8% = 0.2% base + 7.8% bonus. Petrol MCC 5541/5542. Commute = taxi/private-hire only, MCC 4121 — excludes SimplyGo/transit.',
     null, 'rate', null, 'active', 'operator', now(), auth.uid()),
    ('citi_cashback', 'category_rate', '{dining,groceries}', null, 0.06, null, null, null, 20, '2026-01-01',
     '6% = 0.2% base + 5.8% bonus. Dining MCC 5811/5812/5814 — hotel restaurants (7011) and bars (5813) excluded. Groceries MCC 5411.',
     null, 'rate', null, 'active', 'operator', now(), auth.uid()),
    ('citi_cashback', 'category_rate', null, null, 0.002, null, null, null, 0, '2026-01-01',
     'Base rate, all other retail, and everything once the S$80 cap is hit.',
     null, 'rate', null, 'active', 'operator', now(), auth.uid()),
    ('citi_cashback', 'cap', null, null, null, 80, null, null, 0, '2026-01-01',
     'Combined across all bonus categories per statement month. Credits in S$10 multiples, only once accrual reaches S$50.',
     'reward', null, null, 'active', 'operator', now(), auth.uid()),

    ('hsbc_revo', 'category_rate', '{dining,retail,online,commute}', null, 4.0, null, null, null, 20, '2026-04-01',
     'Standard tier, PERMANENT. 10X points. Travel qualifies via online OR contactless; dining/shopping/transport/memberships require CONTACTLESS ONLY.',
     null, 'rate', null, 'active', 'operator', now(), auth.uid()),
    ('hsbc_revo', 'category_rate', '{dining,retail,online,commute}', null, 8.0, null, null, null, 25, '2026-04-01',
     'Enhanced tier. Requires >=S$50,000 average daily balance in a SOLE SGD HSBC Everyday Global Account, reassessed monthly. 20X points. Same category and contactless rules as standard tier.',
     null, 'rate', null, 'active', 'operator', now(), auth.uid()),
    ('hsbc_revo', 'category_rate', null, null, 0.4, null, null, null, 0, '2026-04-01',
     'Base rate, 1X points. Applies to groceries, petrol, transport, travel agencies, fast food, and any bonus-category spend not made contactless/online.',
     null, 'rate', null, 'active', 'operator', now(), auth.uid()),
    ('hsbc_revo', 'cap', null, null, null, 1000, null, null, 0, '2026-04-01',
     'Standard tier cap: first S$1,000 of eligible spend per CALENDAR month. Spend beyond earns base rate.',
     'spend', null, null, 'active', 'operator', now(), auth.uid()),
    ('hsbc_revo', 'cap', null, null, null, 1200, null, null, 5, '2026-04-01',
     'Enhanced (8 mpd / EGA) tier cap: first S$1,200 per CALENDAR month. Use this cap instead of the S$1,000 row when the EGA balance condition is met that month.',
     'spend', null, null, 'active', 'operator', now(), auth.uid());

  -- credit_block_size/credit_floor set separately: they only apply to
  -- citi_cashback's cap row, and inlining them above alongside every
  -- other row's null would make that one row's own values harder to spot
  -- than a single targeted UPDATE right after insert.
  update method_rules set credit_block_size = 10, credit_floor = 50
  where method_id = 'citi_cashback' and rule_type = 'cap';

  -- condition_key = 'ega': the enhanced-tier category_rate row (priority
  -- 25) and its matching cap row (priority 5) are the only two rows
  -- gated on the operator-set EGA balance condition (see
  -- method_conditions, 0015) — same two rows 0007's original requires_ega
  -- backfill identified. requires_ega is set alongside condition_key,
  -- both true, to satisfy method_rules_condition_key_requires_ega_
  -- consistent (0015) — the two columns describe the same fact and must
  -- stay in sync, exactly as that constraint requires for every row, not
  -- only 0002's original ones. Absence of a method_conditions row for a
  -- given month (the default) means the condition is not met, same safe
  -- default as always; the dashboard does not set method_conditions rows
  -- itself (out of WP5's scope, same as 0008's read-only hsbc_ega_months
  -- policy) — an operator wanting to exercise this tier in the demo sets
  -- one via SQL, per method_conditions' own table comment.
  update method_rules set condition_key = 'ega', requires_ega = true
  where method_id = 'hsbc_revo' and rule_type = 'category_rate' and priority = 25;
  update method_rules set condition_key = 'ega', requires_ega = true
  where method_id = 'hsbc_revo' and rule_type = 'cap' and priority = 5;

  -- hsbc_revo's contactless/online caveat, same as 0015's original
  -- backfill onto both bonus-category rows.
  update method_rules
    set estimate_caveat = 'Assumes bonus-category spend was made contactless or online (required for the bonus rate) — unconfirmed until statement reconciliation.'
  where method_id = 'hsbc_revo' and rule_type = 'category_rate' and categories is not null;

  insert into merchants (match_pattern, display_name, category, hsbc_eligible, is_transfer, confidence, is_example)
  values
    ('TIKTOK SHOP', 'TikTok Shop', 'online', true, false, 'guessed', true),
    ('CHRONO24', 'Chrono24', 'retail', true, false, 'guessed', true)
  on conflict (match_pattern) do nothing;

  return 'Loaded 3 example cards (UOB One, HSBC Revolution, Citi Cash Back) and 2 example merchants.';
end;
$$;

comment on function load_example_data_singapore is
  'Operator-triggered only (is_operator() checked first, before any
   write). Refuses to run if uob_one/hsbc_revo/citi_cashback already
   exist, so it can never silently clobber a real card the operator
   deployed under the same id. Data verified against official issuer T&Cs
   as of August 2026 (see docs/reference-example-sg.md''s "Sources"
   section) — same numbers 0002_seed.sql originally shipped, moved here so
   a fresh deployment does not inherit them automatically.';

create or replace function clear_example_data()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_card_count int;
begin
  if not is_operator() then
    raise exception 'only the signed-in operator can clear example data';
  end if;

  select count(*) into v_card_count from payment_methods where is_example;

  delete from method_conditions where method_id in (select id from payment_methods where is_example);
  -- hsbc_ega_months (0007) is the legacy, still-live twin of
  -- method_conditions (0015's header: kept for one release cycle as a
  -- rollback path, never dropped by this migration) and carries the same
  -- payment_methods(id) foreign key — an operator who set an EGA flag
  -- via the old table (or a QA fixture that seeds it directly, as
  -- qa-wp1's does) would otherwise leave a row that blocks the
  -- payment_methods delete below with a foreign-key violation.
  delete from hsbc_ega_months where method_id in (select id from payment_methods where is_example);
  delete from method_rules where method_id in (select id from payment_methods where is_example);
  delete from transactions where method_id in (select id from payment_methods where is_example);
  delete from payment_methods where is_example;
  -- A real transaction (on a real card, not one of the example ones just
  -- removed above) could in principle have already been classified
  -- against one of these two example merchants, e.g. a genuine TikTok
  -- Shop purchase on the operator's actual card. Unlinking rather than
  -- leaving the delete to fail on that foreign key: the transaction
  -- itself is real and must survive, only its merchant classification is
  -- an example-data leftover.
  update transactions set merchant_id = null
  where merchant_id in (select id from merchants where is_example);
  delete from merchants where is_example;

  return format('Cleared %s example card(s) and their rules, merchants and any transactions logged against them.', v_card_count);
end;
$$;

comment on function clear_example_data is
  'Deletes only rows this same migration''s loader tagged is_example =
   true — never a card or rule the operator typed by hand, even one that
   reused an example''s id after a prior clear. Also removes any
   transactions logged against an example card (manual entries made while
   trying the demo) so the delete cannot fail on the payment_methods FK.';

-- ============ RLS + GRANTS ============
-- method_rules: was SELECT-only for authenticated (0008). This migration
-- is the first to give it a write surface — INSERT (via submit_method_
-- rule) and UPDATE (via edit_method_rule/approve_method_rule/
-- reject_method_rule, and the trigger-validated fallback of a direct
-- UPDATE), both gated on is_operator() exactly like every other
-- operator-write table in this codebase (budgets, transactions manual
-- rows, merchants triage columns — 0008's own precedent). No DELETE
-- policy: a decided rule (active or rejected) is kept, never deleted,
-- per this migration's own "must not silently vanish" requirement —
-- clear_example_data() above is the one place a method_rules row is ever
-- deleted, and it runs security definer, not through this grant.

grant insert, update on method_rules to authenticated;
grant usage, select on sequence method_rules_id_seq to authenticated;

create policy "operator inserts method_rules" on method_rules
  for insert to authenticated
  with check (is_operator());

create policy "operator updates method_rules" on method_rules
  for update to authenticated
  using (is_operator())
  with check (is_operator());

-- payment_methods: was SELECT-only for authenticated (0008). Adds
-- exactly the "activate/deactivate a card" write surface (scope item 4)
-- — a column-level grant restricted to `active`, same shape as
-- merchants' triage-column grant in 0008, so nothing else on this row
-- (issuer, last4, cycle_day, every rules-engine column) is reachable
-- from the browser even though the row itself is selectable for update.
-- INSERT/DELETE on payment_methods stay default-deny for authenticated:
-- the only path that creates/removes a payment_methods row is
-- load_example_data_singapore()/clear_example_data() above, which are
-- security definer and do not need this grant.

grant update (active) on payment_methods to authenticated;

create policy "operator toggles payment method active state" on payment_methods
  for update to authenticated
  using (is_operator())
  with check (is_operator());

-- Function grants. Every function below is re-revoked from PUBLIC before
-- being granted to authenticated, for the same "close the
-- grant-to-PUBLIC-on-CREATE-FUNCTION gap" reason 0007/0008 already
-- document at length — restated per function rather than relied on from
-- 0001's ALTER DEFAULT PRIVILEGES, which only binds the role that issued
-- it. None are granted to anon.
revoke execute on function
  submit_method_rule(text, text, text[], numeric, numeric, numeric, numeric, int, int, date, date, text,
    text, text, text, numeric, numeric, text, text, text, jsonb, text, numeric),
  edit_method_rule(bigint, numeric, numeric, numeric, numeric, int, text[], text, date),
  approve_method_rule(bigint, text),
  reject_method_rule(bigint, text),
  preview_method_rule(bigint, text),
  load_example_data_singapore(),
  clear_example_data()
from public;

grant execute on function
  submit_method_rule(text, text, text[], numeric, numeric, numeric, numeric, int, int, date, date, text,
    text, text, text, numeric, numeric, text, text, text, jsonb, text, numeric),
  edit_method_rule(bigint, numeric, numeric, numeric, numeric, int, text[], text, date),
  approve_method_rule(bigint, text),
  reject_method_rule(bigint, text),
  preview_method_rule(bigint, text),
  load_example_data_singapore(),
  clear_example_data()
to authenticated;

-- evaluate_period()/evaluate_period_group() were CREATE OR REPLACE'd
-- above, same signatures as 0015 — their existing grants (0015: EXECUTE
-- to authenticated, revoked from public) already cover the amended
-- bodies; PostgreSQL does not reset a function's grants on REPLACE.
