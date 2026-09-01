#!/usr/bin/env python3
"""Historical statement backfill loader.

Loads pre-extracted, human-verified statement JSON (see the `--extracted-dir`
default below) directly into `transactions` as `status='confirmed'`,
`source='statement'`. This is a one-time bulk import, not a recurring job —
unlike scripts/ingest_statements.py (JOB-2), there is no Gmail fetch, no PDF
decryption, and no watermark: the extraction already happened and was
verified by hand (see docs handoff for this task).

Reuses scripts/lib/merchant.py, scripts/lib/period.py (unmodified — see
docs/architecture.md §3: two period models, stored separately,
never collapsed), scripts/lib/validate.py, and scripts/lib/supabase_rest.py.
The content-hash source_ref scheme is the same one scripts/ingest_statements.py
uses (see `content_hash` below) — not a second idempotency mechanism.

--dry-run is the default. Nothing is written to the database unless --commit
is passed explicitly.

============ Sign convention (read before touching the numbers) ============

The extractors used POSITIVE amounts for spend and NEGATIVE amounts for
payments, credits and refunds. The database's `transactions.amount > 0`
check forbids storing that sign directly, so every row here is normalised
to a positive amount, and the sign is preserved as *meaning* rather than as
*arithmetic*:

  - A positive-in-source row (a purchase) is inserted as spend:
    amount = the source amount, is_transfer computed per-card (see below).
  - A negative-in-source row that is a MERCHANT REFUND of a purchase found
    elsewhere in the SAME statement (identical amount, overlapping merchant
    name — see `find_refund_pairs`) is handled by KEEPING the original
    purchase row (status = 'reversed' instead of 'confirmed') and SKIPPING
    only the credit row. txn_status already has 'reversed' in its enum
    (0001_schema.sql) for exactly this case. Dropping both rows (the
    earlier approach) got the arithmetic right but destroyed the audit
    trail for a real transaction — the exact thing docs/architecture.md
    §1 calls the statement layer out as existing to preserve ("Statements
    are the audit trail, used to confirm and correct what the alerts
    already recorded, not to originate the data").
    Keeping the purchase as 'reversed' preserves that trail while still
    contributing $0 to spend, PROVIDED every spend-total consumer excludes
    status = 'reversed' — verified true for supabase/functions/nudge/
    index.ts (already filters `.neq("status", "reversed")` on both of its
    queries) and, after supabase/migrations/0006_spend_transactions_
    exclude_reversed.sql, true for the spend_transactions view too (it
    did not exclude 'reversed' before that migration — see that file's
    comment for the audit).
    Example: an HSBC statement export with "Riverside Home Store" +214.75
    (kept, status='reversed') and a matching -214.75 credit line a few days
    later (skipped) — the same class of scenario the old, pre-split build
    spec's §4 worked through with a specific confirmed sample; that
    specific sample was not carried over into docs/architecture.md or
    docs/reference-example-sg.md, so there is no current citation for it.
    See the dry-run report for the count.
  - Every OTHER negative-in-source row — credit-card bill payments
    ("PAYMT THRU E-BANK...", "PAYMENT VIA ... VISA DIRECT", "BILL PAYMENT -
    DBS..."), cashback/rebate credits ("ONE CARD ADDITIONAL REBATE", "UOB
    ONE CASH REBATE BILL REDEMPTION"), fee waivers ("CR CARD MEMBERSHIP
    FEE..."), and PayLah's "TOP UP WALLET FROM MY ACCOUNT" — is money
    moving, not a refund of anything found in this dataset. These are
    inserted (not dropped) at abs(amount) with is_transfer = true, so the
    ledger keeps a complete historical record but the row is excluded from
    every spend/budget total exactly the way transactions.is_transfer's own
    column comment defines it: "P2P / top-up, exclude from spend totals."
    Storing them (rather than silently omitting them, option B in the task
    brief) keeps one uniform rule instead of a special case for cards vs
    PayLah, and matches how PayLah top-ups are explicitly required to be
    handled (docs/reference-example-sg.md's "DBS PayLah!" section:
    "flagged is_transfer = true", not omitted).

This is a deliberate choice among the options the task brief allows
("storing them as positive with a distinguishing flag, or excluding
non-spend rows") — refunds are handled by the only method that keeps the
total *exactly* right (cancel both sides); everything else uses the flag,
because the flag already exists, is already load-bearing throughout the
system (nudge/index.ts, spend_transactions), and keeps a full audit trail
that a plain omission would throw away.

============ PayLah transfer classification ============

Per docs/reference-example-sg.md's "DBS PayLah!" section: PayLah nets to
exactly 0.00 per statement because every payment is paired with a
same-amount "TOP UP WALLET FROM MY ACCOUNT". Counting both sides as spend
double-counts; counting neither
zeroes out genuine spend. `classify_paylah_payment_side` implements:

  - "TOP UP WALLET FROM MY ACCOUNT" (always negative in source) -> transfer,
    always. Handled by the generic negative-row path above, not this
    function — it is unconditional, no ambiguity.
  - "SEND MONEY TO <name/phone>" and "PAYNOW TO <name> <phone>" -> transfer.
    Explicit P2P send phrasing from the app.
  - "PAYNOW <name>... PAYNOW TRANSFER" (the literal type label the app
    appends to a personal PayNow-mobile transfer) -> transfer.
  - "PAYNOW <name>...<reference code>" where the trailing token is a
    merchant-QR reference rather than the literal "PAYNOW TRANSFER" label,
    and the name contains a business marker ("PTE", "FOMO PAY", "QASHIER" —
    the last two are UEN-only merchant payment processors, never used for
    P2P) -> confident business spend.
  - Any other "PAYNOW <name>...<reference code>" -> spend (the default,
    since an unflagged guess that later turns out to be a transfer is
    visible and correctable via JOB-5 triage; a wrongly-excluded transfer
    would silently understate the budget with no signal). Left
    `confidence='guessed'` — as every auto-created merchant already is —
    and reported separately as "ambiguous" so a human knows to check it via
    the "transfer, not spend" triage button (§7 JOB-5).
  - A bare merchant name with no PAYNOW/SEND MONEY prefix (Scan & Pay QR to
    a stall or shop) -> confident business spend.
"""
from __future__ import annotations

