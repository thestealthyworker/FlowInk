"""WP7: the five-stage validator for AI-emitted `method_rules`/
`payment_methods` config (`docs/onboarding-spec.md`).

WHY THIS LIVES IN PYTHON, AS A SCRIPT, NOT AN EDGE FUNCTION OR A SQL
FUNCTION
---------------------------------------------------------------------
Three real choices existed:

1. A SQL function, callable from `psql`/the SQL editor. Rejected: stages
   1 (JSON Schema shape) and 4 (citation-URL sanity) are string/shape
   checks a general-purpose language does far more legibly than plpgsql,
   and — the more important reason — an AI agent (Claude Code, Codex)
   driving this flow from a terminal has no natural way to hand a large
   JSON document into `psql` as a bound parameter without a wrapper
   script anyway. Every check this module *can* delegate to the database
   (stage 3's real evaluation, stage 5's diff) it does — see
   `RulesEngineClient` below — this module owns only what genuinely
   needs to run before a network call.
2. A Supabase Edge Function (Deno/TS). Rejected on architectural grounds
   this codebase already states directly: Edge Functions are the *live,
   scheduled* runtime (`docs/architecture.md` §2's "why two runtimes, not
   one" — Edge Functions for the 2-minute cron, GitHub Actions/local
   scripts for anything longer-running or interactively driven). Running
   an AI-assisted setup session against a live cron endpoint would need
   its own auth story and doesn't match how this repo's other
   interactive/batch tooling already works.
3. **A Python script, using the same `SupabaseREST` PostgREST client
   `scripts/ingest_statements.py`/`scripts/reconcile.py` already use**
   (`scripts/lib/supabase_rest.py`). Chosen: it is this codebase's own
   existing convention for "a script that isn't a scheduled Edge
   Function, talks to Supabase over the REST API with the service-role
   key, and is meant to be run by a person or an agent from a terminal"
   (`supabase_rest.py`'s own docstring). WP7 runs as `service_role` per
   `0018_config_review.sql`'s header — this is precisely the runtime
   shape that comment describes, and this module fits into it rather
   than inventing a fourth runtime. It is directly runnable by a human
   (`python3 scripts/validate_ai_config.py config.json`) with no new
   infrastructure.

WHAT THIS MODULE DOES AND DOES NOT DO
---------------------------------------------------------------------
This module validates and — for whatever survives — submits. It is
layered ON TOP of `method_rules_validate()` (0018's BEFORE INSERT
trigger), never a replacement for it: several checks below intentionally
mirror that trigger's required-field rules so a caller gets a clear,
actionable message before a round trip to the database, but the trigger
still runs on every INSERT this module ever issues, unconditionally.
This module never inserts into `method_rules` directly and never calls
anything but `submit_method_rule()` to create a row — see that
migration's header, "WHAT WP7 MUST NOT DO."

THE FIVE STAGES, AND WHY THIS ORDERING
---------------------------------------------------------------------
The task brief lists: schema, referential, semantic, confidence gate,
dry-run diff. This module runs them schema -> referential -> confidence
-> semantic -> dry-run-diff — confidence *before* semantic, deliberately
inverted from the brief's listed order, because the confidence gate is
free (no network call) and semantic validation's second half (§3 below)
is not: it calls `submit_method_rule()`, which is a real write (landing
`pending_review`, but still a write, still auditable, still something a
human will see in the review queue even if never approved). A rule that
already fails the confidence gate — an uncited claim asserted with
unwarranted confidence — gets rejected before it ever reaches the
database, not after. "Reject loudly, never silently drop" applies to
*when* a rule is stopped, not only to whether it eventually is.

Concretely, per rule:
  1. SCHEMA    (`_schema_issues`)      — shape, types, units, enum
     membership, required-vs-permitted fields per rule_type. Zero
     network calls.
  2. REFERENTIAL (`_referential_issues`) — method_id exists (in this
     submission or already in the database), no duplicate/overlapping
     rule for the same method/window. Needs the caller's existing-data
     snapshot (`ExistingData`), no new network call of its own.
  3. CONFIDENCE (`_confidence_issues`) — an uncited claim may not carry
     high self-rated confidence. Zero network calls.
  4. SEMANTIC  — two parts:
     4a. Plausibility bounds (`_semantic_issues`), zero network calls:
         catches the class of error the trigger's own numeric checks
         (positive/non-negative) cannot, because a rate of `0.5` or a
         transposed tier payout is perfectly valid arithmetic, just
         wrong by an order of magnitude for what it claims to be.
     4b. A real round trip through `submit_method_rule()` then
         `preview_method_rule()` (`RulesEngineClient`) — proves the row
         doesn't just parse, it *evaluates*, against the real
         evaluator, not a reimplementation of it. A rule that blows up
         `evaluate_period()` is caught here and immediately
         `reject_method_rule()`-ed with the real error as the reason —
         never left dangling as an unexplained pending row.
  5. DRY-RUN DIFF — the `preview_method_rule()` result from 4b, as-is.
     Not a second call: `preview_method_rule()` already computes the
     real evaluator's answer with and without this exact row
     (`0018_config_review.sql`'s comment on that function) — stage 5 is
     that same result, formatted for a reviewer, not a fresh comparison
     reimplemented here. See `format_report()`.

A rule that fails stage 1 or 2 never reaches 3; a rule that fails 3 or
4a never reaches 4b (never touches the database at all). Every rejection
carries a specific, human-actionable reason (`Issue.message`) — nothing
here ever drops a rule with no explanation, and nothing here silently
"fixes" an input by guessing what was meant.
"""
from __future__ import annotations

import ipaddress
import re
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Protocol
from urllib.parse import urlparse

from .senders import is_valid_domain_syntax

# ============ SHARED VOCABULARY ============
# Mirrors supabase/functions/_shared/categories.ts and
# dashboard/lib/supabase/types.ts's CATEGORIES — this project's existing
# convention (see README's "scripts/lib/ Python ports of the _shared/
# helpers") is to keep a hand-maintained copy per runtime rather than
# share a package across TS and Python. Keep in sync by hand if the
# vocabulary ever changes; `0001_schema.sql`'s CHECK constraints are the
# actual source of truth this list must match.
CATEGORIES: frozenset[str] = frozenset({
    "groceries", "dining", "petrol", "commute", "transport",
    "bills", "online", "retail", "healthcare", "household", "other",
})

# rule_type CHECK (0001_schema.sql) allows 'quarterly_gate' too, but
# 0018's own trigger comment is explicit that it is legacy/unreachable
# from a real evaluator primitive ("Legacy rule_type ... never consumed
# by evaluate_period()/evaluate_period_group()") — an AI proposing one
# would silently write a row with zero effect on any real number, which
# is exactly the "technically valid, produces nonsense" failure class
# this validator exists to catch. Never accepted from this path.
RULE_TYPES: frozenset[str] = frozenset({"min_spend", "tier", "category_rate", "cap", "txn_count"})
CAP_BASIS_VALUES: frozenset[str] = frozenset({"reward", "spend"})
REWARD_FORM_VALUES: frozenset[str] = frozenset({"rate", "fixed_payout"})
GATE_SCOPE_VALUES: frozenset[str] = frozenset({"tier_only", "all_rewards"})

METHOD_TYPE_VALUES: frozenset[str] = frozenset({"credit_card", "wallet", "bank", "cash"})
PERIOD_TYPE_VALUES: frozenset[str] = frozenset({"calendar", "statement"})
REWARD_TYPE_VALUES: frozenset[str] = frozenset({"cashback", "miles"})

