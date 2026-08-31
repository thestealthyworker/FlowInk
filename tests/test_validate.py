"""Pure logic tests for the statement-row validation contract (§8),
no network.

Regression coverage for the defect where ingest_statements.py's old
validation only checked field falsiness — a negative amount (truthy in
Python) inserted cleanly and subtracted from spend.

Run: pytest tests/test_validate.py -v
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from lib.validate import (  # noqa: E402
    is_valid_amount,
    is_valid_currency,
    is_valid_txn_date,
    validate_statement_row,
)


def valid_row(**overrides):
    row = {
        "txn_date": "2026-07-06",
        "posted_date": None,
        "merchant_raw": "Riverside Home Store",
        "amount": 214.75,
        "currency": "SGD",
        "fx_amount": None,
    }
    row.update(overrides)
    return row


# ---------- is_valid_amount ----------


def test_negative_amount_is_invalid_the_critical_regression():
    # A negative amount is truthy in Python — `if not row.get("amount")`
    # (the old check) lets it straight through.
    assert is_valid_amount(-50.00) is False


def test_zero_amount_is_invalid():
    assert is_valid_amount(0) is False


def test_positive_amount_is_valid():
    assert is_valid_amount(50.00) is True
    assert is_valid_amount(1) is True


def test_bool_is_never_treated_as_amount():
    assert is_valid_amount(True) is False
    assert is_valid_amount(False) is False


def test_non_numeric_amount_is_invalid():
    assert is_valid_amount("50.00") is False
    assert is_valid_amount(None) is False


# ---------- is_valid_currency ----------


def test_valid_iso4217_codes():
    assert is_valid_currency("SGD") is True
    assert is_valid_currency("USD") is True


def test_lowercase_currency_is_rejected_format_is_strict():
    assert is_valid_currency("sgd") is False


def test_fabricated_currency_code_is_rejected():
    assert is_valid_currency("ZZZ") is False
    assert is_valid_currency("XXX") is False


def test_non_string_currency_is_rejected():
    assert is_valid_currency(None) is False
    assert is_valid_currency(123) is False


# ---------- is_valid_txn_date ----------


def test_valid_past_date():
    assert is_valid_txn_date("2026-07-06") is True


def test_malformed_date_is_rejected():
    assert is_valid_txn_date("06/07/2026") is False
    assert is_valid_txn_date("not-a-date") is False
    assert is_valid_txn_date(None) is False


def test_far_future_date_is_rejected():
    assert is_valid_txn_date("2099-01-01") is False


def test_far_past_date_is_rejected():
    assert is_valid_txn_date("1900-01-01") is False


# ---------- validate_statement_row ----------


def test_valid_row_passes():
    assert validate_statement_row(valid_row()) is None


def test_negative_amount_row_is_rejected_not_silently_dropped():
    reason = validate_statement_row(valid_row(amount=-50.00))
    assert reason == "invalid_amount"


def test_missing_merchant_is_rejected():
    reason = validate_statement_row(valid_row(merchant_raw=""))
    assert reason == "missing_merchant_raw"


def test_invalid_currency_is_rejected():
    reason = validate_statement_row(valid_row(currency="ZZZ"))
    assert reason == "invalid_currency"


def test_invalid_fx_amount_is_rejected():
    reason = validate_statement_row(valid_row(fx_amount=-1))
    assert reason == "invalid_fx_amount"


def test_null_fx_amount_is_fine():
    assert validate_statement_row(valid_row(fx_amount=None)) is None