import argparse
import glob
import hashlib
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from lib.merchant import find_merchant, normalize_merchant  # noqa: E402
from lib.period import calendar_month, resolve_period_key  # noqa: E402
from lib.supabase_rest import SupabaseREST  # noqa: E402
from lib.validate import validate_statement_row  # noqa: E402

DEFAULT_EXTRACTED_DIR = "./data/extracted"

VALID_CATEGORIES = frozenset(
    {
        "groceries", "dining", "petrol", "commute", "transport", "bills",
        "online", "retail", "healthcare", "household", "other",
    }
)

# ============ merchant category guess ============
# Best-effort keyword heuristic, checked in order (first match wins) against
# the UPPERCASED raw merchant string. §6: "Category accuracy will be roughly
# 90% until the merchant table matures" — this is that first pass, not a
# claim of precision. Never used to decide is_transfer; that is computed
# separately and always wins for merchants created as a transfer (see
# `guess_category` below, which forces 'other' in that case).
CATEGORY_KEYWORD_RULES: list[tuple[str, tuple[str, ...]]] = [
    ("petrol", ("SHELL", "ESSO", "CALTEX", "SPC ")),
    ("commute", ("GRAB", "UBER", "COMFORT/CITYCAB", "GOJEK", "TADA", "RYDE", "PARKING.SG", "NYCT", "HIGH SPEED RAIL", "TAXI")),
    ("transport", ("BUS/MRT", "SIMPLYGO", "NETS FLASHPAY", "TRANSITLINK")),
    ("groceries", ("NTUC", "FAIRPRICE", "COLD STORAGE", "SHENG SIONG", "GIANT ", "PRIME SUPERMARKET", "SUPERMARKET")),
    ("dining", (
        "MCDONALD", "KFC", "BURGERKING", "BURGER KING", "STARBUCKS", "DUNKIN", "WINGSTOP",
        "HAAGEN-DAZS", "YA KUN", "RESTAURANT", "CAFE", "TST*", "SQ *", "FOOD PANDA", "FOODPANDA",
        "PIZZA", "DOMINOS", "DOMINO'S", "LUCKIN", "COFFEE", "BAKERY", "DONUT", "TOAST", "BENTO",
        "SUSHI", "KITCHEN", "ROTI", "HALAL", "ICE CREAM", "COOKIE", "CHEESE TAR", "WOK HEY",
        "HOKKAIDO", "TONGUE TIP", "KOUFU", "HAWKER", "SUPPER", "JUICE", "TEA HOUSE", "GRB*",
        "FJ CSQ", "DAPUR", "MAKAN", "NASI", "TIAM", "CHICKEN", "KOPI", "FOODPARK", "MIRANA",
        "DELIG", "KEJORA", "SUGAR", "SEAFOOD",
    )),
    ("bills", (
        "SP DIGITAL", "SINGTEL", "STARHUB", "GOMO", "ANNUAL FEE", "FINANCE CHARGE",
        "LATE CHARGE", "GST @", "CASH ADVANCE", "INTERESTS", "MEMBERSHIP FEE", "BILL PAYMENT",
    )),
    ("healthcare", ("PHARMACY", "CVS/PHARMACY", "DENTIST", "HOSPITAL", "CLINIC", "WATSON", "GUARDIAN", "FITNESS")),
    ("household", ("IKEA", "KIDDY PALACE", "HARDWARE")),
    ("retail", (
        "UNIQLO", "H&M ", "NIKE", "GAP ", "TARGET", "T.J. MAXX", "SEPHORA", "TOMMY HILFIGER",
        "CALVIN KLEIN", "MINISO", "PRIMARK", "GADGET MIX", "AMERICAN EAGLE", "SHIN KONG",
        "TAKASHIMAYA", "SP FLORAL",
    )),
    ("online", ("SHOPEE", "LAZADA", "AMAZON", "TIKTOK", "KLOOK", "TRIP.COM", "ANTHROPIC", "CLAUDE.AI", "EXPRESSVPN", "WWW.")),
]


