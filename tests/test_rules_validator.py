"""WP7: the five-stage AI-config validator. Pure logic + a fully offline
fake RulesEngineClient — no network, no live database — matching this
repo's existing test convention (tests/test_reconcile.py, tests/
test_senders.py: mock/fake the boundary, test the logic on both sides of
it for real).

The adversarial cases in TestAdversarialInputs are the actual point of
this module: each one is a specific way a wrong or dishonest AI proposal
could reach the database, taken directly from the task brief's own list.
Every one of them must be REJECTED with a message a human could act on —
never silently dropped, never silently "fixed."

The DB-round-trip half of stage 4/5 (actually calling submit_method_rule/
preview_method_rule/reject_method_rule against a real Postgres) is proven
separately, against the local stub harness, via psql with SET ROLE — see
this work package's report. FakeRulesEngineClient below models that same
contract (submit -> pending_review row; preview -> before/after reward
figures) closely enough to test this module's own branching logic
(what it does with a submit/preview success or failure) without needing
a live database for every `pytest` run.

Run: python3 -m pytest tests/test_rules_validator.py -v
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

import pytest  # noqa: E402

from lib.rules_validator import (  # noqa: E402
    CITATION_REQUIRED_CONFIDENCE_CEILING,
    MAX_CASHBACK_RATE,
    MAX_MILES_RATE,
    MAX_TIER_IMPLIED_RATE,
    ExistingData,
    Issue,
    ValidationReport,
    _looks_like_real_citation,
    _PLACEHOLDER_HOSTS,
    confidence_issues,
    format_report,
    has_real_citation,
    referential_issues,
    run_validator,
    schema_issues,
    semantic_issues,
)


# ============ FIXTURES ============

def uob_one_pm(**overrides) -> dict:
    pm = {
        "id": "uob_one",
        "display_name": "UOB One",
        "issuer": "UOB",
        "last4": "6549",
        "method_type": "credit_card",
        "period_type": "statement",
        "cycle_day": 15,
        "reward_type": "cashback",
        "has_rules": True,
        "active": True,
        "currency": "SGD",
        "alert_label": "Payments/UOB",
        "alert_senders": ["uobgroup.com"],
        "statement_senders": ["uobgroup.com"],
        "aggregation_window": 3,
        "aggregation_anchor_date": None,
        "reward_unit": "cashback_sgd_additional",
    }
    pm.update(overrides)
    return pm


def hsbc_revo_pm(**overrides) -> dict:
    pm = {
        "id": "hsbc_revo",
        "display_name": "HSBC Revolution",
        "issuer": "HSBC",
        "last4": "2222",
        "method_type": "credit_card",
        "period_type": "calendar",
        "cycle_day": None,
        "reward_type": "miles",
        "has_rules": True,
        "active": True,
        "currency": "SGD",
        "alert_label": None,
        "alert_senders": None,
        "statement_senders": None,
        "aggregation_window": None,
        "aggregation_anchor_date": None,
        "reward_unit": "miles_best_partner_equivalent_2.5to1",
    }
    pm.update(overrides)
    return pm


REAL_CITATION = [{"title": "UOB One Card T&C ver 2.1", "url": "https://www.uob.com.sg/one-card-tnc", "quote": "..."}]


def category_rate_rule(**overrides) -> dict:
    rule = {
        "method_id": "uob_one",
        "rule_type": "category_rate",
        "categories": ["groceries"],
        "threshold": 2000,
        "rate": 0.0467,
        "cap_amount": None,
        "payout": None,
        "txn_min": None,
        "priority": 30,
        "valid_from": "2025-07-01",
        "valid_to": None,
        "notes": "Groceries at Tier 3.",
        "cap_basis": None,
        "reward_form": "rate",
        "gate_scope": None,
        "credit_block_size": None,
        "credit_floor": None,
        "estimate_caveat": None,
        "condition_key": None,
        "source_citations": REAL_CITATION,
        "ai_rationale": "UOB One T&C clause 3.4: 4.67% on groceries once Tier 3 is reached.",
        "ai_confidence": 0.85,
    }
    rule.update(overrides)
    return rule


def tier_rule(**overrides) -> dict:
    rule = {
        "method_id": "uob_one",
        "rule_type": "tier",
        "categories": None,
        "threshold": 600,
        "rate": None,
        "cap_amount": None,
        "payout": 60,
        "txn_min": 10,
        "priority": 10,
        "valid_from": "2025-07-01",
        "valid_to": None,
        "notes": "Tier 1. Flat S$60/quarter.",
        "cap_basis": None,
        "reward_form": "fixed_payout",
        "gate_scope": None,
        "credit_block_size": None,
        "credit_floor": None,
        "estimate_caveat": None,
        "condition_key": None,
        "source_citations": REAL_CITATION,
        "ai_rationale": "UOB One T&C clause 3.2: flat S$60 once S$600 spend + 10 txns clear in the quarter.",
        "ai_confidence": 0.85,
    }
    rule.update(overrides)
    return rule


def cap_rule(**overrides) -> dict:
    rule = {
        "method_id": "uob_one",
        "rule_type": "cap",
        "categories": None,
        "threshold": None,
        "rate": None,
        "cap_amount": 120,
        "payout": None,
        "txn_min": None,
        "priority": 0,
        "valid_from": "2025-07-01",
        "valid_to": None,
        "notes": "Additional cashback cap per statement month.",
        "cap_basis": "reward",
        "reward_form": None,
        "gate_scope": None,
        "credit_block_size": None,
        "credit_floor": None,
        "estimate_caveat": None,
        "condition_key": None,
        "source_citations": REAL_CITATION,
        "ai_rationale": "UOB One T&C clause 3.5: S$120/month cap on additional cashback.",
        "ai_confidence": 0.85,
    }
    rule.update(overrides)
    return rule


class FakeRulesEngineClient:
    """Offline stand-in for SupabaseRulesClient. Models submit_method_rule
    landing every row pending_review (the service_role safety property —
    proven for real against Postgres separately, see this WP's report)
    and preview_method_rule returning a plausible before/after. Supports
    injecting a failure for a specific method_id to exercise the
    preview-fails-so-reject-it path."""

    def __init__(self, *, existing_payment_methods=None, existing_rules=None,
                 fail_preview_for: set[str] | None = None):
        self.existing_payment_methods = existing_payment_methods or {}
        self.existing_rules = existing_rules or {}
        self.fail_preview_for = fail_preview_for or set()
        self._next_id = 1000
        self.submitted: list[dict] = []
        self.rejected: list[tuple[int, str]] = []
        self.pm_writes: list[dict] = []

    def list_payment_methods(self) -> list[dict]:
        return list(self.existing_payment_methods.values())

    def list_method_rules(self, method_ids: list[str]) -> list[dict]:
        out = []
        for mid in method_ids:
            out.extend(self.existing_rules.get(mid, []))
        return out

    def upsert_payment_methods(self, rows: list[dict]) -> list[dict]:
        self.pm_writes.extend(rows)
        return rows

    def submit_method_rule(self, **kwargs) -> dict:
        assert kwargs["p_proposed_by"] == "ai", "validator must always hardcode p_proposed_by='ai'"
        self._next_id += 1
        row = dict(kwargs)
        row["id"] = self._next_id
        row["status"] = "pending_review"  # the safety property, modeled here for offline tests
        self.submitted.append(row)
        return row

    def preview_method_rule(self, rule_id: int, period_key: str | None = None) -> dict:
        row = next(r for r in self.submitted if r["id"] == rule_id)
        if row["p_method_id"] in self.fail_preview_for:
            raise RuntimeError("simulated evaluate_period() failure")
        rate = row.get("p_rate") or 0
        spend = 1000
        return {
            "rule_id": rule_id, "method_id": row["p_method_id"], "period_key": "synthetic:2026-08",
            "without_rule": {"reward_accrued": 0},
            "with_rule": {"reward_accrued": round(spend * rate, 2) if rate else row.get("p_payout") or 0},
        }

    def reject_method_rule(self, rule_id: int, review_note: str) -> dict:
        self.rejected.append((rule_id, review_note))
        for r in self.submitted:
            if r["id"] == rule_id:
                r["status"] = "rejected"
        return {"id": rule_id, "status": "rejected", "review_note": review_note}


# ============ STAGE 1: SCHEMA ============

class TestSchema:
    def test_happy_path_no_issues(self):
        config = {"payment_methods": [uob_one_pm()], "rules": [tier_rule(), category_rate_rule(), cap_rule()]}
        issues = schema_issues(config)
        assert issues == []

    def test_rejects_bad_rule_type(self):
        config = {"payment_methods": [], "rules": [category_rate_rule(rule_type="bogus_type")]}
        issues = schema_issues(config)
        assert any(i.is_reject() and "rule_type" in i.message for i in issues)

    def test_rejects_quarterly_gate_explicitly(self):
        config = {"payment_methods": [], "rules": [tier_rule(rule_type="quarterly_gate")]}
        issues = schema_issues(config)
        assert any(i.is_reject() and "legacy" in i.message for i in issues)

    def test_rejects_bad_category(self):
        config = {"payment_methods": [], "rules": [category_rate_rule(categories=["space_travel"])]}
        issues = schema_issues(config)
        assert any(i.is_reject() and "space_travel" in i.message for i in issues)

    def test_rejects_missing_citations_field(self):
        rule = category_rate_rule()
        del rule["source_citations"]
        issues = schema_issues({"payment_methods": [], "rules": [rule]})
        assert any(i.is_reject() and "source_citations" in i.message for i in issues)

    def test_empty_citations_array_is_schema_valid(self):
        """Empty is not an error at the schema stage — an honest 'found
        nothing' — see docs/onboarding-spec.md §5."""
        rule = category_rate_rule(source_citations=[], ai_confidence=0.1)
        issues = schema_issues({"payment_methods": [], "rules": [rule]})
        assert issues == []

    def test_rejects_missing_ai_rationale(self):
        rule = category_rate_rule(ai_rationale="")
        issues = schema_issues({"payment_methods": [], "rules": [rule]})
        assert any(i.is_reject() and "ai_rationale" in i.message for i in issues)

    def test_rejects_confidence_out_of_range(self):
        rule = category_rate_rule(ai_confidence=1.5)
        issues = schema_issues({"payment_methods": [], "rules": [rule]})
        assert any(i.is_reject() and "ai_confidence" in i.message for i in issues)

    def test_rejects_extraneous_field_for_rule_type(self):
        """A 'cap' row carrying a stray threshold — evaluate_period()
        never reads it for this rule_type, silently ignored otherwise."""
        rule = cap_rule(threshold=2000)
        issues = schema_issues({"payment_methods": [], "rules": [rule]})
        assert any(i.is_reject() and "threshold" in i.message and "cap" in i.message for i in issues)

    def test_rejects_cap_basis_on_non_cap_row(self):
        rule = category_rate_rule(cap_basis="reward")
        issues = schema_issues({"payment_methods": [], "rules": [rule]})
        assert any(i.is_reject() and "cap_basis" in i.message for i in issues)

    def test_rejects_cap_without_cap_basis(self):
        rule = cap_rule(cap_basis=None)
        issues = schema_issues({"payment_methods": [], "rules": [rule]})
        assert any(i.is_reject() and "cap_basis" in i.message for i in issues)

    def test_rejects_bad_last4(self):
        pm = uob_one_pm(last4="12")
        issues = schema_issues({"payment_methods": [pm], "rules": []})
        assert any(i.is_reject() and "last4" in i.message for i in issues)

    def test_last4_null_is_fine(self):
        pm = uob_one_pm(last4=None)
        issues = schema_issues({"payment_methods": [pm], "rules": []})
        assert issues == []

    def test_rejects_bad_currency(self):
        pm = uob_one_pm(currency="Singapore Dollars")
        issues = schema_issues({"payment_methods": [pm], "rules": []})
        assert any(i.is_reject() and "currency" in i.message for i in issues)

    def test_rejects_guessed_looking_domain_syntax(self):
        pm = uob_one_pm(alert_senders=["not a domain!!"])
        issues = schema_issues({"payment_methods": [pm], "rules": []})
        assert any(i.is_reject() and "alert_senders" in i.message for i in issues)

    def test_rejects_empty_domain_list(self):
        pm = uob_one_pm(alert_senders=[])
        issues = schema_issues({"payment_methods": [pm], "rules": []})
        assert any(i.is_reject() and "alert_senders" in i.message for i in issues)

    def test_domain_list_null_is_fine(self):
        pm = uob_one_pm(alert_senders=None, statement_senders=None)
        issues = schema_issues({"payment_methods": [pm], "rules": []})
        assert issues == []

    def test_rejects_bad_cycle_day(self):
        pm = uob_one_pm(cycle_day=45)
        issues = schema_issues({"payment_methods": [pm], "rules": []})
        assert any(i.is_reject() and "cycle_day" in i.message for i in issues)

    def test_cycle_day_null_is_fine(self):
        pm = uob_one_pm(cycle_day=None)
        issues = schema_issues({"payment_methods": [pm], "rules": []})
        assert issues == []

    def test_rejects_valid_to_before_valid_from(self):
        rule = category_rate_rule(valid_from="2026-06-01", valid_to="2026-01-01")
        issues = schema_issues({"payment_methods": [], "rules": [rule]})
        assert any(i.is_reject() and "valid_to" in i.message for i in issues)

    def test_rejects_gate_scope_on_category_rate(self):
        rule = category_rate_rule(gate_scope="all_rewards")
        issues = schema_issues({"payment_methods": [], "rules": [rule]})
        assert any(i.is_reject() and "gate_scope" in i.message for i in issues)


# ============ STAGE 2: REFERENTIAL ============

class TestReferential:
    def test_unknown_method_id_rejected(self):
        config = {"payment_methods": [], "rules": [category_rate_rule(method_id="totally_made_up_card")]}
        issues = referential_issues(config, known_method_ids=set(), existing_rules_by_method={})
        assert len(issues) == 1
        assert issues[0].is_reject()
        assert "totally_made_up_card" in issues[0].message

    def test_method_id_in_same_batch_is_fine(self):
        config = {"payment_methods": [uob_one_pm()], "rules": [category_rate_rule()]}
        issues = referential_issues(config, known_method_ids=set(), existing_rules_by_method={})
        assert issues == []

    def test_method_id_already_in_db_is_fine(self):
        config = {"payment_methods": [], "rules": [category_rate_rule()]}
        issues = referential_issues(config, known_method_ids={"uob_one"}, existing_rules_by_method={})
        assert issues == []

    def test_exact_duplicate_within_batch_rejected(self):
        r1 = category_rate_rule()
        r2 = category_rate_rule()  # identical categories/threshold/window
        config = {"payment_methods": [], "rules": [r1, r2]}
        issues = referential_issues(config, known_method_ids={"uob_one"}, existing_rules_by_method={})
        assert any(i.is_reject() and "duplicate" in i.message for i in issues)

    def test_layered_tiers_same_categories_different_threshold_not_flagged(self):
        """The real uob_one pattern: two groceries category_rate rows,
        same categories, DIFFERENT thresholds — a legitimate step
        function, must NOT be flagged as a conflict."""
        r1 = category_rate_rule(threshold=2000, rate=0.0467, priority=30)
        r2 = category_rate_rule(threshold=1000, rate=0.0267, priority=20)
        config = {"payment_methods": [], "rules": [r1, r2]}
        issues = referential_issues(config, known_method_ids={"uob_one"}, existing_rules_by_method={})
        assert issues == []

    def test_two_cap_rows_same_window_no_condition_key_rejected(self):
        r1 = cap_rule(cap_amount=120)
        r2 = cap_rule(cap_amount=80)
        config = {"payment_methods": [], "rules": [r1, r2]}
        issues = referential_issues(config, known_method_ids={"uob_one"}, existing_rules_by_method={})
        assert any(i.is_reject() and "cap" in i.message for i in issues)

    def test_two_cap_rows_different_condition_key_not_flagged(self):
        """hsbc_revo's real pattern: a base cap (condition_key=None) and
        an EGA-gated cap (condition_key='ega') legitimately coexist."""
        r1 = cap_rule(cap_amount=1000, condition_key=None)
        r2 = cap_rule(cap_amount=1200, condition_key="ega")
        config = {"payment_methods": [], "rules": [r1, r2]}
        issues = referential_issues(config, known_method_ids={"uob_one"}, existing_rules_by_method={})
        # r2's condition_key produces its own informational warning (see
        # test_condition_key_produces_a_warning_not_a_rejection) — the
        # thing this test actually asserts is that the PAIR is not
        # flagged as a cap/cap conflict.
        assert not any(i.is_reject() for i in issues)

    def test_conflict_against_existing_db_row_rejected(self):
        config = {"payment_methods": [], "rules": [category_rate_rule()]}
        existing = {"uob_one": [{
            "id": 42, "method_id": "uob_one", "rule_type": "category_rate", "categories": ["groceries"],
            "threshold": 2000, "condition_key": None, "valid_from": "2025-07-01", "valid_to": None,
        }]}
        issues = referential_issues(config, known_method_ids={"uob_one"}, existing_rules_by_method=existing)
        assert any(i.is_reject() and "id=42" in i.message for i in issues)

    def test_condition_key_produces_a_warning_not_a_rejection(self):
        rule = category_rate_rule(condition_key="ega")
        config = {"payment_methods": [], "rules": [rule]}
        issues = referential_issues(config, known_method_ids={"uob_one"}, existing_rules_by_method={})
        assert len(issues) == 1
        assert issues[0].severity == "warn"
        assert "method_conditions" in issues[0].message


# ============ STAGE 3: CONFIDENCE GATE ============

class TestConfidenceGate:
    def test_cited_high_confidence_passes(self):
        rule = category_rate_rule(source_citations=REAL_CITATION, ai_confidence=0.9)
        assert confidence_issues(rule, 0) == []

    def test_uncited_low_confidence_passes(self):
        rule = category_rate_rule(source_citations=[], ai_confidence=0.15)
        assert confidence_issues(rule, 0) == []

    def test_uncited_high_confidence_rejected(self):
        rule = category_rate_rule(source_citations=[], ai_confidence=0.95)
        issues = confidence_issues(rule, 0)
        assert len(issues) == 1
        assert issues[0].is_reject()
        assert "0.95" in issues[0].message

    def test_uncited_confidence_at_ceiling_passes(self):
        rule = category_rate_rule(source_citations=[], ai_confidence=CITATION_REQUIRED_CONFIDENCE_CEILING)
        assert confidence_issues(rule, 0) == []

    def test_placeholder_citation_treated_as_uncited(self):
        """A title with no real URL must not count as a citation — see
        docs/onboarding-spec.md §5 ('never dressed up')."""
        rule = category_rate_rule(
            source_citations=[{"title": "I know this card", "url": None}],
            ai_confidence=0.9,
        )
        assert not has_real_citation(rule)
        issues = confidence_issues(rule, 0)
        assert any(i.is_reject() for i in issues)

    def test_placeholder_domain_citation_treated_as_uncited(self):
        rule = category_rate_rule(
            source_citations=[{"title": "issuer T&C", "url": "https://example.com/tnc"}],
            ai_confidence=0.9,
        )
        assert not has_real_citation(rule)


# ============ STAGE 4a: SEMANTIC PLAUSIBILITY ============

class TestSemanticPlausibility:
    def test_normal_cashback_rate_passes(self):
        rule = category_rate_rule(rate=0.08)
        assert semantic_issues(rule, 0, reward_type="cashback") == []

    def test_cashback_rate_off_by_10x_rejected(self):
        """The headline adversarial case: 0.8 typed where 0.08 was meant."""
        rule = category_rate_rule(rate=0.8)
        issues = semantic_issues(rule, 0, reward_type="cashback")
        assert len(issues) == 1
        assert issues[0].is_reject()
        assert "80.0%" in issues[0].message

    def test_cashback_rate_as_whole_number_rejected(self):
        """The other classic form of the same mistake: rate=8 meaning 8%."""
        rule = category_rate_rule(rate=8)
        issues = semantic_issues(rule, 0, reward_type="cashback")
        assert any(i.is_reject() for i in issues)

    def test_miles_rate_in_plausible_range_passes(self):
        rule = category_rate_rule(rate=8.0, method_id="hsbc_revo")
        assert semantic_issues(rule, 0, reward_type="miles") == []

    def test_miles_rate_absurdly_high_rejected(self):
        rule = category_rate_rule(rate=400.0, method_id="hsbc_revo")
        issues = semantic_issues(rule, 0, reward_type="miles")
        assert any(i.is_reject() for i in issues)

    def test_reward_type_unknown_skips_rate_check(self):
        """No reward_type on record — don't guess a bound, don't false-reject."""
        rule = category_rate_rule(rate=8.0)
        assert semantic_issues(rule, 0, reward_type=None) == []

    def test_tier_threshold_payout_transposed_rejected(self):
        """The other headline adversarial case: threshold/payout swapped
        (real: threshold=600, payout=60 — transposed: threshold=60,
        payout=600)."""
        rule = tier_rule(threshold=60, payout=600)
        issues = semantic_issues(rule, 0, reward_type="cashback")
        assert len(issues) == 1
        assert issues[0].is_reject()
        assert "transposed" in issues[0].message

    def test_normal_tier_ratio_passes(self):
        rule = tier_rule(threshold=600, payout=60)
        assert semantic_issues(rule, 0, reward_type="cashback") == []


# ============ FULL RUN (schema+referential+confidence+semantic+DB round trip) ============

class TestRunValidatorHappyPath:
    def test_full_batch_accepted_and_pending(self):
        config = {"payment_methods": [uob_one_pm()], "rules": [tier_rule(), category_rate_rule(), cap_rule()]}
        client = FakeRulesEngineClient()
        report = run_validator(config, client)

        assert report.ok()
        assert len(report.accepted_rules) == 3
        assert len(report.rejected_rules) == 0
        assert len(client.pm_writes) == 1
        # The safety property this whole system exists to prove: every
        # accepted rule landed pending_review, never active — see
        # FakeRulesEngineClient.submit_method_rule's own assertion that
        # p_proposed_by is always forwarded as 'ai', and the report below.
        for row in client.submitted:
            assert row["status"] == "pending_review"
        report_text = format_report(report)
        assert "pending_review" in report_text
        assert "Nothing above is live" in report_text

    def test_dry_run_never_calls_submit(self):
        config = {"payment_methods": [uob_one_pm()], "rules": [tier_rule()]}
        client = FakeRulesEngineClient()
        report = run_validator(config, client, submit=False)
        assert client.submitted == []
        assert client.pm_writes == []
        assert report.rule_outcomes and not report.rule_outcomes[0].accepted

    def test_preview_failure_rejects_the_just_submitted_row(self):
        config = {"payment_methods": [uob_one_pm()], "rules": [tier_rule()]}
        client = FakeRulesEngineClient(fail_preview_for={"uob_one"})
        report = run_validator(config, client)
        assert len(report.rejected_rules) == 1
        outcome = report.rejected_rules[0]
        assert outcome.rejected_after_submit is True
        assert len(client.rejected) == 1
        assert client.rejected[0][0] == client.submitted[0]["id"]

    def test_rule_referencing_a_schema_invalid_payment_method_is_not_treated_as_resolved(self):
        """A payment_methods[] entry that itself fails schema (here: a
        bogus currency) is never written to the database — a rule
        referencing its id must not slip past the referential stage just
        because the id string appears somewhere in the same submission,
        or it would hit submit_method_rule() with a dangling method_id."""
        broken_pm = uob_one_pm(currency="NOT_A_CURRENCY")
        config = {"payment_methods": [broken_pm], "rules": [tier_rule()]}
        client = FakeRulesEngineClient()
        report = run_validator(config, client)
        assert client.pm_writes == []  # the broken payment method was never written
        assert len(report.rejected_rules) == 1
        assert client.submitted == []
        msgs = " ".join(i.message for i in report.rejected_rules[0].issues)
        assert "uob_one" in msgs

    def test_never_forwards_proposed_by_from_input_even_if_ai_supplies_one(self):
        """The AI's JSON has no proposed_by field at all in this spec, but
        even a client bug that tried to forward an operator-style claim
        must not succeed — proven by FakeRulesEngineClient's own assert.
        The DB-level version of this proof (service_role always lands
        pending_review regardless of what a caller CLAIMS) is proven
        separately against real Postgres — see this WP's report."""
        config = {"payment_methods": [], "rules": [tier_rule()]}
        client = FakeRulesEngineClient(existing_payment_methods={"uob_one": uob_one_pm()})
        report = run_validator(config, client)
        assert report.accepted_rules
        assert client.submitted[0]["p_proposed_by"] == "ai"


class TestAdversarialInputs:
    """Exactly the deliberately-bad inputs the task brief calls for. Each
    must be rejected with a specific, actionable reason — never silently
    dropped, never accepted because it merely parsed."""

    def test_rate_off_by_10x(self):
        config = {"payment_methods": [uob_one_pm()],
                  "rules": [category_rate_rule(rate=0.8)]}  # real: 0.08
        client = FakeRulesEngineClient()
        report = run_validator(config, client)
        assert len(report.rejected_rules) == 1
        assert client.submitted == []  # never reached the database
        msgs = " ".join(i.message for i in report.rejected_rules[0].issues)
        assert "80.0%" in msgs

    def test_threshold_and_payout_transposed(self):
        config = {"payment_methods": [uob_one_pm()],
                  "rules": [tier_rule(threshold=60, payout=600)]}  # real: 600/60
        client = FakeRulesEngineClient()
        report = run_validator(config, client)
        assert len(report.rejected_rules) == 1
        assert client.submitted == []
        msgs = " ".join(i.message for i in report.rejected_rules[0].issues)
        assert "transposed" in msgs

    def test_citation_free_rule_with_high_claimed_confidence(self):
        config = {"payment_methods": [uob_one_pm()],
                  "rules": [category_rate_rule(source_citations=[], ai_confidence=0.97)]}
        client = FakeRulesEngineClient()
        report = run_validator(config, client)
        assert len(report.rejected_rules) == 1
        assert client.submitted == []
        msgs = " ".join(i.message for i in report.rejected_rules[0].issues)
        assert "0.97" in msgs and "citation" in msgs.lower()

    def test_rule_referencing_nonexistent_method_id(self):
        config = {"payment_methods": [], "rules": [category_rate_rule(method_id="totally_made_up_card")]}
        client = FakeRulesEngineClient()  # empty DB — nothing exists
        report = run_validator(config, client)
        assert len(report.rejected_rules) == 1
        assert client.submitted == []
        msgs = " ".join(i.message for i in report.rejected_rules[0].issues)
        assert "totally_made_up_card" in msgs

    def test_duplicate_overlapping_rule(self):
        config = {"payment_methods": [uob_one_pm()],
                  "rules": [category_rate_rule(), category_rate_rule()]}
        client = FakeRulesEngineClient()
        report = run_validator(config, client)
        assert len(report.rejected_rules) == 2  # both flag each other
        assert client.submitted == []
        msgs = " ".join(i.message for r in report.rejected_rules for i in r.issues)
        assert "duplicate" in msgs

    def test_all_five_adversarial_cases_in_one_batch_pending_review_still_zero(self):
        """A batch mixing every adversarial case with zero good rules —
        confirms nothing at all reaches submit_method_rule()."""
        config = {
            "payment_methods": [uob_one_pm()],
            "rules": [
                category_rate_rule(rate=0.8),
                tier_rule(threshold=60, payout=600, categories=None),
                category_rate_rule(source_citations=[], ai_confidence=0.97, priority=31),
                category_rate_rule(method_id="totally_made_up_card", priority=32),
            ],
        }
        client = FakeRulesEngineClient()
        report = run_validator(config, client)
        assert len(report.accepted_rules) == 0
        assert len(report.rejected_rules) == 4
        assert client.submitted == []


class TestReportFormatting:
    def test_empty_report_still_states_nothing_is_live(self):
        report = ValidationReport()
        text = format_report(report)
        assert "Nothing above is live" in text

    def test_rejected_rule_reason_appears_in_report(self):
        config = {"payment_methods": [uob_one_pm()], "rules": [category_rate_rule(rate=0.8)]}
        report = run_validator(config, FakeRulesEngineClient())
        text = format_report(report)
        assert "REJECTED" in text
        assert "80.0%" in text


# ============ WP7 QA REVIEW REGRESSION TESTS ============
# One class per finding (Fix 1-4). Each test is written to FAIL against
# the pre-fix code and PASS against the fixed code — see this WP's report
# for the before/after run of each.

class TestFix2CitationHostParsing:
    """QA: `parsed.netloc.lower().split(":')[0]` returns the USERNAME,
    not the host, when the URL carries embedded credentials — every
    _PLACEHOLDER_HOSTS entry was bypassable by prefixing `x:y@`. Before
    the fix: `_looks_like_real_citation({'url': 'https://x:y@example.com/tnc'})`
    was True (bypassed) while the un-credentialed form was correctly
    False. After the fix (`urlparse(...).hostname`): both False, and
    credentialed URLs are rejected outright regardless of host."""

    def test_credentials_prefix_no_longer_bypasses_any_placeholder_host(self):
        for host in _PLACEHOLDER_HOSTS:
            plain = _looks_like_real_citation({"url": f"https://{host}/tnc"})
            credentialed = _looks_like_real_citation({"url": f"https://x:y@{host}/tnc"})
            assert plain is False, f"{host} should already be a placeholder"
            assert credentialed is False, (
                f"https://x:y@{host}/tnc bypassed the placeholder-host check via embedded "
                "credentials — this is the exact QA-reproduced bug"
            )

    def test_embedded_credentials_rejected_even_on_a_genuinely_real_host(self):
        """Citations to public T&C pages never need userinfo — reject the
        shape outright rather than trying to parse safely around it."""
        assert _looks_like_real_citation({"url": "https://x:y@www.uob.com.sg/one-card-tnc"}) is False

    def test_trailing_root_zone_dot_still_recognized_as_placeholder(self):
        assert _looks_like_real_citation({"url": "https://example.com./one-card-tnc"}) is False

    def test_bare_ipv4_host_rejected(self):
        assert _looks_like_real_citation({"url": "http://93.184.216.34/one-card-tnc"}) is False

    def test_bare_ipv6_host_rejected(self):
        assert _looks_like_real_citation({"url": "http://[2606:2800:220:1:248:1893:25c8:1946]/tnc"}) is False

    def test_genuine_https_url_to_a_real_host_still_passes(self):
        assert _looks_like_real_citation({"url": "https://www.uob.com.sg/one-card-tnc"}) is True


class TestFix1PaymentMethodSensitiveFieldProtection:
    """QA reproduced a silent full overwrite of an EXISTING uob_one row
    via run_validator()'s old best-effort payment_methods write:
    alert_senders gained an attacker-controlled domain and last4 changed,
    with zero issues raised. Fix: a change to alert_senders/
    statement_senders/last4 on an EXISTING method now blocks that row's
    entire write and is surfaced as a reject issue + a per-field diff in
    format_report(); a brand-new method or a non-sensitive-field change
    on an existing one is unaffected."""

    def test_sensitive_field_change_on_existing_method_is_blocked_not_written(self):
        existing_pm = uob_one_pm()
        attacker_pm = uob_one_pm(
            alert_senders=["uobgroup-com.attacker-controlled.io"],
            last4="9999",
        )
        config = {"payment_methods": [attacker_pm], "rules": []}
        client = FakeRulesEngineClient(existing_payment_methods={"uob_one": existing_pm})
        report = run_validator(config, client)

        assert client.pm_writes == []  # the whole row was never written — no partial write either
        assert len(report.payment_method_outcomes) == 1
        outcome = report.payment_method_outcomes[0]
        assert outcome.written is False
        assert outcome.is_new is False
        assert set(outcome.blocked_fields) == {"alert_senders", "last4"}
        assert any(iss.is_reject() for iss in report.payment_method_issues)
        msgs = " ".join(i.message for i in report.payment_method_issues)
        assert "attacker-controlled.io" in msgs or "9999" in msgs
        assert "/config" in msgs

    def test_report_shows_per_field_diff_not_a_bare_count(self):
        existing_pm = uob_one_pm()
        attacker_pm = uob_one_pm(alert_senders=["uobgroup-com.attacker-controlled.io"])
        config = {"payment_methods": [attacker_pm], "rules": []}
        client = FakeRulesEngineClient(existing_payment_methods={"uob_one": existing_pm})
        report = run_validator(config, client)
        text = format_report(report)
        assert "payment_methods written: " not in text  # the old bare-count line is gone
        assert "BLOCKED" in text
        assert "alert_senders" in text
        assert "uobgroup-com.attacker-controlled.io" in text  # the actual new value, visible in-line

    def test_statement_senders_change_on_existing_method_is_also_blocked(self):
        existing_pm = uob_one_pm()
        modified_pm = uob_one_pm(statement_senders=["evil.example"])
        config = {"payment_methods": [modified_pm], "rules": []}
        client = FakeRulesEngineClient(existing_payment_methods={"uob_one": existing_pm})
        report = run_validator(config, client)
        assert client.pm_writes == []
        assert "statement_senders" in report.payment_method_outcomes[0].blocked_fields

    def test_non_sensitive_field_change_on_existing_method_is_written(self):
        existing_pm = uob_one_pm()
        renamed_pm = uob_one_pm(display_name="UOB One (renamed)")
        config = {"payment_methods": [renamed_pm], "rules": []}
        client = FakeRulesEngineClient(existing_payment_methods={"uob_one": existing_pm})
        report = run_validator(config, client)
        assert len(client.pm_writes) == 1
        outcome = report.payment_method_outcomes[0]
        assert outcome.written is True
        assert outcome.blocked_fields == {}
        assert "display_name" in outcome.diff

    def test_brand_new_method_is_written_straight_through_unaffected(self):
        config = {"payment_methods": [hsbc_revo_pm()], "rules": []}
        client = FakeRulesEngineClient()  # nothing recorded yet
        report = run_validator(config, client)
        assert len(client.pm_writes) == 1
        outcome = report.payment_method_outcomes[0]
        assert outcome.is_new is True
        assert outcome.written is True


class TestFix3ExistingRewardTypeWins:
    """QA reproduced an existing cashback card resubmitted with
    reward_type='miles' and rate=8 passing every stage with zero issues
    — the batch's own claim overrode the DB-recorded value, so the
    plausibility check ran against the wrong unit. Fix: for an EXISTING
    method the DB-recorded reward_type always governs the plausibility
    check, and a batch claiming a different value is itself surfaced as
    a reject issue."""

    def test_relabelled_reward_type_is_itself_rejected_and_recorded_value_governs_rate_check(self):
        existing_pm = uob_one_pm()  # reward_type='cashback' on record
        relabelled_pm = uob_one_pm(reward_type="miles")
        config = {
            "payment_methods": [relabelled_pm],
            # rate=8 is implausible for cashback (800%) but plausible for miles —
            # exactly the QA-reproduced case.
            "rules": [category_rate_rule(rate=8)],
        }
        client = FakeRulesEngineClient(existing_payment_methods={"uob_one": existing_pm})
        report = run_validator(config, client)

        pm_msgs = " ".join(i.message for i in report.payment_method_issues)
        assert "reward_type" in pm_msgs and "cashback" in pm_msgs and "miles" in pm_msgs

        # The rule itself must still be judged against the RECORDED
        # ('cashback') reward_type, not the batch's relabelled claim —
        # rate=8 must be rejected, and nothing reaches the database.
        assert len(report.rejected_rules) == 1
        assert client.submitted == []

    def test_brand_new_method_has_nothing_to_override_batch_value_is_used(self):
        """No recorded value exists yet — the batch's own reward_type is
        all there is, and this case is unaffected by the fix."""
        config = {"payment_methods": [hsbc_revo_pm(reward_type="miles")],
                  "rules": [category_rate_rule(method_id="hsbc_revo", rate=8.0)]}
        client = FakeRulesEngineClient()  # nothing recorded yet
        report = run_validator(config, client)
        assert len(report.accepted_rules) == 1
        assert not report.payment_method_issues


class TestFix4TxnMinZeroCapBasisFlipMethodIdCharset:
    """QA: txn_min=0 is accepted today at every stage including the DB
    trigger (which only rejects < 0), but evaluate_period() treats a
    null txn_min identically via coalesce(txn_min, 0) — 0 is a
    degenerate always-cleared gate. Also: a cap_basis flip
    ('reward'<->'spend') on the same cap slot carries the same number
    but a wildly different meaning, and was silent. Also: method_id had
    no charset check, unlike domain fields."""

    def test_txn_min_zero_rejected_as_degenerate_gate(self):
        config = {"payment_methods": [uob_one_pm()], "rules": [tier_rule(txn_min=0)]}
        issues = schema_issues(config)
        assert any(i.is_reject() and "txn_min" in i.message and "0" in i.message for i in issues)

    def test_txn_min_positive_still_fine(self):
        config = {"payment_methods": [uob_one_pm()], "rules": [tier_rule(txn_min=10)]}
        issues = schema_issues(config)
        assert not any(i.is_reject() and "txn_min" in i.message for i in issues)

    def test_txn_min_null_still_fine(self):
        config = {"payment_methods": [uob_one_pm()], "rules": [tier_rule(txn_min=None)]}
        issues = schema_issues(config)
        assert not any(i.is_reject() and "txn_min" in i.message for i in issues)

    def test_cap_basis_flip_from_reward_to_spend_warns_not_rejects(self):
        rule = cap_rule(cap_basis="spend")
        issues = semantic_issues(rule, 0, reward_type="cashback", existing_cap_basis="reward")
        assert len(issues) == 1
        assert not issues[0].is_reject()
        assert "cap_basis" in issues[0].message
        assert "reward" in issues[0].message and "spend" in issues[0].message

    def test_cap_basis_unchanged_from_existing_no_warning(self):
        rule = cap_rule(cap_basis="reward")
        assert semantic_issues(rule, 0, reward_type="cashback", existing_cap_basis="reward") == []

    def test_cap_basis_with_no_matching_existing_row_no_warning(self):
        rule = cap_rule(cap_basis="spend")
        assert semantic_issues(rule, 0, reward_type="cashback", existing_cap_basis=None) == []

    def test_cap_basis_flip_surfaced_through_run_validator_as_a_warn_that_still_lands_pending_review(self):
        existing_rules = {"uob_one": [{
            "id": 1, "method_id": "uob_one", "rule_type": "cap", "categories": None,
            "condition_key": None, "cap_basis": "reward",
            "valid_from": "2024-01-01", "valid_to": "2025-06-30",
        }]}
        new_rule = cap_rule(cap_basis="spend", valid_from="2025-07-01", valid_to=None)
        config = {"payment_methods": [uob_one_pm()], "rules": [new_rule]}
        client = FakeRulesEngineClient(
            existing_payment_methods={"uob_one": uob_one_pm()}, existing_rules=existing_rules,
        )
        report = run_validator(config, client)
        assert len(report.accepted_rules) == 1  # a warn never blocks
        warn_msgs = " ".join(i.message for i in report.accepted_rules[0].issues)
        assert "cap_basis" in warn_msgs

    def test_cyrillic_lookalike_method_id_rejected(self):
        # 'о' in "uоb_one" is U+043E CYRILLIC SMALL LETTER O, not ASCII 'o'
        pm = uob_one_pm(id="uоb_one")
        config = {"payment_methods": [pm], "rules": []}
        issues = schema_issues(config)
        assert any(i.is_reject() and "ascii" in i.message.lower() for i in issues)

    def test_valid_snake_case_method_id_unaffected(self):
        pm = uob_one_pm(id="uob_one_2")
        config = {"payment_methods": [pm], "rules": []}
        issues = schema_issues(config)
        assert not any(i.is_reject() for i in issues if i.method_index == 0)
