#!/usr/bin/env python3
"""JOB-3 · reconcile. GitHub Actions, runs immediately after JOB-2.

See docs/cardledger-build-spec.md §7. Matches provisional (alert-sourced)
rows against confirmed (statement-sourced) rows on
(method_id, amount ±2%, txn_date ±3 days, merchant fuzzy).

Reconciliation semantics, since the build spec describes the matching
rule but not how to avoid double-counting spend once both rows exist:

- On a match, the PROVISIONAL row is updated in place (amount, currency,
  fx_amount, posted_date, status -> 'confirmed', reconciled_with -> the
  statement row's id). It keeps its original source/source_ref, so the
  alert that first surfaced the transaction stays the audit trail.
- The STATEMENT row is marked reconciled_with -> the provisional row's id
  and excluded from spend totals from then on (its data has been folded
  into the provisional row). The exclusion predicate is encapsulated in
  the `spend_transactions` view (supabase/migrations/0001_schema.sql) —
  use that view rather than reimplementing the predicate.
- Unmatched provisional rows older than 45 days are marked 'reversed'
  (likely a dropped pre-auth) — but ONLY for methods that actually have a
  statement source (lib.senders.reconcilable_method_ids()). PayLah has no
  statement source at all, so its provisional rows can never match; without
  this scoping every PayLah row gets reversed at 45 days regardless of
  whether it was real spend.
- Unmatched statement rows are left as-is (source='statement',
  reconciled_with=null) — they count as real spend AND as a miss: an
  alert that should have fired and didn't. Miss rate = unmatched
  statement rows introduced since the previous reconcile run / statement
  rows introduced since the previous reconcile run. Above 5% means the
  alert threshold isn't low enough (§7) — reported via a healthchecks.io
  `/log` ping (see `escalate_log` below; Telegram was removed 2026-08-25,
  docs/cardledger-build-spec.md §10 AMENDMENT).

FX handling (§4 trap 1): a UOB alert stores the transaction in its
ORIGINAL foreign currency (UOB never converts in the alert body) while the
statement stores the SGD-billed amount plus fx_amount = the original
foreign amount. Comparing provisional.amount (foreign) against
stmt.amount (SGD) is comparing two different numbers in two different
currencies — they will almost never land within ±2% of each other, so
every FX transaction would silently fail to reconcile and eventually get
reversed as stale, deleting real spend. `comparable_amounts()` below picks
the correct pair to compare: same-currency amount vs amount when
currencies agree, otherwise foreign amount vs statement.fx_amount.
"""
from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from lib import senders  # noqa: E402
from lib.healthchecks import ping_fail, ping_log  # noqa: E402
from lib.merchant import normalize_merchant  # noqa: E402
from lib.supabase_rest import SupabaseREST  # noqa: E402

import requests  # noqa: E402

AMOUNT_TOLERANCE = 0.02
DATE_TOLERANCE_DAYS = 3
STALE_PROVISIONAL_DAYS = 45
MISS_RATE_ALERT_THRESHOLD = 0.05

PROVISIONAL_SELECT = "id,method_id,txn_date,amount,currency,fx_amount,merchant_raw,created_at"
STATEMENT_SELECT = "id,method_id,txn_date,amount,currency,fx_amount,posted_date,merchant_raw,created_at"


def days_between(a: str, b: str) -> int:
    return abs((date.fromisoformat(a) - date.fromisoformat(b)).days)


_FRACTIONAL_SECONDS_RE = re.compile(r"\.(\d+)")