def guess_category(normalized: str, *, is_transfer: bool) -> str:
    """Best-effort category for a newly-created merchant.

    A merchant created because a transaction was classified as a transfer
    (PayLah P2P/top-up, a card payment, a rebate credit) is forced to
    'other' rather than whatever keyword happens to match — none of the 11
    spend categories describe "paying your own card bill", and is_transfer
    already excludes it from every spend total regardless of category, so
    a spend-shaped category here would only mislead a future merchant
    browser view.
    """
    if is_transfer:
        return "other"
    upper = normalized.upper()
    for category, keywords in CATEGORY_KEYWORD_RULES:
        if any(kw in upper for kw in keywords):
            return category
    return "other"


# ============ refund netting ============
# §4 sign-convention decision (see module docstring). Only meaningful within
# a single statement: a refund and the purchase it reverses are always in
# the same or an adjacent billing cycle's export, and this dataset gives us
# one statement (one JSON file) at a time.
_REFUND_STOPWORDS = frozenset({"SINGAPORE", "SG", "PTE", "LTD", "LT", "D", "N", "A", "CO", "INC", "GMBH", "LLC"})


def _significant_tokens(raw: str) -> set[str]:
    normalized = normalize_merchant(raw)
    return {tok for tok in normalized.split() if tok not in _REFUND_STOPWORDS and len(tok) > 1}


def find_refund_pairs(txns: list[dict]) -> tuple[set[int], set[int], list[tuple[dict, dict]]]:
    """Find (purchase, refund) pairs within one statement's transaction
    list. Returns (credit_excluded, purchase_reversed, pairs):

      - `credit_excluded`: indices of the NEGATIVE (credit/refund) row in
        each pair — these are skipped entirely, never inserted. The refund
        itself carries no independent audit value once its purchase is
        marked reversed; inserting it too would double-subtract.
      - `purchase_reversed`: indices of the POSITIVE (purchase) row in
        each pair — these ARE inserted, but with status='reversed' instead
        of 'confirmed' (set by the caller), so the audit trail for the
        original transaction survives while it is excluded from spend
        totals via status rather than via omission.

    A negative-in-source row is treated as a refund of a positive row in
    the same list when the amounts match to the cent and the two merchant
    strings' significant-token sets overlap (one is a subset of the
    other) — a plain substring test misses this dataset's real example
    ("TikTok Shop Seller Singapore SG" vs "TikTok Shop Singapore SG": the
    second string is not a contiguous substring of the first because
    "Seller" sits in between). Requiring an exact amount match keeps this
    safe even with the looser token check: two unrelated transactions
    sharing a token AND an exact-to-the-cent amount is not a realistic
    coincidence at this data volume (validated against all four statement
    sources: exactly one candidate pair found, and it is the real refund).
    """
    pairs: list[tuple[dict, dict]] = []
    credit_excluded: set[int] = set()
    purchase_reversed: set[int] = set()
    used_positive: set[int] = set()
    positive_indices = [i for i, t in enumerate(txns) if t["amount"] > 0]

    for ni, neg in enumerate(txns):
        if neg["amount"] >= 0:
            continue
        neg_sig = _significant_tokens(neg["merchant_raw"])
        if not neg_sig:
            continue
        neg_amount = abs(neg["amount"])
        for pi in positive_indices:
            if pi in used_positive:
                continue
            pos = txns[pi]
            if abs(pos["amount"] - neg_amount) > 0.01:
                continue
            pos_sig = _significant_tokens(pos["merchant_raw"])
            if not pos_sig:
                continue
            if neg_sig <= pos_sig or pos_sig <= neg_sig:
                used_positive.add(pi)
                purchase_reversed.add(pi)
                credit_excluded.add(ni)
                pairs.append((pos, neg))
                break
    return credit_excluded, purchase_reversed, pairs


