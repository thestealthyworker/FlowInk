"""Validation contract for extracted statement transaction rows.

docs/cardledger-build-spec.md §8 defines the validation contract for the
alert parser (JOB-1); the statement branch (JOB-2, ingest_statements.py)
previously applied none of it — it only checked field falsiness, so a
negative amount (truthy in Python) inserted cleanly and subtracted from
spend. This module applies the same spirit of contract to statement rows:
amount > 0, a sane ISO-8601 date, and an ISO-4217 currency code.

"Never insert an unvalidated row. A wrong transaction is worse than a
missing one." (§8) A row that fails any check here must be routed to a
recorded failure (parse_failures), never silently dropped or, worse,
silently inserted.
"""
from __future__ import annotations

import re
from datetime import date, datetime, timedelta, timezone

_CURRENCY_FORMAT_RE = re.compile(r"^[A-Z]{3}$")

# ISO 4217 alphabetic codes in active circulation. A format check alone
# (three uppercase letters) would happily accept a fabricated code such as
# "ZZZ" from a prompt-injected PDF; membership in this list is the actual
# "ISO-4217 currency" contract.
ISO_4217_CODES: frozenset[str] = frozenset(
    {
        "AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN",
        "BAM", "BBD", "BDT", "BGN", "BHD", "BIF", "BMD", "BND", "BOB", "BRL",
        "BSD", "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHF", "CLP", "CNY",
        "COP", "CRC", "CUP", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD", "EGP",
        "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP", "GMD",
        "GNF", "GTQ", "GYD", "HKD", "HNL", "HTG", "HUF", "IDR", "ILS", "INR",
        "IQD", "IRR", "ISK", "JMD", "JOD", "JPY", "KES", "KGS", "KHR", "KMF",
        "KPW", "KRW", "KWD", "KYD", "KZT", "LAK", "LBP", "LKR", "LRD", "LSL",
        "LYD", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU", "MUR",
        "MVR", "MWK", "MXN", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR",
        "NZD", "OMR", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "PYG", "QAR",
        "RON", "RSD", "RUB", "RWF", "SAR", "SBD", "SCR", "SDG", "SEK", "SGD",
        "SHP", "SLE", "SOS", "SRD", "SSP", "STN", "SYP", "SZL", "THB", "TJS",
        "TMT", "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "UGX", "USD",
        "UYU", "UZS", "VES", "VND", "VUV", "WST", "XAF", "XCD", "XOF", "XPF",
        "YER", "ZAR", "ZMW", "ZWL",
    }
)


def is_valid_amount(amount: object) -> bool:
    """Numeric and strictly positive.

    ``bool`` is a subtype of ``int`` in Python (``isinstance(True, int)``
    is ``True``), so it is excluded explicitly to avoid ``True`` being
    treated as a valid amount of ``1``.
    """
    if isinstance(amount, bool):
        return False
    if not isinstance(amount, (int, float)):
        return False
    return amount > 0


def is_valid_currency(code: object) -> bool:
    return isinstance(code, str) and bool(_CURRENCY_FORMAT_RE.match(code)) and code in ISO_4217_CODES


def is_valid_txn_date(
    txn_date: object,
    *,
    max_future_days: int = 1,
    max_past_days: int | None = 3660,
) -> bool:
    """A sane ISO-8601 calendar date.

    Statement transactions are already posted, so the future window is
    tight (one day, for clock skew between the statement issuer and this
    job). The past window is generous (roughly ten years) — wide enough to
    never reject a legitimate old transaction, narrow enough to reject an
    obviously fabricated or malformed date.
    """
    if not isinstance(txn_date, str):
        return False
    try:
        d = date.fromisoformat(txn_date)
    except ValueError:
        return False
    today = datetime.now(timezone.utc).date()
    if d > today + timedelta(days=max_future_days):
        return False
    if max_past_days is not None and (today - d).days > max_past_days:
        return False
    return True


def validate_statement_row(row: dict) -> str | None:
    """Apply the validation contract to one extracted statement line.

    Returns ``None`` if the row is acceptable to insert, else a short
    machine-readable reason string suitable for a ``parse_failures.reason``
    value.
    """
    merchant_raw = row.get("merchant_raw")
    if not isinstance(merchant_raw, str) or not merchant_raw.strip():
        return "missing_merchant_raw"
    if not is_valid_amount(row.get("amount")):
        return "invalid_amount"
    if not is_valid_txn_date(row.get("txn_date")):
        return "invalid_txn_date"
    currency = row.get("currency") or "SGD"
    if not is_valid_currency(currency):
        return "invalid_currency"
    fx_amount = row.get("fx_amount")
    if fx_amount is not None and not is_valid_amount(fx_amount):
        return "invalid_fx_amount"
    posted_date = row.get("posted_date")
    if posted_date is not None and not is_valid_txn_date(posted_date):
        return "invalid_posted_date"
    return None
