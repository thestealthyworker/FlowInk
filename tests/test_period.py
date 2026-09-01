"""Pure logic tests, no network. Run: pytest tests/test_period.py

See docs/architecture.md §3 — the trap that will break this
system if got wrong. UOB One and Citi Cash Back are statement-month
based (anchored to cycle_day); HSBC Revolution is calendar-month based.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from lib.period import calendar_month, resolve_period_key  # noqa: E402


def test_calendar_month_extracts_yyyy_mm():
    assert calendar_month("2026-09-18") == "2026-09"


def test_calendar_period_ignores_cycle_day():
    # HSBC Revolution: calendar months, cycle_day is irrelevant/null.
    assert resolve_period_key("hsbc_revo", "calendar", None, "2026-09-30") == "hsbc_revo:2026-09"
    assert resolve_period_key("hsbc_revo", "calendar", None, "2026-10-01") == "hsbc_revo:2026-10"


def test_statement_period_before_close_day_stays_in_current_month():
    # cycle_day = 25: a txn on the 10th belongs to the statement closing this month.
    assert resolve_period_key("citi_cashback", "statement", 25, "2026-09-10") == "citi_cashback:2026-09"


def test_statement_period_after_close_day_rolls_to_next_month():
    assert resolve_period_key("citi_cashback", "statement", 25, "2026-09-28") == "citi_cashback:2026-10"


def test_statement_period_rolls_over_year_boundary():
    assert resolve_period_key("citi_cashback", "statement", 25, "2026-12-28") == "citi_cashback:2027-01"


def test_statement_period_unknown_cycle_day_is_pending_not_a_guess():
    # uob_one's cycle_day is unknown until a real statement is read (§5, §12
    # item 6) — must not silently guess a period.
    assert resolve_period_key("uob_one", "statement", None, "2026-09-10") == "uob_one:pending"