# ============ PayLah transfer classification ============
def is_paylah_topup(merchant_raw: str) -> bool:
    return merchant_raw.strip().upper() == "TOP UP WALLET FROM MY ACCOUNT"


def classify_paylah_payment_side(merchant_raw: str) -> tuple[bool, str]:
    """Classify a POSITIVE-amount PayLah line (the payment/debit side).

    Returns (is_transfer, reason). ``reason`` is reported in the dry-run
    summary; "ambiguous_paynow_reference" is the bucket that must be left
    for JOB-5 triage rather than guessed permanently.
    """
    upper = merchant_raw.strip().upper()
    if upper.startswith("SEND MONEY TO "):
        return True, "p2p_send_money"
    if upper.startswith("PAYNOW TO "):
        return True, "p2p_paynow_to"
    if upper.startswith("PAYNOW ") and upper.endswith("PAYNOW TRANSFER"):
        return True, "p2p_paynow_transfer_label"
    if upper.startswith("PAYNOW "):
        if "PTE" in upper or "FOMO PAY" in upper or "QASHIER" in upper:
            return False, "business_paynow_confident"
        return False, "ambiguous_paynow_reference"
    return False, "scan_and_pay_merchant"


# ============ idempotent source_ref (same scheme as ingest_statements.py) ============
def content_hash(txn_date: str, amount: float, normalized_merchant: str) -> str:
    payload = f"{txn_date}|{amount:.2f}|{normalized_merchant}".encode("utf-8")
    return hashlib.sha256(payload).hexdigest()[:16]


def build_display_name(merchant_raw: str) -> str:
    return " ".join(merchant_raw.split())[:120]


def load_statement_files(extracted_dir: str) -> list[Path]:
    return sorted(Path(p) for p in glob.glob(f"{extracted_dir}/*.json"))