def parse_timestamp(value: str) -> datetime:
    """Parse a PostgREST timestamptz string into an aware datetime.

    Comparing these as raw strings (the previous approach at the old
    reconcile.py:128) is fragile: ISO-8601 strings only sort correctly
    lexicographically when every value shares the same zone notation and
    fractional-second precision, and PostgREST's output for that is not
    guaranteed to be uniform. Parsing avoids the whole class of bug.

    Two normalisations before handing off to ``datetime.fromisoformat``,
    which is stricter about its input than the ISO 8601 standard is:
    - Python 3.9 (the runtime this ships to) does not accept a bare ``Z``
      suffix — rewrite it to an explicit UTC offset.
    - fromisoformat only accepts exactly 3 or 6 fractional-second digits,
      but Postgres's default text output trims trailing zeros (".5"
      instead of ".500000") — pad or truncate to 6 digits.
    """
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value

    match = _FRACTIONAL_SECONDS_RE.search(normalized)
    if match:
        digits = (match.group(1) + "000000")[:6]
        normalized = normalized[: match.start()] + "." + digits + normalized[match.end() :]

    dt = datetime.fromisoformat(normalized)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def is_merchant_fuzzy_match(a: str, b: str) -> bool:
    na, nb = normalize_merchant(a), normalize_merchant(b)
    if not na or not nb:
        return False
    return na in nb or nb in na


def comparable_amounts(provisional: dict, stmt: dict) -> tuple[float, float] | None:
    """Return (provisional_amount, statement_amount) in a shared currency,
    or None if there is no way to compare them like-for-like.

    - Same currency on both sides: compare amount to amount directly.
    - Different currency: the provisional row (from an alert) holds the
      original foreign-currency amount, never converted (§8: "Never
      convert currency"). The statement row holds the SGD-billed amount
      plus fx_amount = the original foreign amount it was converted from.
      Compare provisional.amount against stmt.fx_amount instead — both are
      the foreign-currency figure.
    - Different currency with no fx_amount recorded on the statement side:
      there is nothing to compare like-for-like. Do not guess by comparing
      across currencies; skip this candidate (return None).
    """
    p_amount = float(provisional["amount"])
    p_currency = (provisional.get("currency") or "SGD").upper()
    s_amount = float(stmt["amount"])
    s_currency = (stmt.get("currency") or "SGD").upper()

    if p_currency == s_currency:
        return p_amount, s_amount

    s_fx_amount = stmt.get("fx_amount")
    if s_fx_amount is not None:
        return p_amount, float(s_fx_amount)

    return None


def candidate_score(p: dict, stmt: dict, amount_a: float, amount_b: float, amount_tolerance_abs: float) -> float:
    """Combined normalised distance: date-days/tolerance + amount-delta/tolerance.

    Lower is better. Used so the closest candidate wins instead of merely
    the first one encountered in dict iteration order (the previous
    ``break``-on-first-match at reconcile.py:92-103), which could bind a
    provisional row to a worse match while a strictly-closer one sat
    later in the same method_id group.
    """
    date_component = days_between(p["txn_date"], stmt["txn_date"]) / DATE_TOLERANCE_DAYS
    amount_component = (abs(amount_a - amount_b) / amount_tolerance_abs) if amount_tolerance_abs else 0.0
    return date_component + amount_component


@dataclass
class ReconcileResult:
    matches: list[tuple[dict, dict]] = field(default_factory=list)  # (provisional_row, statement_row)
    unmatched_statement: list[dict] = field(default_factory=list)
    remaining_provisional: dict = field(default_factory=dict)  # id -> row, still unmatched


def find_matches(provisional: list[dict], statement_rows: list[dict]) -> ReconcileResult:
    """Pure matching logic — no network — so it is directly testable.

    For each statement row, scores every same-method_id, in-tolerance
    provisional candidate and keeps the lowest-scoring one, rather than
    the first one encountered.
    """
    unmatched_provisional = {p["id"]: p for p in provisional}
    matches: list[tuple[dict, dict]] = []
    unmatched_statement: list[dict] = []

    for stmt in statement_rows:
        best: dict | None = None
        best_score: float | None = None

        for p in unmatched_provisional.values():
            if p["method_id"] != stmt["method_id"]:
                continue
            if days_between(p["txn_date"], stmt["txn_date"]) > DATE_TOLERANCE_DAYS:
                continue

            pair = comparable_amounts(p, stmt)
            if pair is None:
                continue
            amount_a, amount_b = pair
            amount_tolerance_abs = AMOUNT_TOLERANCE * max(abs(amount_b), 1)
            if abs(amount_a - amount_b) > amount_tolerance_abs:
                continue

            if not is_merchant_fuzzy_match(p["merchant_raw"], stmt["merchant_raw"]):
                continue

            score = candidate_score(p, stmt, amount_a, amount_b, amount_tolerance_abs)
            if best is None or score < best_score:  # type: ignore[operator]
                best, best_score = p, score

        if best is None:
            unmatched_statement.append(stmt)
        else:
            matches.append((best, stmt))
            del unmatched_provisional[best["id"]]

    return ReconcileResult(matches=matches, unmatched_statement=unmatched_statement, remaining_provisional=unmatched_provisional)