_CURRENCY_RE = re.compile(r"^[A-Z]{3}$")
_LAST4_RE = re.compile(r"^\d{4}$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
# payment_methods[].id charset (Fix 4 of the WP7 QA review): plain ASCII
# lowercase snake_case, matching every id already in production use
# (uob_one, citi_cashback, hsbc_revo, paylah) and docs/onboarding-spec.md
# §3's own "lowercase, snake_case, stable" description. Domain fields
# already get an ASCII-only charset check (is_valid_domain_syntax, see
# senders.py) precisely so a Cyrillic lookalike can never compare equal
# to a real domain; method_id previously had no such check at all — a
# mixed-script lookalike id would create a confusingly duplicate-looking
# payment method rather than actually matching an existing row.
_METHOD_ID_RE = re.compile(r"^[a-z][a-z0-9_]*$")

# Fields a rule_type genuinely reads, per evaluate_period()
# (0015_generic_rules_engine.sql) — see that function's own per-type
# queries: gate rows (`min_spend`/`txn_count`) select only
# threshold/txn_min/gate_scope; `tier` rows select threshold/payout(/rate
# when reward_form='rate'); `category_rate` rows select
# categories/threshold/rate/reward_form/estimate_caveat; `cap` rows
# select cap_amount/cap_basis/credit_block_size/credit_floor. A non-null
# value in any OTHER numeric/enum field is not rejected by the trigger
# (method_rules_validate only checks required-for-type, not
# extraneous-for-type) and is silently ignored by evaluate_period() —
# exactly the "schema-valid but semantically wrong" case a transposed
# field produces (e.g. a value meant for `cap_amount` typed into
# `threshold` on the same row). Rejected here, not just at the trigger.
_MEANINGFUL_FIELDS: dict[str, frozenset[str]] = {
    "min_spend": frozenset({"threshold", "gate_scope"}),
    "txn_count": frozenset({"txn_min", "gate_scope"}),
    "tier": frozenset({"threshold", "payout", "txn_min", "rate", "reward_form"}),
    "category_rate": frozenset({"categories", "threshold", "rate", "reward_form", "estimate_caveat"}),
    "cap": frozenset({"cap_amount", "cap_basis", "credit_block_size", "credit_floor"}),
}
_ALL_TYPE_SPECIFIC_FIELDS: frozenset[str] = frozenset(
    {"threshold", "rate", "cap_amount", "payout", "txn_min", "cap_basis",
     "credit_block_size", "credit_floor", "reward_form", "gate_scope", "estimate_caveat"}
)

# Plausibility ceilings for stage 4a. Deliberately generous — wide enough
# not to reject a real, unusual-but-legitimate promotion, tight enough to
# catch the actual failure mode this exists for: a decimal-point or
# percent-vs-fraction slip that's wrong by 10x-100x. See
# docs/onboarding-spec.md §4 for the worked examples these numbers are
# calibrated against (uob_one's real rates top out at 0.0667; hsbc_revo's
# miles rates run 0.4-8.0).
MAX_CASHBACK_RATE = 0.30          # 30% — see docs/onboarding-spec.md §4
MAX_MILES_RATE = 30.0             # 30 miles/points per currency unit
MAX_TIER_IMPLIED_RATE = 0.50      # payout / threshold, fixed_payout tiers
CITATION_REQUIRED_CONFIDENCE_CEILING = 0.2

_PLACEHOLDER_HOSTS = frozenset({
    "example.com", "www.example.com", "yourbank.com", "todo.com", "issuer.com",
})


def _is_bare_ip_host(host: str) -> bool:
    """True if ``host`` is a raw IPv4/IPv6 literal rather than a DNS name.
    A real issuer's own T&C page is never cited by IP address — this is a
    plausibility signal, same spirit as the placeholder-host list."""
    candidate = host[1:-1] if host.startswith("[") and host.endswith("]") else host
    try:
        ipaddress.ip_address(candidate)
        return True
    except ValueError:
        return False


def _looks_like_real_citation(citation: dict) -> bool:
    """A citation counts only if it carries a URL that could plausibly be
    dereferenced — never a bare title ("UOB's website"), never a known
    placeholder host. This is a syntax/plausibility check, not proof the
    URL is live or says what the rule claims — see
    docs/onboarding-spec.md §2/§5 for what standard the AI is asked to
    hold itself to; this function only catches what a machine can catch.
    Nothing here ever dereferences the URL.

    Host extraction uses ``urlparse(...).hostname``, never a hand-rolled
    split on ``netloc``. QA found that the previous
    ``parsed.netloc.lower().split(":")[0]`` returns the *username* when
    the URL carries embedded credentials (``netloc`` is
    ``user:pass@host[:port]``) — ``https://x:y@example.com/tnc`` parsed to
    host ``"x"``, silently bypassing every entry in ``_PLACEHOLDER_HOSTS``
    (`_looks_like_real_citation({'url': 'https://example.com/tnc'})` is
    `False`, but the credentialed variant of the same host was `True`).
    ``.hostname`` is already lowercased and strips both userinfo and port,
    closing that whole class of bug rather than special-casing the ``@``.
    """
    url = citation.get("url") if isinstance(citation, dict) else None
    if not isinstance(url, str) or len(url) < 15:
        return False
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return False
    # A legitimate citation to a bank's own PUBLISHED terms never needs
    # embedded credentials — their presence is itself a signal something
    # is wrong (at best pointless, at worst exactly the ``user:pass@host``
    # shape that defeated the old host-parsing logic above). Reject
    # outright rather than trying to parse safely around it.
    if parsed.username is not None or parsed.password is not None:
        return False
    try:
        host = parsed.hostname  # already lowercased; userinfo/port stripped
    except ValueError:
        return False
    if not host:
        return False
    host = host.rstrip(".")  # a trailing root-zone dot is not a distinct host
    if host in _PLACEHOLDER_HOSTS:
        return False
    if _is_bare_ip_host(host):
        return False
    return True


def has_real_citation(rule: dict) -> bool:
    citations = rule.get("source_citations") or []
    return isinstance(citations, list) and any(
        isinstance(c, dict) and _looks_like_real_citation(c) for c in citations
    )


# ============ ISSUES / OUTCOMES ============

@dataclass
class Issue:
    stage: str            # 'schema' | 'referential' | 'confidence' | 'semantic' | 'dry_run' | 'payment_method'
    severity: str         # 'reject' | 'warn'
    message: str
    rule_index: int | None = None       # index into config['rules'], or None
    method_index: int | None = None     # index into config['payment_methods'], or None

    def is_reject(self) -> bool:
        return self.severity == "reject"


@dataclass
class RuleOutcome:
    index: int
    method_id: str | None
    rule_type: str | None
    issues: list[Issue] = field(default_factory=list)
    accepted: bool = False          # True iff a method_rules row was created (status pending_review or active)
    submitted_row: dict | None = None
    preview: dict | None = None
    rejected_after_submit: bool = False   # True iff created, then reject_method_rule()-ed by this validator

    @property
    def rejected(self) -> bool:
        return not self.accepted


@dataclass
class PaymentMethodOutcome:
    """Per-`payment_methods[]`-entry outcome (Fix 1 of the WP7 QA
    review): what changed on an EXISTING method, whether it was written,
    and — when it was not — exactly which fields blocked it. `diff` is
    populated for any existing-method row that differs from the stored
    one in any field the operator would care to see (a superset of
    `blocked_fields`, which is the subset that is actually
    alert_senders/statement_senders/last4 and therefore refused). A
    brand-new method (`is_new=True`) has nothing to diff against — it is
    written straight through once schema-valid, same as before this
    fix."""
    index: int                          # index into config['payment_methods']
    id: str | None
    is_new: bool
    written: bool
    diff: dict[str, tuple[Any, Any]] = field(default_factory=dict)           # field -> (old, new)
    blocked_fields: dict[str, tuple[Any, Any]] = field(default_factory=dict)  # subset of `diff` that blocked the write


@dataclass
class ValidationReport:
    payment_method_issues: list[Issue] = field(default_factory=list)
    payment_methods_written: list[dict] = field(default_factory=list)
    payment_method_outcomes: list[PaymentMethodOutcome] = field(default_factory=list)
    rule_outcomes: list[RuleOutcome] = field(default_factory=list)

    @property
    def accepted_rules(self) -> list[RuleOutcome]:
        return [r for r in self.rule_outcomes if r.accepted]

    @property
    def rejected_rules(self) -> list[RuleOutcome]:
        return [r for r in self.rule_outcomes if r.rejected]

    def ok(self) -> bool:
        """False if any payment_method-level reject issue exists — a
        run with only rejected *rules* is still "ok" in the sense that
        the validator did its job (rejecting loudly); the caller decides
        what exit code that deserves. See validate_ai_config.py."""
        return not any(i.is_reject() for i in self.payment_method_issues)


# ============ CLIENT INTERFACE ============
# Structural (Protocol), not a hard dependency on SupabaseRulesClient —
# same convention as scripts/lib/senders.py's _SupportsSelect, so tests
# can pass any object shaped like this, including a fully offline fake.

class RulesEngineClient(Protocol):
    def list_payment_methods(self) -> list[dict]: ...
    def list_method_rules(self, method_ids: list[str]) -> list[dict]: ...
    def upsert_payment_methods(self, rows: list[dict]) -> list[dict]: ...
    def submit_method_rule(self, **kwargs: Any) -> dict: ...
    def preview_method_rule(self, rule_id: int, period_key: str | None = None) -> dict: ...
    def reject_method_rule(self, rule_id: int, review_note: str) -> dict: ...


class SupabaseRulesClient:
    """Production `RulesEngineClient`, over `SupabaseREST`
    (`scripts/lib/supabase_rest.py`) — service_role key, PostgREST REST
    API, matching this codebase's existing GitHub-Actions-runtime
    convention. Every write funnels through `submit_method_rule()` /
    `reject_method_rule()`; every read is a plain `select`."""

    def __init__(self, rest: Any) -> None:
        self._rest = rest

    def list_payment_methods(self) -> list[dict]:
        return self._rest.select("payment_methods", {"select": "*"})

    def list_method_rules(self, method_ids: list[str]) -> list[dict]:
        if not method_ids:
            return []
        ids = ",".join(method_ids)
        return self._rest.select(
            "method_rules",
            {"select": "*", "method_id": f"in.({ids})", "status": "in.(active,pending_review)"},
        )

    def upsert_payment_methods(self, rows: list[dict]) -> list[dict]:
        if not rows:
            return []
        return self._rest.insert("payment_methods", rows, on_conflict="id")

    def submit_method_rule(self, **kwargs: Any) -> dict:
        return self._rest.rpc("submit_method_rule", kwargs)

    def preview_method_rule(self, rule_id: int, period_key: str | None = None) -> dict:
        return self._rest.rpc("preview_method_rule", {"p_rule_id": rule_id, "p_period_key": period_key})

    def reject_method_rule(self, rule_id: int, review_note: str) -> dict:
        return self._rest.rpc("reject_method_rule", {"p_rule_id": rule_id, "p_review_note": review_note})


# ============ STAGE 1: SCHEMA ============

def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _valid_date(s: Any) -> bool:
    if not isinstance(s, str) or not _DATE_RE.match(s):
        return False
    try:
        date.fromisoformat(s)
        return True
    except ValueError:
        return False


def _pm_schema_issues(pm: dict, idx: int) -> list[Issue]:
    issues: list[Issue] = []

    def reject(msg: str) -> None:
        issues.append(Issue("schema", "reject", msg, method_index=idx))

    def warn(msg: str) -> None:
        issues.append(Issue("schema", "warn", msg, method_index=idx))

    mid = pm.get("id")
    if not isinstance(mid, str) or not mid:
        reject("payment_methods[].id is required and must be a non-empty string.")
    elif not _METHOD_ID_RE.match(mid):
        # Every existing id (uob_one, citi_cashback, hsbc_revo, paylah) is
        # plain ASCII lowercase snake_case — the spec itself says so (§3:
        # "lowercase, snake_case, stable"). Domain fields already get a
        # charset check (is_valid_domain_syntax, ASCII-only by design —
        # see senders.py's own comment on why a Cyrillic lookalike must
        # never compare equal to a real domain); method_id had none. A
        # Cyrillic- or other-script lookalike id (e.g. an 'о' that isn't
        # 'o') would create a payment_methods row that LOOKS like an
        # existing card in a listing but is_valid a distinct row —
        # confusingly duplicate, not caught by the (id, ...) primary key.
        reject(f"payment_methods[{idx}].id={mid!r} must be plain ASCII lowercase snake_case "
               "(letters, digits, underscore, starting with a letter) — matching every id already "
               "in use (uob_one, citi_cashback, hsbc_revo, paylah). A non-ASCII or mixed-script "
               "character here (e.g. a Cyrillic lookalike of a Latin letter) would create a "
               "confusingly duplicate-looking payment method rather than actually matching an "
               "existing one.")
    for field_name in ("display_name", "issuer"):
        if not isinstance(pm.get(field_name), str) or not pm.get(field_name):
            reject(f"payment_methods[{idx}].{field_name} is required and must be a non-empty string.")

    method_type = pm.get("method_type")
    if method_type not in METHOD_TYPE_VALUES:
        reject(f"payment_methods[{idx}].method_type must be one of {sorted(METHOD_TYPE_VALUES)}, got {method_type!r}.")

    period_type = pm.get("period_type")
    if period_type not in PERIOD_TYPE_VALUES:
        reject(f"payment_methods[{idx}].period_type must be one of {sorted(PERIOD_TYPE_VALUES)}, got {period_type!r}.")

    cycle_day = pm.get("cycle_day")
    if cycle_day is not None and not (isinstance(cycle_day, int) and not isinstance(cycle_day, bool) and 1 <= cycle_day <= 31):
        reject(f"payment_methods[{idx}].cycle_day must be an integer 1..31, or null. Got {cycle_day!r}.")

    reward_type = pm.get("reward_type")
    if reward_type is not None and reward_type not in REWARD_TYPE_VALUES:
        reject(f"payment_methods[{idx}].reward_type must be 'cashback', 'miles', or null. Got {reward_type!r}.")
    if pm.get("has_rules", True) and reward_type is None:
        warn(f"payment_methods[{idx}] has has_rules=true but reward_type is null — rate-unit plausibility "
             "checks (docs/onboarding-spec.md §4) cannot run for this method's rules without it.")

    last4 = pm.get("last4")
    if last4 is not None and not _LAST4_RE.match(str(last4)):
        reject(f"payment_methods[{idx}].last4 must be exactly 4 digits, or null (\"not issued yet\"). Got {last4!r}.")

    currency = pm.get("currency")
    if not isinstance(currency, str) or not _CURRENCY_RE.match(currency):
        reject(f"payment_methods[{idx}].currency must be a 3-uppercase-letter ISO 4217 code. Got {currency!r}.")

    for domain_field in ("alert_senders", "statement_senders"):
        val = pm.get(domain_field)
        if val is None:
            continue
        if not isinstance(val, list) or not val:
            reject(f"payment_methods[{idx}].{domain_field} must be a non-empty list of domains, or null "
                   "(never an empty list — 0014's own column comment: null/empty must both mean "
                   "\"not configured\", so an empty list is pointless and confusing here).")
            continue
        for d in val:
            if not isinstance(d, str) or not is_valid_domain_syntax(d.lower()):
                reject(f"payment_methods[{idx}].{domain_field} contains {d!r}, which is not a plausible "
                       "DNS hostname. Never guess a domain you have not seen in a real email "
                       "(docs/onboarding-spec.md §6).")

    aw = pm.get("aggregation_window")
    if aw is not None and not (isinstance(aw, int) and not isinstance(aw, bool) and aw >= 2):
        reject(f"payment_methods[{idx}].aggregation_window must be an integer >= 2, or null. Got {aw!r}.")

    aad = pm.get("aggregation_anchor_date")
    if aad is not None and not _valid_date(aad):
        reject(f"payment_methods[{idx}].aggregation_anchor_date must be an ISO date (YYYY-MM-DD), or null. Got {aad!r}.")

    return issues


def _rule_schema_issues(rule: dict, idx: int) -> list[Issue]:
    issues: list[Issue] = []

    def reject(msg: str) -> None:
        issues.append(Issue("schema", "reject", msg, rule_index=idx))

    method_id = rule.get("method_id")
    if not isinstance(method_id, str) or not method_id:
        reject(f"rules[{idx}].method_id is required and must be a non-empty string.")

    rule_type = rule.get("rule_type")
    if rule_type not in RULE_TYPES:
        if rule_type == "quarterly_gate":
            reject(f"rules[{idx}].rule_type is 'quarterly_gate' — a legacy type with no evaluator support "
                   "(0018_config_review.sql's own comment on method_rules_validate()). Never emit it; "
                   "express a cross-period mechanic via payment_methods.aggregation_window/"
                   "aggregation_anchor_date instead, or say the mechanic is not expressible "
                   "(docs/onboarding-spec.md §4).")
        else:
            reject(f"rules[{idx}].rule_type must be one of {sorted(RULE_TYPES)}, got {rule_type!r}.")
        return issues  # can't run type-specific checks below without a known type

    categories = rule.get("categories")
    if categories is not None:
        if not isinstance(categories, list) or not categories:
            reject(f"rules[{idx}].categories must be a non-empty list, or null (\"applies to all\"). "
                   f"Got {categories!r}.")
        else:
            bad = [c for c in categories if c not in CATEGORIES]
            if bad:
                reject(f"rules[{idx}].categories contains {bad!r}, outside the fixed 11-value vocabulary "
                       f"{sorted(CATEGORIES)}.")
            if len(set(categories)) != len(categories):
                reject(f"rules[{idx}].categories contains a duplicate entry: {categories!r}.")

    for numeric_field in ("threshold", "rate", "cap_amount", "payout", "credit_block_size", "credit_floor"):
        v = rule.get(numeric_field)
        if v is not None and not _is_number(v):
            reject(f"rules[{idx}].{numeric_field} must be a number, or null. Got {v!r}.")

    txn_min = rule.get("txn_min")
    if txn_min is not None and not (isinstance(txn_min, int) and not isinstance(txn_min, bool)):
        reject(f"rules[{idx}].txn_min must be an integer, or null. Got {txn_min!r}.")
    elif txn_min == 0:
        # Fix 4 of the WP7 QA review: evaluate_period() reads
        # coalesce(txn_min, 0) everywhere (0007_rules_engine.sql,
        # 0015_generic_rules_engine.sql) — txn_min=0 is therefore
        # BEHAVIOURALLY IDENTICAL to leaving it null, i.e. an
        # always-cleared gate that only misleadingly implies a
        # transaction-count requirement exists. The DB trigger
        # (0018_config_review.sql) only rejects txn_min < 0, so this
        # value sails through every stage today with no actual effect.
        reject(f"rules[{idx}].txn_min=0 is a degenerate gate that is ALWAYS cleared — "
               "evaluate_period() treats a null txn_min identically (coalesce(txn_min, 0)), so 0 adds "
               "no real requirement while looking like one. Use null for 'no transaction-count "
               "requirement', or a positive integer for a real one.")

    priority = rule.get("priority", 0)
    if priority is not None and not (isinstance(priority, int) and not isinstance(priority, bool)):
        reject(f"rules[{idx}].priority must be an integer. Got {priority!r}.")

    valid_from = rule.get("valid_from")
    if not _valid_date(valid_from):
        reject(f"rules[{idx}].valid_from is required and must be an ISO date (YYYY-MM-DD). Got {valid_from!r}.")
    valid_to = rule.get("valid_to")
    if valid_to is not None:
        if not _valid_date(valid_to):
            reject(f"rules[{idx}].valid_to must be an ISO date, or null. Got {valid_to!r}.")
        elif _valid_date(valid_from) and date.fromisoformat(valid_to) < date.fromisoformat(valid_from):
            reject(f"rules[{idx}].valid_to ({valid_to}) is before valid_from ({valid_from}).")

    cap_basis = rule.get("cap_basis")
    if rule_type == "cap":
        if cap_basis not in CAP_BASIS_VALUES:
            reject(f"rules[{idx}] is rule_type='cap' and requires cap_basis in {sorted(CAP_BASIS_VALUES)}. "
                   f"Got {cap_basis!r}.")
        if rule.get("cap_amount") is None:
            reject(f"rules[{idx}] is rule_type='cap' and requires cap_amount.")
    elif cap_basis is not None:
        reject(f"rules[{idx}].cap_basis is only meaningful on rule_type='cap' rows (this row is "
               f"'{rule_type}') and evaluate_period() never reads it here — remove it. "
               "(docs/onboarding-spec.md §4's 'a technically-valid row that would make the evaluator "
               "produce nonsense' case.)")

    reward_form = rule.get("reward_form")
    if reward_form is not None and reward_form not in REWARD_FORM_VALUES:
        reject(f"rules[{idx}].reward_form must be 'rate', 'fixed_payout', or null. Got {reward_form!r}.")

    gate_scope = rule.get("gate_scope")
    if gate_scope is not None:
        if gate_scope not in GATE_SCOPE_VALUES:
            reject(f"rules[{idx}].gate_scope must be 'tier_only', 'all_rewards', or null. Got {gate_scope!r}.")
        if rule_type not in ("min_spend", "txn_count"):
            reject(f"rules[{idx}].gate_scope is only meaningful on rule_type in ('min_spend','txn_count') "
                   f"(this row is '{rule_type}') — remove it.")

    if rule_type == "tier":
        if rule.get("threshold") is None:
            reject(f"rules[{idx}] is rule_type='tier' and requires threshold.")
        if (reward_form or "fixed_payout") == "fixed_payout" and rule.get("payout") is None:
            reject(f"rules[{idx}] is rule_type='tier' with reward_form='fixed_payout' (the default) and "
                   "requires payout — or set reward_form='rate' with rate instead.")
    elif rule_type == "min_spend":
        if rule.get("threshold") is None:
            reject(f"rules[{idx}] is rule_type='min_spend' and requires threshold.")
    elif rule_type == "txn_count":
        if rule.get("txn_min") is None:
            reject(f"rules[{idx}] is rule_type='txn_count' and requires txn_min.")
    elif rule_type == "category_rate":
        if rule.get("rate") is None:
            reject(f"rules[{idx}] is rule_type='category_rate' and requires rate.")

    # Extraneous-for-type fields: values evaluate_period() never reads
    # for this rule_type, which the trigger does not itself reject.
    meaningful = _MEANINGFUL_FIELDS.get(rule_type, frozenset())
    for f in _ALL_TYPE_SPECIFIC_FIELDS - meaningful:
        if f == "cap_basis":
            continue  # already handled above with a more specific message
        if f == "gate_scope":
            continue  # already handled above
        v = rule.get(f)
        if v is not None:
            reject(f"rules[{idx}] is rule_type='{rule_type}' but sets {f}={v!r}, a field evaluate_period() "
                   f"never reads for this rule_type — it would be silently ignored, not an error. Likely a "
                   "transposed field; remove it or double-check which rule_type you meant.")
    if rule_type in ("min_spend", "txn_count") and rule.get("categories") is not None:
        reject(f"rules[{idx}] is rule_type='{rule_type}'; evaluate_period() never reads categories for a "
               "gate row — remove it.")

    citations = rule.get("source_citations")
    if not isinstance(citations, list):
        reject(f"rules[{idx}].source_citations is required and must be a list (use [] if nothing was "
               f"found — never omit the field). Got {citations!r}.")
    else:
        for i, c in enumerate(citations):
            if not isinstance(c, dict):
                reject(f"rules[{idx}].source_citations[{i}] must be an object, got {c!r}.")

    rationale = rule.get("ai_rationale")
    if not isinstance(rationale, str) or not rationale.strip():
        reject(f"rules[{idx}].ai_rationale is required and must be a non-empty explanation of what was "
               "found and why this rule follows from it.")

    confidence = rule.get("ai_confidence")
    if not _is_number(confidence) or not (0.0 <= float(confidence) <= 1.0):
        reject(f"rules[{idx}].ai_confidence is required and must be a number 0.0..1.0. Got {confidence!r}.")

    return issues


def schema_issues(config: dict) -> list[Issue]:
    issues: list[Issue] = []
    pms = config.get("payment_methods", [])
    rules = config.get("rules", [])
    if not isinstance(pms, list):
        return [Issue("schema", "reject", "payment_methods must be a list.")]
    if not isinstance(rules, list):
        return [Issue("schema", "reject", "rules must be a list.")]
    for i, pm in enumerate(pms):
        issues.extend(_pm_schema_issues(pm, i))
    for i, rule in enumerate(rules):
        issues.extend(_rule_schema_issues(rule, i))
    return issues


# ============ STAGE 2: REFERENTIAL ============

def _window_overlaps(a_from: str, a_to: str | None, b_from: str, b_to: str | None) -> bool:
    af, bf = date.fromisoformat(a_from), date.fromisoformat(b_from)
    at = date.fromisoformat(a_to) if a_to else date.max
    bt = date.fromisoformat(b_to) if b_to else date.max
    return af <= bt and bf <= at


def _categories_key(categories: list[str] | None) -> tuple[str, ...] | None:
    return tuple(sorted(categories)) if categories else None


def _threshold_key(threshold: Any) -> float | None:
    return round(float(threshold), 6) if threshold is not None else None


def referential_issues(
    config: dict,
    *,
    known_method_ids: set[str],
    existing_rules_by_method: dict[str, list[dict]],
    batch_method_ids: set[str] | None = None,
) -> list[Issue]:
    """Every `rules[].method_id` must resolve, and no proposed rule may
    silently collide with an existing or sibling rule. Deliberately
    conservative on "collide": layered category-rate tiers sharing
    categories at different thresholds are a normal, supported pattern
    (uob_one's groceries tiers, evaluate_period()'s `v_claimed`
    highest-priority-wins design) and are NOT flagged. Flagged only:
    an exact duplicate (same method/type/categories/threshold/
    condition_key, overlapping window), and any two 'cap' rows sharing a
    condition_key with an overlapping window — evaluate_period() selects
    at most one cap row via `order by priority desc limit 1`, so a
    second one for the same eligibility is not redundant, it is silently
    dead code."""
    issues: list[Issue] = []
    rules = config.get("rules", [])
    # batch_method_ids: only payment_methods[] entries that themselves
    # PASSED schema validation — a rule referencing a method_id whose own
    # row failed schema (and will therefore never actually be written)
    # must not be treated as "resolved" here just because the id string
    # appears somewhere in the submission. If the caller doesn't pass
    # this (e.g. a direct unit-test call), fall back to every id in the
    # batch, matching this function's pre-refactor behaviour.
    if batch_method_ids is None:
        batch_method_ids = {pm.get("id") for pm in config.get("payment_methods", []) if isinstance(pm.get("id"), str)}
    all_known = known_method_ids | batch_method_ids

    normalized: list[dict | None] = [None] * len(rules)
    for i, rule in enumerate(rules):
        method_id = rule.get("method_id")
        rule_type = rule.get("rule_type")
        valid_from = rule.get("valid_from")
        if not isinstance(method_id, str) or rule_type not in RULE_TYPES or not _valid_date(valid_from):
            continue  # schema stage already rejects this rule; nothing referential to check
        if method_id not in all_known:
            issues.append(Issue(
                "referential", "reject",
                f"rules[{i}].method_id={method_id!r} does not match any payment_methods[].id in this "
                "submission, and no such payment method exists in the database yet. Add it to "
                "payment_methods[], or check for a typo.",
                rule_index=i,
            ))
            continue
        normalized[i] = {
            "index": i,
            "method_id": method_id,
            "rule_type": rule_type,
            "categories": _categories_key(rule.get("categories")),
            "threshold": _threshold_key(rule.get("threshold")),
            "condition_key": rule.get("condition_key"),
            "valid_from": valid_from,
            "valid_to": rule.get("valid_to"),
        }
        if rule.get("condition_key"):
            issues.append(Issue(
                "referential", "warn",
                f"rules[{i}] sets condition_key={rule['condition_key']!r}. This is matched against "
                "method_conditions, which only an operator ever populates — this rule will read as "
                "\"condition not met\" every month until they do. Say this plainly to the user "
                "(docs/onboarding-spec.md §3).",
                rule_index=i,
            ))

    def conflicts(a: dict, b: dict) -> str | None:
        if a["method_id"] != b["method_id"] or a["rule_type"] != b["rule_type"]:
            return None
        if a["condition_key"] != b["condition_key"]:
            return None  # mutually exclusive by construction — not a conflict
        if not _window_overlaps(a["valid_from"], a["valid_to"], b["valid_from"], b["valid_to"]):
            return None
        if a["rule_type"] == "cap":
            return ("both are 'cap' rows for the same method with an overlapping window and the same "
                    "condition_key — evaluate_period() picks at most one via `order by priority desc "
                    "limit 1`; the other would silently never apply.")
        if a["categories"] == b["categories"] and a["threshold"] == b["threshold"]:
            return "same rule_type, categories, and threshold, with an overlapping validity window — exact duplicate."
        return None

    existing_normalized: list[dict] = []
    for method_id, rows in existing_rules_by_method.items():
        for r in rows:
            existing_normalized.append({
                "index": None,
                "id": r.get("id"),
                "method_id": method_id,
                "rule_type": r.get("rule_type"),
                "categories": _categories_key(r.get("categories")),
                "threshold": _threshold_key(r.get("threshold")),
                "condition_key": r.get("condition_key"),
                "valid_from": r.get("valid_from"),
                "valid_to": r.get("valid_to"),
            })

    candidates = [n for n in normalized if n is not None]
    for pos, a in enumerate(candidates):
        for b in candidates[pos + 1:]:
            reason = conflicts(a, b)
            if reason:
                # Both sides are rejected, not just the first-seen one —
                # an exact duplicate is not "the second copy is the bad
                # one," it's that the pair together is ambiguous. Letting
                # rules[b] through unflagged just because it happened to
                # be seen second would submit exactly the row this check
                # exists to catch.
                issues.append(Issue(
                    "referential", "reject",
                    f"rules[{a['index']}] conflicts with rules[{b['index']}] in this same submission: {reason}",
                    rule_index=a["index"],
                ))
                issues.append(Issue(
                    "referential", "reject",
                    f"rules[{b['index']}] conflicts with rules[{a['index']}] in this same submission: {reason}",
                    rule_index=b["index"],
                ))
        for b in existing_normalized:
            reason = conflicts(a, b)
            if reason:
                issues.append(Issue(
                    "referential", "reject",
                    f"rules[{a['index']}] conflicts with existing method_rules row id={b['id']} "
                    f"(status already in the database): {reason}",
                    rule_index=a["index"],
                ))

    return issues


# ============ STAGE 3: CONFIDENCE GATE ============

def confidence_issues(rule: dict, idx: int) -> list[Issue]:
    """Never silently upgraded, and never silently trusted either: an
    uncited claim asserted with high confidence is refused outright, not
    passed through with a label — see docs/onboarding-spec.md §5. The
    validator does not rewrite `ai_confidence` to "fix" this; it rejects
    and asks for a corrected input, so the number that eventually reaches
    the database is always the one the caller actually stands behind."""
    confidence = rule.get("ai_confidence")
    if not _is_number(confidence):
        return []  # schema stage already rejects a missing/non-numeric confidence
    if has_real_citation(rule):
        return []
    if float(confidence) > CITATION_REQUIRED_CONFIDENCE_CEILING:
        return [Issue(
            "confidence", "reject",
            f"rules[{idx}] claims ai_confidence={confidence} with no verifiable source_citations entry "
            "(no citation with a real http(s):// URL). A confident, uncited claim is exactly the failure "
            "mode this validator exists to catch — either supply a real citation, or lower ai_confidence "
            f"to <= {CITATION_REQUIRED_CONFIDENCE_CEILING} to honestly represent an unverified guess.",
            rule_index=idx,
        )]
    return []


# ============ STAGE 4a: SEMANTIC PLAUSIBILITY ============

def _matching_existing_cap_basis(rule: dict, existing_rows: list[dict]) -> str | None:
    """The recorded cap_basis of the existing 'cap' row that shares this
    proposed cap row's identity (Fix 4 of the WP7 QA review) — same
    method's rows, same categories, same condition_key identify "the same
    cap slot" even across a window change; window overlap is deliberately
    NOT required here (unlike referential_issues' conflict check), since
    a cap_basis flip is worth flagging whether or not the two rows would
    also collide. Returns None when nothing matches — a genuinely new cap
    slot has no prior meaning to flip."""
    if rule.get("rule_type") != "cap":
        return None
    cat_key = _categories_key(rule.get("categories"))
    cond_key = rule.get("condition_key")
    for r in existing_rows:
        if (r.get("rule_type") == "cap"
                and _categories_key(r.get("categories")) == cat_key
                and r.get("condition_key") == cond_key
                and r.get("cap_basis") is not None):
            return r["cap_basis"]
    return None


def semantic_issues(rule: dict, idx: int, *, reward_type: str | None,
                     existing_cap_basis: str | None = None) -> list[Issue]:
    issues: list[Issue] = []
    rule_type = rule.get("rule_type")
    rate = rule.get("rate")
    if rate is not None and _is_number(rate):
        rate = float(rate)
        if reward_type == "cashback" and rate > MAX_CASHBACK_RATE:
            issues.append(Issue(
                "semantic", "reject",
                f"rules[{idx}].rate={rate} on a cashback card implies {rate * 100:.1f}% cashback, above "
                f"the plausible ceiling ({MAX_CASHBACK_RATE * 100:.0f}%). rate is a FRACTION for cashback "
                f"(0.08 = 8%) — if you meant {rate * 100:.0f}%, the value should be {rate / 100} or "
                f"{rate:.4f}, not {rate}. See docs/onboarding-spec.md §4.",
                rule_index=idx,
            ))
        elif reward_type == "miles" and (rate > MAX_MILES_RATE or rate < 0):
            issues.append(Issue(
                "semantic", "reject",
                f"rules[{idx}].rate={rate} on a miles card is outside the plausible range "
                f"(0..{MAX_MILES_RATE} miles/points per currency unit). rate is miles-per-dollar for a "
                "miles card, not a fraction — see docs/onboarding-spec.md §4.",
                rule_index=idx,
            ))

    if rule_type == "cap":
        cap_basis = rule.get("cap_basis")
        if (existing_cap_basis is not None and cap_basis is not None
                and cap_basis != existing_cap_basis):
            issues.append(Issue(
                "semantic", "warn",
                f"rules[{idx}] is a 'cap' row whose method/categories/condition_key matches an "
                f"already-recorded cap row, but claims cap_basis={cap_basis!r} where the recorded row "
                f"has cap_basis={existing_cap_basis!r}. 'spend' and 'reward' cap_basis share the exact "
                "same cap_amount NUMBER but evaluate_period() treats them completely differently — "
                "this looks like the number was carried over while its meaning was silently flipped. "
                "Confirm this is intentional; if it isn't, the cap_amount likely needs to change too, "
                "not just cap_basis.",
                rule_index=idx,
            ))

    if rule_type == "tier":
        payout = rule.get("payout")
        threshold = rule.get("threshold")
        if _is_number(payout) and _is_number(threshold) and float(threshold) > 0:
            implied = float(payout) / float(threshold)
            if implied > MAX_TIER_IMPLIED_RATE:
                issues.append(Issue(
                    "semantic", "reject",
                    f"rules[{idx}] is a fixed_payout tier with threshold={threshold}, payout={payout} — "
                    f"implied rate {implied * 100:.0f}% (payout/threshold), above the plausible ceiling "
                    f"({MAX_TIER_IMPLIED_RATE * 100:.0f}%). This usually means threshold and payout were "
                    "transposed. See docs/onboarding-spec.md §4.",
                    rule_index=idx,
                ))

    return issues


# ============ ORCHESTRATION ============

@dataclass
class ExistingData:
    payment_methods: dict[str, dict]
    method_rules_by_method: dict[str, list[dict]]

    @classmethod
    def load(cls, client: RulesEngineClient, method_ids_of_interest: list[str]) -> "ExistingData":
        pms = {pm["id"]: pm for pm in client.list_payment_methods()}
        rules = client.list_method_rules(method_ids_of_interest)
        by_method: dict[str, list[dict]] = {}
        for r in rules:
            by_method.setdefault(r["method_id"], []).append(r)
        return cls(payment_methods=pms, method_rules_by_method=by_method)


def _rpc_kwargs(rule: dict) -> dict[str, Any]:
    """Build submit_method_rule()'s full argument set. p_proposed_by is
    ALWAYS 'ai' here, regardless of anything the input JSON claims — see
    0018_config_review.sql's header: submit_method_rule() itself never
    trusts p_proposed_by for `status` either way, but this validator does
    not forward a caller's attempt to mislabel provenance."""
    return {
        "p_method_id": rule["method_id"],
        "p_rule_type": rule["rule_type"],
        "p_categories": rule.get("categories"),
        "p_threshold": rule.get("threshold"),
        "p_rate": rule.get("rate"),
        "p_cap_amount": rule.get("cap_amount"),
        "p_payout": rule.get("payout"),
        "p_txn_min": rule.get("txn_min"),
        "p_priority": rule.get("priority") if rule.get("priority") is not None else 0,
        "p_valid_from": rule["valid_from"],
        "p_valid_to": rule.get("valid_to"),
        "p_notes": rule.get("notes"),
        "p_cap_basis": rule.get("cap_basis"),
        "p_reward_form": rule.get("reward_form"),
        "p_gate_scope": rule.get("gate_scope"),
        "p_credit_block_size": rule.get("credit_block_size"),
        "p_credit_floor": rule.get("credit_floor"),
        "p_estimate_caveat": rule.get("estimate_caveat"),
        "p_condition_key": rule.get("condition_key"),
        "p_proposed_by": "ai",
        "p_source_citations": rule.get("source_citations") or [],
        "p_ai_rationale": rule.get("ai_rationale"),
        "p_ai_confidence": rule.get("ai_confidence"),
    }


def run_validator(config: dict, client: RulesEngineClient, *, submit: bool = True) -> ValidationReport:
    """The full five-stage pipeline. `submit=False` runs every check
    without ever calling submit_method_rule()/preview_method_rule() —
    useful for a dry preflight, but stage 4b/5 are then reported as
    'not run' rather than pass/fail, since they are precisely the stages
    that need a real database round trip."""
    report = ValidationReport()

    s_issues = schema_issues(config)
    report.payment_method_issues = [i for i in s_issues if i.rule_index is None]
    rejected_rule_idx: dict[int, list[Issue]] = {}
    for i in s_issues:
        if i.rule_index is not None and i.is_reject():
            rejected_rule_idx.setdefault(i.rule_index, []).extend([i])
    warn_by_rule: dict[int, list[Issue]] = {}
    for i in s_issues:
        if i.rule_index is not None and not i.is_reject():
            warn_by_rule.setdefault(i.rule_index, []).append(i)

    rules = config.get("rules", [])
    pms = config.get("payment_methods", [])

    method_ids = sorted({r.get("method_id") for r in rules if isinstance(r.get("method_id"), str)}
                         | {pm.get("id") for pm in pms if isinstance(pm.get("id"), str)})
    existing = ExistingData.load(client, method_ids)

    schema_valid_pm_ids = {
        pm["id"] for i, pm in enumerate(pms)
        if isinstance(pm.get("id"), str)
        and not any(iss.is_reject() for iss in s_issues if iss.method_index == i)
    }
    ref_issues = referential_issues(
        config,
        known_method_ids=set(existing.payment_methods.keys()),
        existing_rules_by_method=existing.method_rules_by_method,
        batch_method_ids=schema_valid_pm_ids,
    )
    for i in ref_issues:
        if i.rule_index is not None:
            if i.is_reject():
                rejected_rule_idx.setdefault(i.rule_index, []).extend([i])
            else:
                warn_by_rule.setdefault(i.rule_index, []).append(i)

    # ============ payment_methods: diff against the stored row BEFORE
    # ever writing (Fix 1 + Fix 3 of the WP7 QA review) ============
    #
    # A NEW method_id (nothing recorded yet) has nothing to diff against
    # and nothing to protect — written straight through once schema-valid,
    # same as always: this really is identity data the user stated
    # directly (docs/onboarding-spec.md §3).
    #
    # An EXISTING method_id is different. Two things a
    # payment_methods[] row can carry that must never change silently
    # through this path, ever again:
    #
    #   - alert_senders / statement_senders / last4
    #     (_SENSITIVE_PM_FIELDS below): the anti-spoofing controls
    #     ingest-alerts/index.ts reads (~95, 382, 524-530) to decide
    #     whether an email is genuine. QA reproduced a full silent
    #     overwrite of an EXISTING uob_one row through exactly this path
    #     — alert_senders gained an attacker-controlled domain, last4
    #     changed — via SupabaseREST.insert(on_conflict='id',
    #     resolution=merge-duplicates) under service_role, which bypasses
    #     RLS. A change to ANY of these three fields on an existing
    #     method now blocks that entire payment_methods[] row's write —
    #     never a partial write of "everything except the sensitive
    #     fields," which would just relocate the silence rather than
    #     remove it. Direct the operator to /config instead (§6): a human
    #     sets a routing domain on their own authority, an AI never does.
    #   - reward_type: governs what `rate` MEANS for every rule this
    #     method already has (§4 — "the single most dangerous field in
    #     this schema"). The DB-recorded value, never whatever this batch
    #     claims, is what stage 4a's plausibility check below actually
    #     uses — a relabelled reward_type must not be able to walk an
    #     implausible `rate` straight past the check that exists to catch
    #     it (QA: an existing cashback card resubmitted as 'miles'
    #     alongside rate=8 passed with zero issues). A claimed change is
    #     surfaced as its own explicit issue, not silently believed.
    #
    # format_report() renders `payment_method_outcomes` as a per-field
    # diff for every existing row this batch touches, accepted or
    # blocked — never a bare count.
    _SENSITIVE_PM_FIELDS: tuple[str, ...] = ("alert_senders", "statement_senders", "last4")
    # Every field worth a reviewer's attention when it changes on an
    # existing row — schema-shape-only fields (id, method_type,
    # period_type) excluded: id is the join key (a "change" there is a
    # different row), method_type/period_type changing on a live card is
    # its own can of worms this validator doesn't attempt to referee.
    _PM_DIFF_FIELDS: tuple[str, ...] = (
        "display_name", "issuer", "last4", "cycle_day", "reward_type",
        "has_rules", "active", "currency", "alert_label", "alert_senders",
        "statement_senders", "aggregation_window", "aggregation_anchor_date",
        "reward_unit",
    )

    def _pm_field_norm(v: Any) -> Any:
        if isinstance(v, list):
            return tuple(sorted(str(x).lower() for x in v))
        if isinstance(v, str):
            return v.strip().lower()
        return v

    reward_type_by_method: dict[str, str | None] = {}
    pm_to_write: list[dict] = []
    for i, pm in enumerate(pms):
        mid = pm.get("id")
        if any(iss.is_reject() for iss in s_issues if iss.method_index == i):
            # Schema-invalid row: never diffed, never written — the
            # schema stage's own message already explains why.
            report.payment_method_outcomes.append(PaymentMethodOutcome(
                index=i, id=mid if isinstance(mid, str) else None,
                is_new=isinstance(mid, str) and mid not in existing.payment_methods,
                written=False,
            ))
            continue
        # Past the schema-reject filter, mid is guaranteed a non-empty
        # str (schema stage requires it) — assert not needed, just used.

        stored = existing.payment_methods.get(mid)
        if stored is None:
            reward_type_by_method[mid] = pm.get("reward_type")
            pm_to_write.append(pm)
            report.payment_method_outcomes.append(
                PaymentMethodOutcome(index=i, id=mid, is_new=True, written=True)
            )
            continue

        # Existing method: the DB's own reward_type wins for every
        # plausibility check below, unconditionally — see this block's
        # header comment (Fix 3).
        reward_type_by_method[mid] = stored.get("reward_type")
        batch_reward_type = pm.get("reward_type")
        if (batch_reward_type is not None and stored.get("reward_type") is not None
                and batch_reward_type != stored.get("reward_type")):
            report.payment_method_issues.append(Issue(
                "payment_method", "reject",
                f"payment_methods[{i}] ({mid!r}) claims reward_type={batch_reward_type!r}, but the "
                f"already-recorded value is {stored.get('reward_type')!r}. rate is meaningless "
                "without knowing which of these is true (docs/onboarding-spec.md §4) — every "
                "plausibility check in this run used the RECORDED value for this method's rules, "
                "not this claim. If the card genuinely changed reward programmes, say so explicitly "
                "and make the change at /config; this validator will not relabel it silently.",
                method_index=i,
            ))

        diff: dict[str, tuple[Any, Any]] = {}
        for f in _PM_DIFF_FIELDS:
            if f not in pm:
                continue  # not part of this submission's claim about the row — nothing to compare
            new_v, old_v = pm.get(f), stored.get(f)
            if _pm_field_norm(new_v) != _pm_field_norm(old_v):
                diff[f] = (old_v, new_v)

        blocked = {f: diff[f] for f in _SENSITIVE_PM_FIELDS if f in diff}
        if blocked:
            changed_desc = "; ".join(f"{f}: {old!r} -> {new!r}" for f, (old, new) in blocked.items())
            report.payment_method_issues.append(Issue(
                "payment_method", "reject",
                f"payment_methods[{i}] ({mid!r}) tries to change {changed_desc} on an "
                "ALREADY-EXISTING method. alert_senders/statement_senders/last4 are this app's "
                "anti-spoofing controls (ingest-alerts/index.ts reads them to decide whether an "
                "email is genuine) — a wrong value here silently routes another sender's mail into "
                "this card's ledger (docs/onboarding-spec.md §6). This ENTIRE payment_methods[] row "
                "was NOT written (never a partial write of the other fields either). Make this "
                "specific change at /config, where a human operator sets it on their own authority.",
                method_index=i,
            ))
            report.payment_method_outcomes.append(PaymentMethodOutcome(
                index=i, id=mid, is_new=False, written=False, diff=diff, blocked_fields=blocked,
            ))
            continue

        pm_to_write.append(pm)
        report.payment_method_outcomes.append(
            PaymentMethodOutcome(index=i, id=mid, is_new=False, written=True, diff=diff)
        )

    if submit and pm_to_write:
        report.payment_methods_written = client.upsert_payment_methods(pm_to_write)
    elif not submit:
        report.payment_methods_written = pm_to_write  # reported, not actually written

    for idx, rule in enumerate(rules):
        outcome = RuleOutcome(index=idx, method_id=rule.get("method_id"), rule_type=rule.get("rule_type"))
        outcome.issues.extend(warn_by_rule.get(idx, []))

        if idx in rejected_rule_idx:
            outcome.issues.extend(rejected_rule_idx[idx])
            report.rule_outcomes.append(outcome)
            continue  # stage 1/2 reject — never reaches confidence/semantic/DB

        conf_issues = confidence_issues(rule, idx)
        if any(i.is_reject() for i in conf_issues):
            outcome.issues.extend(conf_issues)
            report.rule_outcomes.append(outcome)
            continue  # confidence gate reject — never reaches semantic/DB

        outcome.issues.extend(conf_issues)  # warns, if any (currently none at pass)

        sem_issues = semantic_issues(
            rule, idx,
            reward_type=reward_type_by_method.get(rule.get("method_id")),
            existing_cap_basis=_matching_existing_cap_basis(
                rule, existing.method_rules_by_method.get(rule.get("method_id"), [])
            ),
        )
        if any(i.is_reject() for i in sem_issues):
            outcome.issues.extend(sem_issues)
            report.rule_outcomes.append(outcome)
            continue  # plausibility reject — never reaches the database

        outcome.issues.extend(sem_issues)

        if not submit:
            report.rule_outcomes.append(outcome)
            continue

        try:
            row = client.submit_method_rule(**_rpc_kwargs(rule))
        except Exception as exc:  # noqa: BLE001 — surfaced verbatim to the caller, never swallowed
            outcome.issues.append(Issue(
                "semantic", "reject",
                f"rules[{idx}]: submit_method_rule() raised: {exc}",
                rule_index=idx,
            ))
            report.rule_outcomes.append(outcome)
            continue

        outcome.submitted_row = row
        rule_id = row.get("id")
        try:
            preview = client.preview_method_rule(rule_id)
        except Exception as exc:  # noqa: BLE001
            reason = f"validator: preview_method_rule() raised after submission: {exc}"
            outcome.issues.append(Issue("semantic", "reject", f"rules[{idx}]: {reason}", rule_index=idx))
            try:
                client.reject_method_rule(rule_id, reason)
                outcome.rejected_after_submit = True
            except Exception as reject_exc:  # noqa: BLE001
                outcome.issues.append(Issue(
                    "semantic", "reject",
                    f"rules[{idx}]: additionally failed to reject_method_rule() row id={rule_id} after the "
                    f"preview failure: {reject_exc}. This row is stranded pending_review with no diff — "
                    "flag it for manual review.",
                    rule_index=idx,
                ))
            report.rule_outcomes.append(outcome)
            continue

        outcome.preview = preview
        outcome.accepted = True
        report.rule_outcomes.append(outcome)

    return report


# ============ REPORT FORMATTING ============

def format_report(report: ValidationReport) -> str:
    lines: list[str] = []

    outcomes = report.payment_method_outcomes
    new_written = [o for o in outcomes if o.is_new and o.written]
    existing_written = [o for o in outcomes if not o.is_new and o.written]
    blocked = [o for o in outcomes if o.blocked_fields]
    lines.append(
        f"payment_methods: {len(new_written)} new, {len(existing_written)} existing updated, "
        f"{len(blocked)} blocked (sensitive-field change on an existing method)."
    )
    # A per-field diff, not a bare count, for every existing row this
    # batch actually touched — accepted or blocked (Fix 1's own
    # requirement). A brand-new method has nothing to diff and is not
    # listed here.
    for o in outcomes:
        if o.is_new or not o.diff:
            continue
        status = "BLOCKED — not written" if o.blocked_fields else "written"
        lines.append(f"  payment_methods[{o.index}] ({o.id}) — {status}:")
        for f, (old, new) in o.diff.items():
            marker = "  [SENSITIVE FIELD — this row was not written]" if f in o.blocked_fields else ""
            lines.append(f"    {f}: {old!r} -> {new!r}{marker}")

    if report.payment_method_issues:
        lines.append("payment_methods issues:")
        for i in report.payment_method_issues:
            lines.append(f"  [{i.severity.upper()}] {i.message}")

    accepted = report.accepted_rules
    rejected = report.rejected_rules
    lines.append(f"\nrules: {len(accepted)} accepted (pending_review), {len(rejected)} rejected.")

    for o in report.rule_outcomes:
        status = "ACCEPTED (pending_review)" if o.accepted else "REJECTED"
        lines.append(f"\n- rules[{o.index}] ({o.method_id}, {o.rule_type}): {status}")
        for i in o.issues:
            lines.append(f"    [{i.stage}/{i.severity.upper()}] {i.message}")
        if o.accepted and o.preview:
            without = o.preview.get("without_rule", {}).get("reward_accrued")
            with_ = o.preview.get("with_rule", {}).get("reward_accrued")
            lines.append(f"    dry-run diff (period {o.preview.get('period_key')}): "
                         f"reward_accrued {without} -> {with_}")

    lines.append(
        "\nNothing above is live. Every accepted rule is status='pending_review' — invisible to "
        "evaluate_period() until a human approves it at /config. Tell the user exactly that."
    )
    return "\n".join(lines)