def process_file(
    path: Path,
    *,
    method_by_last4: dict[str, dict],
    merchants: list[dict],
    match_pattern_index: dict[str, dict],
    seen_source_refs: dict[str, set[str]],
    stats: dict,
) -> list[dict]:
    """Return the transaction rows this file would insert (or did insert,
    under --commit — the caller decides). Mutates `merchants`,
    `match_pattern_index`, `seen_source_refs` and `stats` in place so
    later files in the run see merchants/dedup state created by earlier
    ones.
    """
    data = json.loads(path.read_text())
    last4 = data.get("last4")
    method = method_by_last4.get(last4)
    if method is None:
        stats["unroutable_files"].append((path.name, last4))
        print(
            f"ERROR: no payment_methods row for last4={last4!r} "
            f"(file {path.name}, issuer={data.get('issuer')!r}) — skipping this "
            "entire file, not guessing. Add the payment_methods row first.",
            file=sys.stderr,
        )
        return []
    if not method.get("active", True) and method.get("id") not in _KNOWN_INACTIVE_OK:
        # Inactive methods are allowed here only for cards this task
        # explicitly backfills historically (dbs_posb_platinum). Any other
        # inactive method_id is far more likely a staged-not-yet-issued
        # card (e.g. citi_cashback) than a real historical source — refuse
        # rather than silently attributing statement data to it.
        stats["unroutable_files"].append((path.name, last4))
        print(
            f"ERROR: payment_methods '{method['id']}' is inactive and not in the "
            f"known-historical allowlist (file {path.name}) — skipping, not guessing.",
            file=sys.stderr,
        )
        return []

    method_id = method["id"]
    txns = data.get("transactions", [])

    credit_excluded: set[int] = set()
    purchase_reversed: set[int] = set()
    if method_id != "paylah":
        credit_excluded, purchase_reversed, pairs = find_refund_pairs(txns)
        for pos, neg in pairs:
            stats["refund_pairs"].append((path.name, pos, neg))

    hash_seen: Counter[str] = Counter()  # reset per statement, per ingest_statements.py convention
    rows: list[dict] = []

    for idx, t in enumerate(txns):
        if idx in credit_excluded:
            continue

        raw_amount = t.get("amount")
        if not isinstance(raw_amount, (int, float)) or isinstance(raw_amount, bool):
            stats["rejected"].append((path.name, t, "non_numeric_amount"))
            continue

        merchant_raw = t.get("merchant_raw", "")
        transfer_reason: str | None = None

        if raw_amount > 0:
            amount = float(raw_amount)
            is_transfer = False
            if method_id == "paylah":
                is_transfer, transfer_reason = classify_paylah_payment_side(merchant_raw)
                if transfer_reason == "ambiguous_paynow_reference":
                    stats["ambiguous"].append((path.name, merchant_raw, t["txn_date"], amount))
        else:
            amount = abs(float(raw_amount))
            is_transfer = True
            transfer_reason = "topup" if (method_id == "paylah" and is_paylah_topup(merchant_raw)) else "non_spend_credit"

        candidate = {**t, "amount": amount}
        reason = validate_statement_row(candidate)
        if reason is not None:
            stats["rejected"].append((path.name, t, reason))
            continue

        normalized = normalize_merchant(merchant_raw)
        merchant = find_merchant(merchants, normalized) if normalized else None
        merchant_id: int | str | None = None
        category: str | None = None

        if merchant is not None:
            merchant_id = merchant["id"]
            category = merchant["category"]
            is_transfer = is_transfer or bool(merchant.get("is_transfer"))
        elif len(normalized) < 3:
            stats["short_pattern_skipped"] += 1
            category = guess_category(normalized, is_transfer=is_transfer) if normalized else "other"
        else:
            category = guess_category(normalized, is_transfer=is_transfer)
            new_merchant = {
                "id": None,  # filled in on --commit after the batch merchant insert
                "match_pattern": normalized,
                "display_name": build_display_name(merchant_raw),
                "category": category,
                "known_mcc": None,
                "hsbc_eligible": None,
                "is_transfer": is_transfer,
                "confidence": "guessed",
            }
            merchants.append(new_merchant)
            match_pattern_index[normalized] = new_merchant
            stats["merchants_created"].append(new_merchant)

        period_key = resolve_period_key(method_id, method["period_type"], method["cycle_day"], t["txn_date"])
        cal_month = calendar_month(t["txn_date"])

        h = content_hash(t["txn_date"], amount, normalized)
        occurrence = hash_seen[h]
        hash_seen[h] += 1
        source_ref = h if occurrence == 0 else f"{h}:{occurrence}"

        if source_ref in seen_source_refs[method_id]:
            # Same (date, amount, normalised merchant) already produced this
            # exact source_ref earlier in this run — either a re-read of the
            # same file, or (the real case this guards) the same underlying
            # transaction present in two of the DBS/POSB 4444 exports whose
            # periods overlap. Either way it is the same row: the unique
            # (method_id, source, source_ref) constraint would upsert it to
            # a no-op, so count it as deduplicated and do not add it to
            # totals twice.
            stats["cross_file_deduped"] += 1
            continue
        seen_source_refs[method_id].add(source_ref)

        row = {
            "method_id": method_id,
            "txn_date": t["txn_date"],
            "posted_date": t.get("posted_date"),
            "merchant_raw": merchant_raw,
            "merchant_id": merchant_id,
            "amount": round(amount, 2),
            "currency": t.get("currency") or "SGD",
            "fx_amount": t.get("fx_amount"),
            "category": category,
            "is_transfer": is_transfer,
            "status": "reversed" if idx in purchase_reversed else "confirmed",
            "source": "statement",
            "source_ref": source_ref,
            "period_key": period_key,
            "calendar_month": cal_month,
            "_transfer_reason": transfer_reason,  # stripped before insert; used for reporting only
        }
        rows.append(row)

    return rows