def escalate_fail(reason: str) -> None:
    """Fires a healthchecks.io `/fail` ping — an immediate alert email —
    and makes sure a delivery failure itself is visible (stderr) rather
    than disappearing the way the old `send_telegram()`'s unset-env
    no-op did. Reserve for genuine system-down conditions: the reconcile
    run itself crashing. Mirrors
    supabase/functions/ingest-alerts/index.ts's `escalateFail`.
    """
    result = ping_fail(reason)
    if not result.ok:
        print(f"reconcile: healthchecks /fail ping did not send: {result.error}", file=sys.stderr)


def escalate_log(reason: str) -> None:
    """Fires a healthchecks.io `/log` ping — recorded, no alert. For
    data-quality issues (an above-threshold miss rate) that are not
    themselves evidence the system is down; using `/fail` here would
    train the operator to ignore the alarm. Mirrors
    supabase/functions/ingest-alerts/index.ts's `escalateLog`.
    """
    result = ping_log(reason)
    if not result.ok:
        print(f"reconcile: healthchecks /log ping did not send: {result.error}", file=sys.stderr)


def apply_match(db: SupabaseREST, provisional: dict, stmt: dict) -> bool:
    """Apply one match's two updates, compensating if the second fails.

    Neither PostgREST nor this thin client offers a cross-request
    transaction, so the two updates that make up a match (provisional ->
    confirmed, statement -> reconciled_with) are not atomic by
    construction. Left uncaught (the previous behaviour), a failure on the
    second update leaves the provisional row already flipped to
    'confirmed' while the statement row still has reconciled_with IS
    NULL — next run, the statement row is re-selected as still-unmatched
    (double-counted as spend, since spend_transactions does not exclude
    an unreconciled statement row) while the now-'confirmed' provisional
    row keeps counting too. Permanent double count.

    On failure of the second update, revert the first so the pair goes
    back to "unmatched" instead of "half-matched" — a retryable state
    instead of a silently corrupt one — and log loudly.
    """
    try:
        db.update(
            "transactions",
            {"id": provisional["id"]},
            {
                "amount": stmt["amount"],
                "currency": stmt["currency"],
                "fx_amount": stmt.get("fx_amount"),
                "posted_date": stmt.get("posted_date"),
                "status": "confirmed",
                "reconciled_with": stmt["id"],
            },
        )
    except requests.RequestException as exc:
        print(f"ERROR: failed to update provisional row {provisional['id']} during match: {exc}", file=sys.stderr)
        return False

    try:
        db.update("transactions", {"id": stmt["id"]}, {"reconciled_with": provisional["id"]})
    except requests.RequestException as exc:
        print(
            f"ERROR: failed to update statement row {stmt['id']} during match — "
            f"reverting provisional row {provisional['id']} to avoid a half-matched pair: {exc}",
            file=sys.stderr,
        )
        try:
            db.update(
                "transactions",
                {"id": provisional["id"]},
                {
                    "amount": provisional["amount"],
                    "currency": provisional.get("currency"),
                    "fx_amount": provisional.get("fx_amount"),
                    "posted_date": None,
                    "status": "provisional",
                    "reconciled_with": None,
                },
            )
        except requests.RequestException as revert_exc:
            print(
                f"CRITICAL: compensating revert of provisional row {provisional['id']} also failed: "
                f"{revert_exc} — this row is now half-matched and needs manual repair",
                file=sys.stderr,
            )
        return False

    return True


