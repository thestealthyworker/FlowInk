"""Pure logic tests for reconciliation matching, no network.

Covers the two defects called out in docs/cardledger-build-spec.md §4
trap 1 and §7's PayLah note: an FX transaction must reconcile by
comparing like-currency amounts, and a method with no statement source
(PayLah) must never be scoped into the stale-reversal sweep.

Run: pytest tests/test_reconcile.py -v
"""
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from reconcile import comparable_amounts, find_matches, parse_timestamp  # noqa: E402
from lib import senders  # noqa: E402


def _iso(dt: datetime) -> str:
    return dt.isoformat()


NOW = datetime(2026, 8, 25, tzinfo=timezone.utc)


def provisional_row(**overrides):
    row = {
        "id": "p1",
        "method_id": "uob_one",
        "txn_date": "2026-06-10",
        "amount": 412.50,
        "currency": "USD",
        "fx_amount": None,
        "merchant_raw": "Nordkap Optics GmbH",
        "created_at": _iso(NOW),
    }
    row.update(overrides)
    return row


def statement_row(**overrides):
    row = {
        "id": "s1",
        "method_id": "uob_one",
        "txn_date": "2026-06-11",
        "amount": 573.96,  # SGD, after conversion + 3.25% FX fee
        "currency": "SGD",
        "fx_amount": 412.50,
        "posted_date": "2026-06-11",
        "merchant_raw": "NORDKAP OPTICS GMBH",
        "created_at": _iso(NOW),
    }
    row.update(overrides)
    return row


# ---------- comparable_amounts ----------


def test_comparable_amounts_same_currency_compares_directly():
    p = provisional_row(currency="SGD", amount=50.00)
    s = statement_row(currency="SGD", amount=50.00, fx_amount=None)
    assert comparable_amounts(p, s) == (50.00, 50.00)


def test_comparable_amounts_fx_compares_foreign_to_foreign_not_sgd_billed():
    # Provisional carries the ORIGINAL foreign amount (alerts never
    # convert, §8). The statement carries the SGD-billed amount plus
    # fx_amount = the original foreign figure. Comparing amount-to-amount
    # across currencies (412.50 USD vs 573.96 SGD) would never be within
    # tolerance; the fix must compare 412.50 vs fx_amount=412.50 instead.
    p = provisional_row()
    s = statement_row()
    assert comparable_amounts(p, s) == (412.50, 412.50)


def test_comparable_amounts_returns_none_when_currencies_differ_and_no_fx_amount():
    p = provisional_row()
    s = statement_row(fx_amount=None)
    assert comparable_amounts(p, s) is None


# ---------- find_matches: the FX case ----------


def test_fx_transaction_reconciles_via_fx_amount():
    provisional = [provisional_row()]
    statements = [statement_row()]

    result = find_matches(provisional, statements)

    assert len(result.matches) == 1
    matched_provisional, matched_stmt = result.matches[0]
    assert matched_provisional["id"] == "p1"
    assert matched_stmt["id"] == "s1"
    assert result.unmatched_statement == []
    assert result.remaining_provisional == {}


def test_fx_transaction_without_currency_awareness_would_not_match():
    # Sanity check on the fixture itself: raw amount-to-amount comparison
    # (the pre-fix behaviour) is far outside ±2% tolerance, confirming
    # this fixture actually exercises the FX bug and isn't a false pass.
    p = provisional_row()
    s = statement_row()
    raw_delta = abs(float(p["amount"]) - float(s["amount"]))
    tolerance = 0.02 * float(s["amount"])
    assert raw_delta > tolerance


# ---------- find_matches: PayLah has no statement source ----------


def test_paylah_provisional_never_matches_since_it_has_no_statement_source():
    paylah_provisional = provisional_row(
        id="p2", method_id="paylah", currency="SGD", amount=5.00, merchant_raw="N.N.HARBOURLIGHT BISTRO"
    )
    # No PayLah statement rows exist anywhere in the system by design.
    result = find_matches([paylah_provisional], statement_rows=[])

    assert result.matches == []
    assert "p2" in result.remaining_provisional


def test_paylah_is_excluded_from_reconcilable_method_ids():
    domain_map = senders.statement_sender_domains()
    assert "paylah" not in senders.reconcilable_method_ids(domain_map)
    assert "uob_one" in senders.reconcilable_method_ids(domain_map)


def test_stale_paylah_provisional_must_not_be_swept_as_reversed():
    # Mirrors the scoping reconcile.main() applies before the 45-day
    # reversal sweep: only method_ids in reconcilable_method_ids() are
    # eligible. A stale PayLah row must be filtered out before the sweep
    # ever inspects its age.
    stale_created_at = _iso(NOW - timedelta(days=60))
    paylah_provisional = provisional_row(id="p3", method_id="paylah", created_at=stale_created_at)

    result = find_matches([paylah_provisional], statement_rows=[])
    reconcilable = senders.reconcilable_method_ids()

    eligible_for_reversal = [
        p for p in result.remaining_provisional.values() if p["method_id"] in reconcilable
    ]
    assert eligible_for_reversal == []


def test_stale_uob_provisional_is_eligible_for_reversal_scoping():
    stale_created_at = _iso(NOW - timedelta(days=60))
    uob_provisional = provisional_row(id="p4", created_at=stale_created_at)

    result = find_matches([uob_provisional], statement_rows=[])
    reconcilable = senders.reconcilable_method_ids()

    eligible_for_reversal = [
        p for p in result.remaining_provisional.values() if p["method_id"] in reconcilable
    ]
    assert [p["id"] for p in eligible_for_reversal] == ["p4"]


# ---------- find_matches: general matching behaviour ----------


def test_no_match_across_different_method_ids():
    p = provisional_row(method_id="hsbc_revo")
    s = statement_row(method_id="uob_one")
    result = find_matches([p], [s])
    assert result.matches == []
    assert result.unmatched_statement == [s]


def test_no_match_outside_date_tolerance():
    p = provisional_row(txn_date="2026-06-01")
    s = statement_row(txn_date="2026-06-10")
    result = find_matches([p], [s])
    assert result.matches == []


def test_best_match_picks_closest_candidate_not_first():
    # Two provisional candidates both within tolerance of one statement
    # row; the closer one (by date+amount distance) must win, regardless
    # of dict iteration order.
    far = provisional_row(id="far", txn_date="2026-06-08", amount=412.50)
    close = provisional_row(id="close", txn_date="2026-06-11", amount=412.50)
    s = statement_row(txn_date="2026-06-11", fx_amount=412.50)

    result = find_matches([far, close], [s])

    assert len(result.matches) == 1
    matched_provisional, _ = result.matches[0]
    assert matched_provisional["id"] == "close"


def test_unmatched_statement_row_reported_when_no_candidate_in_tolerance():
    s = statement_row()
    result = find_matches([], [s])
    assert result.unmatched_statement == [s]
    assert result.matches == []


# ---------- parse_timestamp ----------


def test_parse_timestamp_handles_z_suffix_and_short_fractional_seconds():
    a = parse_timestamp("2026-07-01T12:34:56Z")
    b = parse_timestamp("2026-07-01T12:34:56.5+00:00")
    assert b > a