# dbs_posb_platinum is deliberately inactive (retired) but is the entire
# point of this backfill; see supabase/migrations/0004_retired_cards.sql.
_KNOWN_INACTIVE_OK = {"dbs_posb_platinum"}


def _project_ref(rest_base_url: str) -> str:
    """Best-effort project ref for the commit-report header, e.g.
    'abcdefghijklmnop' out of 'https://abcdefghijklmnop.supabase.co/rest/v1'.
    Falls back to the full URL if the shape is unexpected — this is a
    human-facing label, not something anything downstream parses.
    """
    host = rest_base_url.split("//", 1)[-1].split("/", 1)[0]
    return host.split(".supabase.co")[0] if ".supabase.co" in host else rest_base_url


def print_report(rows: list[dict], stats: dict, *, commit: bool, project_ref: str | None = None) -> None:
    by_method_month: dict[tuple[str, str], float] = defaultdict(float)
    by_method_total: dict[str, float] = defaultdict(float)
    by_method_transfer_total: dict[str, float] = defaultdict(float)
    by_calendar_month: dict[str, float] = defaultdict(float)
    reversed_rows = [row for row in rows if row["status"] == "reversed"]

    for row in rows:
        if row["status"] == "reversed":
            # Kept for audit trail (see module docstring, REFUND HANDLING)
            # but excluded from every total below — matches
            # supabase/functions/nudge/index.ts's `.neq("status",
            # "reversed")` and supabase/migrations/0006_spend_transactions_
            # exclude_reversed.sql. Reported separately below instead.
            continue
        key_mm = (row["method_id"], row["calendar_month"])
        if row["is_transfer"]:
            by_method_transfer_total[row["method_id"]] += row["amount"]
        else:
            by_method_month[key_mm] += row["amount"]
            by_method_total[row["method_id"]] += row["amount"]
            by_calendar_month[row["calendar_month"]] += row["amount"]

    print("\n" + "=" * 72)
    if commit:
        # Unmissable and past-tense: this run wrote to the database. Earlier
        # wording ("would be inserted") was identical for --commit and
        # dry-run, which read as "nothing happened" even after a successful
        # write and invited an unnecessary (if harmless) re-run.
        print(f"BACKFILL COMMITTED — ROWS WERE WRITTEN to {project_ref or 'the configured Supabase project'}")
    else:
        print("BACKFILL DRY RUN — NOTHING WAS WRITTEN (pass --commit to write)")
    print("=" * 72)

    print("\n-- Per-method spend total (excludes is_transfer rows) --")
    for method_id in sorted(by_method_total):
        print(f"  {method_id:20s} S${by_method_total[method_id]:>12,.2f}")

    print("\n-- Per-method, per-calendar-month spend --")
    for method_id, month in sorted(by_method_month):
        print(f"  {method_id:20s} {month}  S${by_method_month[(method_id, month)]:>12,.2f}")

    print("\n-- Per-calendar-month total spend (all methods combined) --")
    for month in sorted(by_calendar_month):
        print(f"  {month}  S${by_calendar_month[month]:>12,.2f}")

    if "paylah" in by_method_total or "paylah" in by_method_transfer_total:
        spend = by_method_total.get("paylah", 0.0)
        transfer = by_method_transfer_total.get("paylah", 0.0)
        print("\n-- PayLah transfer vs spend split --")
        print(f"  spend (is_transfer=false):    S${spend:>12,.2f}")
        print(f"  transfer (is_transfer=true):  S${transfer:>12,.2f}")
        print(f"  total (should ~net to 0 with the source PDF's own totals): S${spend + transfer:>12,.2f}")

    if commit:
        print(f"\n-- Rows: {len(rows)} WERE INSERTED --")
    else:
        print(f"\n-- Rows: {len(rows)} would be inserted --")
    print(f"   of which status='reversed' (kept for audit trail, excluded from every total above): {len(reversed_rows)}")
    print(f"   short-match-pattern merchant skips (row still inserted, merchant_id null): {stats['short_pattern_skipped']}")
    print(f"   cross-file / re-run duplicates collapsed via source_ref: {stats['cross_file_deduped']}")
    print(f"   rows rejected by validate_statement_row: {len(stats['rejected'])}")
    for fname, t, reason in stats["rejected"][:20]:
        print(f"     {fname}: {reason} — {t!r}")

    print(f"\n-- Refund pairs found (purchase kept as status='reversed', credit row skipped): {len(stats['refund_pairs'])} --")
    for fname, pos, neg in stats["refund_pairs"]:
        print(f"   {fname}: {pos['txn_date']} +{pos['amount']:.2f} {pos['merchant_raw']!r} -> kept, status=reversed  <->  {neg['txn_date']} {neg['amount']:.2f} {neg['merchant_raw']!r} -> skipped")

    merchants_verb = "were auto-created" if commit else "would be auto-created"
    print(f"\n-- Merchants that {merchants_verb}: {len(stats['merchants_created'])} --")
    reason_counts = Counter()
    for m in stats["merchants_created"]:
        reason_counts["transfer" if m["is_transfer"] else "spend"] += 1
    print(f"   spend-classified: {reason_counts['spend']}   transfer-classified: {reason_counts['transfer']}")

    print(f"\n-- PayLah ambiguous PayNow classifications left for JOB-5 triage: {len(stats['ambiguous'])} --")
    for fname, merchant_raw, txn_date, amount in stats["ambiguous"]:
        print(f"   {fname}: {txn_date} S${amount:.2f} {merchant_raw!r}")

    if stats["unroutable_files"]:
        print(f"\n-- UNROUTABLE FILES (no active payment_methods row for that last4): {len(stats['unroutable_files'])} --")
        for fname, last4 in stats["unroutable_files"]:
            print(f"   {fname}: last4={last4}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--extracted-dir", default=DEFAULT_EXTRACTED_DIR)
    parser.add_argument("--commit", action="store_true", help="Actually write to the database. Default is dry-run.")
    args = parser.parse_args()

    db = SupabaseREST()
    methods = db.select("payment_methods", {"select": "id,last4,period_type,cycle_day,active,has_rules"})
    method_by_last4 = {m["last4"]: m for m in methods if m.get("last4")}

    merchants = db.select(
        "merchants",
        {"select": "id,match_pattern,display_name,category,is_transfer,confidence"},
    )
    match_pattern_index = {m["match_pattern"]: m for m in merchants}

    files = load_statement_files(args.extracted_dir)
    if not files:
        print(f"No .json files found under {args.extracted_dir}", file=sys.stderr)
        return 1

    stats = {
        "unroutable_files": [],
        "rejected": [],
        "refund_pairs": [],
        "merchants_created": [],
        "ambiguous": [],
        "short_pattern_skipped": 0,
        "cross_file_deduped": 0,
    }
    seen_source_refs: dict[str, set[str]] = defaultdict(set)
    all_rows: list[dict] = []

    for path in files:
        rows = process_file(
            path,
            method_by_last4=method_by_last4,
            merchants=merchants,
            match_pattern_index=match_pattern_index,
            seen_source_refs=seen_source_refs,
            stats=stats,
        )
        all_rows.extend(rows)

    if args.commit:
        # Two-phase: create merchants first (so transactions can carry a
        # real merchant_id), then insert transactions.
        new_merchants = [m for m in stats["merchants_created"]]
        if new_merchants:
            payload = [
                {k: v for k, v in m.items() if k != "id"} for m in new_merchants
            ]
            inserted_merchants = db.insert("merchants", payload, on_conflict="match_pattern")
            by_pattern = {m["match_pattern"]: m for m in inserted_merchants}
            for m in new_merchants:
                real = by_pattern.get(m["match_pattern"])
                if real:
                    m["id"] = real["id"]

        for row in all_rows:
            row.pop("_transfer_reason", None)
            if row["merchant_id"] is None and row["merchant_raw"]:
                normalized = normalize_merchant(row["merchant_raw"])
                m = match_pattern_index.get(normalized)
                if m and m.get("id") is not None:
                    row["merchant_id"] = m["id"]
            db.insert("transactions", row, on_conflict="method_id,source,source_ref")

        print(f"COMMIT complete: {len(all_rows)} transactions inserted/upserted, {len(new_merchants)} merchants created.")
    else:
        print("DRY RUN — no writes performed. Pass --commit to write.")

    print_report(all_rows, stats, commit=args.commit, project_ref=_project_ref(db.base))

    return 1 if stats["unroutable_files"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