def main() -> int:
    db = SupabaseREST()

    reconcile_state = db.select("ingest_state", {"stream": "eq.reconcile", "select": "watermark"})
    last_run_ms = reconcile_state[0]["watermark"] if reconcile_state else 0
    run_started_ms = int(datetime.now(timezone.utc).timestamp() * 1000)

    provisional = db.select("transactions", {"status": "eq.provisional", "select": PROVISIONAL_SELECT})
    statement_rows = db.select(
        "transactions",
        {"source": "eq.statement", "reconciled_with": "is.null", "select": STATEMENT_SELECT},
    )

    result = find_matches(provisional, statement_rows)

    matched = 0
    for provisional_row, stmt_row in result.matches:
        if apply_match(db, provisional_row, stmt_row):
            matched += 1

    # §4 trap 3 / defect 6: PayLah (and anything else with no statement
    # source) can never produce a matching statement row, so its
    # provisional rows must never be reversed as "stale" — that would
    # delete real spend every month. Scope the 45-day reversal to methods
    # that actually have a reconciliation path.
    reconcilable_methods = senders.reconcilable_method_ids()
    stale_cutoff = datetime.now(timezone.utc) - timedelta(days=STALE_PROVISIONAL_DAYS)
    reversed_count = 0
    for p in result.remaining_provisional.values():
        if p["method_id"] not in reconcilable_methods:
            continue
        if parse_timestamp(p["created_at"]) < stale_cutoff:
            db.update("transactions", {"id": p["id"]}, {"status": "reversed"})
            reversed_count += 1

    # Miss-rate metric, scoped to statement rows introduced since the
    # previous reconcile run (defect 12). Without this scoping, both the
    # numerator and denominator are "every statement row ever left
    # unmatched", so old misses that were never going to reconcile
    # accumulate in both counts forever and the >5% alarm re-fires daily
    # with identical content instead of reflecting this run's health.
    this_run_statement_rows = [
        s for s in statement_rows if int(parse_timestamp(s["created_at"]).timestamp() * 1000) > last_run_ms
    ]
    this_run_unmatched_ids = {s["id"] for s in result.unmatched_statement} & {s["id"] for s in this_run_statement_rows}
    total_statement_this_run = len(this_run_statement_rows)
    unmatched_statement_this_run = len(this_run_unmatched_ids)
    miss_rate = (unmatched_statement_this_run / total_statement_this_run) if total_statement_this_run else 0.0

    db.insert(
        "ingest_state",
        {"stream": "reconcile", "watermark": run_started_ms, "updated_at": datetime.now(timezone.utc).isoformat()},
        on_conflict="stream",
    )

    print(
        f"reconcile: matched={matched} unmatched_statement_total={len(result.unmatched_statement)} "
        f"unmatched_statement_this_run={unmatched_statement_this_run}/{total_statement_this_run} "
        f"reversed_stale_provisional={reversed_count} miss_rate={miss_rate:.1%}"
    )

    if total_statement_this_run > 0 and miss_rate > MISS_RATE_ALERT_THRESHOLD:
        # A high miss rate is a data-quality signal (alert thresholds not
        # low enough, §13 item 1) — not evidence the system itself is
        # down — so /log rather than /fail. This is JOB-3's most
        # important health metric (§7); it must keep reaching the
        # operator now that Telegram is gone (docs/cardledger-build-
        # spec.md §10 AMENDMENT).
        escalate_log(
            f"reconcile miss rate {miss_rate:.1%}: {unmatched_statement_this_run}/{total_statement_this_run} "
            "statement transactions from this run had no matching alert. Alert thresholds probably need "
            "lowering further — see docs/cardledger-build-spec.md §13 item 1."
        )

    return 0


def run() -> int:
    """Runs reconcile, translating a hard failure into a healthchecks.io
    `/fail` ping (an immediate alert email) before the failure propagates,
    rather than letting it disappear the way the old `send_telegram()`'s
    silent no-op on unset env vars did (docs/SETUP_STATUS.md "known loose
    ends"). The exception is re-raised so it still fails the GitHub Actions
    run loudly — the ping supplements that, it does not replace it.
    """
    try:
        return main()
    except Exception as exc:  # noqa: BLE001 - deliberately broad: this is the last line of defence
        print(f"CRITICAL: reconcile run failed: {exc}", file=sys.stderr)
        escalate_fail(f"reconcile run crashed: {exc}")
        raise


if __name__ == "__main__":
    raise SystemExit(run())
