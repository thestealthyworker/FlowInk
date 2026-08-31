"""WP2 (design/ingestion-routing.md §3): asserts the Python domain-syntax
validator against the shared fixture also asserted against by the
TypeScript port (supabase/functions/_shared/domain_validation_test.ts).

The fixture, not this file, is the source of truth for which domain
strings are valid/invalid — see tests/fixtures/domain-validation-cases.json
for the full rationale on each case, especially the lookalike-subdomain
attack case (valid SYNTAX, but must be rejected by the separate exact-match
routing check — see test_senders.py).

Run: pytest tests/test_domain_validation_fixture.py -v
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from lib.senders import is_valid_domain_syntax  # noqa: E402

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "domain-validation-cases.json"


def load_cases() -> list[dict]:
    return json.loads(FIXTURE_PATH.read_text())["cases"]


CASES = load_cases()


def test_fixture_loads_and_is_nonempty():
    assert len(CASES) > 0


def test_fixture_contains_the_lookalike_subdomain_attack_case():
    # Named per the task brief: this exact case must be present in the
    # shared fixture, not just covered incidentally somewhere else.
    domains = {c["domain"] for c in CASES}
    assert "uobgroup.com.attacker.io" in domains


def test_fixture_contains_the_non_ascii_homoglyph_case():
    domains = {c["domain"] for c in CASES}
    assert "аttacker.io" in domains  # Cyrillic 'а', not ASCII 'a'


import pytest  # noqa: E402


@pytest.mark.parametrize("case", CASES, ids=[repr(c["domain"]) for c in CASES])
def test_domain_validation_matches_fixture(case: dict):
    assert is_valid_domain_syntax(case["domain"]) is case["valid"], (
        f"is_valid_domain_syntax({case['domain']!r}) should be {case['valid']} "
        f"({case.get('note', '')})"
    )
