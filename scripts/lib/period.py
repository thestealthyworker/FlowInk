"""Python port of supabase/functions/_shared/period.ts — keep both in sync.
See docs/cardledger-build-spec.md §3: card periods are not calendar
months, and are not the same as each other.
"""
from __future__ import annotations

from datetime import date, datetime


def calendar_month(txn_date: str) -> str:
    return txn_date[:7]


def resolve_period_key(method_id: str, period_type: str, cycle_day: int | None, txn_date: str) -> str:
    if period_type == "calendar":
        return f"{method_id}:{calendar_month(txn_date)}"

    if cycle_day is None:
        return f"{method_id}:pending"

    d = datetime.strptime(txn_date, "%Y-%m-%d").date()
    if d.day > cycle_day:
        if d.month == 12:
            d = date(d.year + 1, 1, 1)
        else:
            d = date(d.year, d.month + 1, 1)
    return f"{method_id}:{d.year:04d}-{d.month:02d}"
