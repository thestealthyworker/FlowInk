#!/usr/bin/env python3
"""JOB-2 · ingest-statements. GitHub Actions, daily 09:00 SGT.

See docs/cardledger-build-spec.md §7 and §2 ("why two runtimes"): this is
the one job that needs to shell out to `qpdf` to decrypt a password
protected statement PDF, which Supabase Edge Functions (Deno, no native
binaries) cannot do.

Decrypted PDF bytes never leave this process's temp directory, and the
runner is destroyed on completion (§11) — nothing here writes outside
`tempfile.mkdtemp()`, and that directory is removed explicitly in
`finally` as defence in depth on top of that.

STATEMENT_GMAIL_QUERY is not fixed in the build spec (§13 item 5 is still
open: "confirm whether statement emails carry a PDF attachment or just a
login link"). The default below is a reasonable starting point; tune it
once real statement emails are seen, without touching code.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from lib import senders  # noqa: E402
from lib.gmail_client import (  # noqa: E402
    download_attachment,
    find_pdf_attachments,
    get_access_token,
    get_message,
    list_message_ids,
)
from lib.merchant import find_merchant, normalize_merchant  # noqa: E402
from lib.period import calendar_month, resolve_period_key  # noqa: E402
from lib.supabase_rest import SupabaseREST  # noqa: E402
from lib.validate import validate_statement_row  # noqa: E402

import requests  # noqa: E402

DEFAULT_QUERY_TEMPLATE = 'has:attachment filename:pdf {sender_filter} subject:(statement)'

STATEMENT_SYSTEM_PROMPT = """You extract transaction line items from a Singapore credit card
statement's raw text.

Return ONLY a JSON array of objects, no markdown fences, no preamble:
[
  {"txn_date": "YYYY-MM-DD", "posted_date": "YYYY-MM-DD" | null,
   "merchant_raw": string, "amount": number, "currency": string,
   "fx_amount": number | null}
]

Rules:
- One object per transaction line. Skip subtotals, interest, fee summaries,
  and the running balance.
- amount is the SGD-billed amount (after any FX conversion), as a positive
  number for spend, exactly as printed.
- fx_amount is the original foreign-currency amount if the line shows one,
  else null.
- Never invent a value that is not present in the text. Use null.
- If you cannot confidently extract a field, omit that transaction
  entirely rather than guess.
"""

ANTHROPIC_MAX_RETRIES = 2  # §8: "Retry twice with exponential backoff on API errors (429, 5xx)."
ANTHROPIC_BACKOFF_BASE_SECONDS = 2

_SAFE_LOG_RE = re.compile(r"[^A-Za-z0-9._-]")


class UnencryptedStatementError(Exception):
    """A statement PDF that qpdf reports as unencrypted.

    §11 defence: the PDF password authenticates the issuer as the sender
    of the *encrypted* bytes. An unencrypted PDF proves nothing — a
    plain, well-formed PDF from anyone would previously decrypt "clean"
    against ANY candidate password because qpdf ignores --password on an
    unencrypted input and exits 0. Rows derived from it must never reach
    status='confirmed'.
    """


class AnthropicAPIError(Exception):
    """The Anthropic call failed after retries, or returned unusable output."""


def sanitize_for_log(value: str, *, max_len: int = 120) -> str:
    """Strip anything outside [A-Za-z0-9._-] before a value reaches a
    persistent log. Actions logs are retained and readable by anyone with
    repo access (§11); an attachment filename is attacker-controlled input
    (it rides in on the same email as everything else) and must never be
    printed verbatim.
    """
    if not isinstance(value, str):
        value = str(value)
    return _SAFE_LOG_RE.sub("_", value)[:max_len]


def call_anthropic(statement_text: str, *, max_retries: int = ANTHROPIC_MAX_RETRIES) -> list[dict]:
    api_key = os.environ["ANTHROPIC_API_KEY"]
    last_error: str = "unknown error"

    for attempt in range(max_retries + 1):
        try:
            res = requests.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "content-type": "application/json",
                    "x-api-key": api_key,
                    "anthropic-version": "2023-06-01",
                },
                json={
                    "model": "claude-haiku-4-5-20251001",
                    "max_tokens": 4096,
                    "temperature": 0,
                    "system": STATEMENT_SYSTEM_PROMPT,
                    "messages": [{"role": "user", "content": statement_text[:100_000]}],
                },
                timeout=120,
            )
        except requests.RequestException as exc:
            last_error = f"request error: {exc}"
            if attempt < max_retries:
                time.sleep(ANTHROPIC_BACKOFF_BASE_SECONDS**attempt)
                continue
            raise AnthropicAPIError(last_error) from exc

        if res.status_code == 429 or res.status_code >= 500:
            last_error = f"HTTP {res.status_code}"
            if attempt < max_retries:
                time.sleep(ANTHROPIC_BACKOFF_BASE_SECONDS**attempt)
                continue
            raise AnthropicAPIError(f"{last_error} after {attempt + 1} attempts")

        # Any other non-2xx (e.g. 400 bad request) is not retryable — the
        # same input yields the same output (§8).
        res.raise_for_status()

        text = res.json()["content"][0]["text"]
        try:
            return json.loads(text.strip())
        except json.JSONDecodeError as exc:
            raise AnthropicAPIError(f"non-JSON response: {exc}") from exc

    raise AnthropicAPIError(last_error)


def is_encrypted_pdf(path: Path) -> bool:
    """True if qpdf reports the file as encrypted.

    ``qpdf --is-encrypted`` exits 0 for an encrypted file and 2 for a
    valid, unencrypted one. Any other exit code means qpdf could not even
    parse the file, which is treated as "not provably encrypted" — fail
    closed rather than assume.
    """
    result = subprocess.run(["qpdf", "--is-encrypted", str(path)], capture_output=True)
    if result.returncode == 0:
        return True
    if result.returncode == 2:
        return False
    raise RuntimeError(f"qpdf --is-encrypted exited {result.returncode}: could not determine encryption state")


def decrypt_pdf(encrypted_path: Path, out_path: Path, candidate_passwords: list[str]) -> bool:
    """Decrypt ``encrypted_path`` with the first matching password.

    Raises :class:`UnencryptedStatementError` if the input is not
    encrypted at all — see that class's docstring for why this must be a
    hard failure rather than a pass-through.
    """
    if not is_encrypted_pdf(encrypted_path):
        raise UnencryptedStatementError(f"{encrypted_path.name} is not an encrypted PDF")

    for password in candidate_passwords:
        result = subprocess.run(
            ["qpdf", "--password-file=-", "--decrypt", str(encrypted_path), str(out_path)],
            input=password.encode("utf-8"),
            capture_output=True,
        )
        if result.returncode == 0 and out_path.exists():
            return True
    return False


def extract_text(pdf_path: Path) -> str:
    result = subprocess.run(["pdftotext", "-layout", str(pdf_path), "-"], capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"pdftotext failed: {result.stderr}")
    return result.stdout


_LAST4_HINT_RE = re.compile(
    r"(?:ending(?:\s+in|\s+with)?|card\s*(?:no\.?|number)|\*{2,}|x{2,})\D{0,8}(\d{4})\b",
    re.IGNORECASE,
)


def extract_last4_hint(msg: dict, filename: str | None = None) -> str | None:
    """Best-effort last-4 hint from subject, snippet, or attachment filename.

    Statement text rarely states the card explicitly per line (§13 item
    5 is still open on the exact layout), but the subject/snippet or
    filename often does ("Statement for card ending 1111",
    "Statement_1111.pdf"). This is a cross-check, not a router by itself
    — the authoritative route is the sender domain
    (:func:`lib.senders.method_id_for_sender`); this only vetoes a domain
    match that disagrees with an explicit last-4 in the message.
    """
    headers = {h["name"].lower(): h["value"] for h in msg.get("payload", {}).get("headers", [])}
    candidates = [headers.get("subject", ""), msg.get("snippet", ""), filename or ""]
    for text in candidates:
        match = _LAST4_HINT_RE.search(text)
        if match:
            return match.group(1)
    return None


def infer_method_id(
    msg: dict,
    filename: str | None,
    method_by_last4: dict[str, dict],
    domain_map: dict[str, str] | None = None,
) -> str | None:
    """Route a statement message+attachment to a payment_methods.id.

    Two independent signals must agree, or the answer is "do not know":
    - the sender domain, via the exact allowlist in lib.senders (§4 trap
      3 — a substring test like ``"uobgroup.com" in sender`` would also
      match ``statements@uobgroup.com.attacker.io``)
    - an explicit last-4 hint, if one is present, cross-checked against
      ``method_by_last4`` (built by the caller, previously computed and
      never consulted)

    Returns ``None`` if the sender does not resolve, if a last-4 hint is
    present but names no active payment method, or if a present last-4
    hint disagrees with the sender-domain route. The caller must record a
    failure and skip — never guess (§4 trap 3, §8: "a wrong transaction is
    worse than a missing one").
    """
    headers = {h["name"].lower(): h["value"] for h in msg.get("payload", {}).get("headers", [])}
    sender_method_id = senders.method_id_for_sender(headers.get("from"), domain_map)
    if sender_method_id is None:
        return None

    last4 = extract_last4_hint(msg, filename)
    if last4 is None:
        return sender_method_id

    method_for_last4 = method_by_last4.get(last4)
    if method_for_last4 is None or not method_for_last4.get("active", False):
        return None
    if method_for_last4["id"] != sender_method_id:
        return None
    return sender_method_id


def content_hash(txn_date: str, amount: float, normalized_merchant: str) -> str:
    """Stable identity for a statement line, independent of its position
    in the model's output array.

    §11 item (source_ref): the previous source_ref was
    f"{msg_id}:{attachment_index}:{array_index}". A reprocessed statement
    whose extraction order shifts by one silently rebinds the same
    source_ref to a different transaction and overwrites a confirmed
    amount via the `on_conflict=(method_id,source,source_ref)` upsert,
    with no log. Hashing (date, amount, normalised merchant) instead is
    stable across reordering.
    """
    payload = f"{txn_date}|{amount:.2f}|{normalized_merchant}".encode("utf-8")
    return hashlib.sha256(payload).hexdigest()[:16]


def record_failure(db: SupabaseREST, source_ref: str, raw_body: str, model_output: str | None, reason: str) -> None:
    """Best-effort write to parse_failures. Never let a failure to record
    a failure crash the job — that would turn a recoverable per-message
    problem into a hard job failure.
    """
    try:
        db.insert(
            "parse_failures",
            {
                "source_ref": source_ref,
                "raw_body": raw_body or "(no statement text captured before failure)",
                "model_output": model_output,
                "reason": reason,
            },
            on_conflict="source_ref",
        )
    except requests.RequestException as exc:
        print(f"Could not record parse_failures row for {sanitize_for_log(source_ref)}: {exc}", file=sys.stderr)


def insert_transaction_logging_conflicts(db: SupabaseREST, row: dict) -> None:
    """Insert a statement transaction row, logging (not silently allowing)
    a conflicting overwrite of an existing confirmed row.

    lib/supabase_rest.py's insert() upserts with
    resolution=merge-duplicates on (method_id, source, source_ref) — by
    design, so a retried run is idempotent. But if a row with this
    source_ref already exists with a *different* amount or date, that is
    not a harmless retry, it is reprocessing changing history under a
    confirmed row. Log it loudly so it shows up in the run's output
    rather than vanishing into a silent UPDATE.
    """
    existing = db.select(
        "transactions",
        {
            "method_id": f"eq.{row['method_id']}",
            "source": "eq.statement",
            "source_ref": f"eq.{row['source_ref']}",
            "select": "amount,txn_date",
        },
    )
    if existing:
        prior = existing[0]
        if float(prior["amount"]) != float(row["amount"]) or prior.get("txn_date") != row.get("txn_date"):
            print(
                "WARNING: reprocessing is overwriting an existing confirmed statement row "
                f"(source_ref={sanitize_for_log(row['source_ref'])}): "
                f"amount {prior['amount']} -> {row['amount']}, "
                f"txn_date {prior.get('txn_date')} -> {row.get('txn_date')}",
                file=sys.stderr,
            )

    db.insert("transactions", row, on_conflict="method_id,source,source_ref")


def main() -> int:
    db = SupabaseREST()
    access_token = get_access_token()

    state = db.select("ingest_state", {"stream": "eq.statements", "select": "watermark"})
    watermark = state[0]["watermark"] if state else 0

    methods = db.select("payment_methods", {"select": "id,last4,period_type,cycle_day,active"})
    methods_by_id = {m["id"]: m for m in methods}
    method_by_last4 = {m["last4"]: m for m in methods if m.get("last4")}

    merchants = db.select(
        "merchants",
        {"select": "id,match_pattern,display_name,category,is_transfer,confidence"},
    )

    # WP2 (design/ingestion-routing.md): default source is now a live read
    # of payment_methods.statement_senders via this same `db` client,
    # instead of the hardcoded DEFAULT_STATEMENT_SENDER_DOMAINS constant —
    # the one place a user edits routing config, the same table
    # ingest-alerts/index.ts reads for the alert path. STATEMENT_SENDER_DOMAINS
    # still overrides it first, unchanged, as a local/CI escape hatch.
    domain_map = senders.statement_sender_domains(db=db)
    default_query = DEFAULT_QUERY_TEMPLATE.format(sender_filter=senders.gmail_sender_prefilter(domain_map))
    query = os.environ.get("STATEMENT_GMAIL_QUERY", default_query)
    after_seconds = max((watermark - 3 * 24 * 60 * 60 * 1000) // 1000, 0)
    ids = list_message_ids(access_token, f"{query} after:{after_seconds}", max_results=50)

    candidate_passwords = [p for p in os.environ.get("STATEMENT_PDF_PASSWORD", "").split(",") if p]
    if not candidate_passwords:
        print("STATEMENT_PDF_PASSWORD not set — cannot decrypt any statement PDFs", file=sys.stderr)
        return 1

    messages = []
    for mid in ids:
        msg = get_message(access_token, mid)
        if int(msg["internalDate"]) > watermark:
            messages.append(msg)
    messages.sort(key=lambda m: int(m["internalDate"]))

    tmp_dir = Path(tempfile.mkdtemp(prefix="cardledger-statements-"))
    last_good_watermark = watermark
    inserted = 0
    failed = 0

    try:
        for msg in messages:
            attachments = find_pdf_attachments(msg)
            if not attachments:
                last_good_watermark = int(msg["internalDate"])
                continue

            ok_this_message = True
            for i, att in enumerate(attachments):
                source_ref_prefix = f"{msg['id']}:{i}"
                safe_filename = sanitize_for_log(att.get("filename", ""))

                method_id = infer_method_id(msg, att.get("filename"), method_by_last4, domain_map)
                if method_id is None:
                    record_failure(db, source_ref_prefix, "", None, "unroutable_sender")
                    print(
                        f"Could not route sender for statement message {msg['id']} "
                        f"attachment {i} ({safe_filename}) — skipping, not guessing",
                        file=sys.stderr,
                    )
                    ok_this_message = False
                    break

                method = methods_by_id.get(method_id)
                if method is None or not method.get("active", False):
                    record_failure(db, source_ref_prefix, "", None, "inactive_or_unknown_method")
                    print(
                        f"Payment method {sanitize_for_log(method_id)} is inactive or unknown "
                        f"for statement message {msg['id']} — skipping",
                        file=sys.stderr,
                    )
                    ok_this_message = False
                    break

                enc_path = tmp_dir / f"{msg['id']}-{i}.enc.pdf"
                dec_path = tmp_dir / f"{msg['id']}-{i}.dec.pdf"
                try:
                    enc_path.write_bytes(download_attachment(access_token, msg["id"], att["attachmentId"]))

                    try:
                        decrypted_ok = decrypt_pdf(enc_path, dec_path, candidate_passwords)
                    except UnencryptedStatementError:
                        record_failure(db, source_ref_prefix, "", None, "unencrypted_pdf_rejected")
                        print(
                            f"REJECTED unencrypted PDF {safe_filename} in message {msg['id']} — "
                            "a statement PDF must be encrypted to be trusted as issuer-authenticated",
                            file=sys.stderr,
                        )
                        ok_this_message = False
                        break

                    if not decrypted_ok:
                        record_failure(db, source_ref_prefix, "", None, "decrypt_failed")
                        print(f"FAILED to decrypt {safe_filename} in message {msg['id']}", file=sys.stderr)
                        ok_this_message = False
                        break

                    text = extract_text(dec_path)

                    try:
                        rows = call_anthropic(text)
                    except AnthropicAPIError as exc:
                        record_failure(db, source_ref_prefix, text[:5000], None, f"anthropic_error:{exc}")
                        print(f"FAILED to parse statement in message {msg['id']}: {exc}", file=sys.stderr)
                        ok_this_message = False
                        break

                    hash_seen: Counter[str] = Counter()
                    for idx, row in enumerate(rows):
                        reason = validate_statement_row(row)
                        if reason is not None:
                            record_failure(
                                db,
                                f"{source_ref_prefix}:reject:{idx}",
                                text[:5000],
                                json.dumps(row, default=str),
                                reason,
                            )
                            print(f"REJECTED statement row {idx} in message {msg['id']}: {reason}", file=sys.stderr)
                            continue

                        normalized = normalize_merchant(row["merchant_raw"])
                        merchant = find_merchant(merchants, normalized)

                        period_key = resolve_period_key(
                            method_id, method["period_type"], method["cycle_day"], row["txn_date"]
                        )

                        h = content_hash(row["txn_date"], float(row["amount"]), normalized)
                        occurrence = hash_seen[h]
                        hash_seen[h] += 1
                        source_ref = f"{source_ref_prefix}:{h}" if occurrence == 0 else f"{source_ref_prefix}:{h}:{occurrence}"

                        insert_transaction_logging_conflicts(
                            db,
                            {
                                "method_id": method_id,
                                "txn_date": row["txn_date"],
                                "posted_date": row.get("posted_date"),
                                "merchant_raw": row["merchant_raw"],
                                "merchant_id": merchant["id"] if merchant else None,
                                "amount": row["amount"],
                                "currency": row.get("currency") or "SGD",
                                "fx_amount": row.get("fx_amount"),
                                "category": merchant["category"] if merchant else None,
                                "is_transfer": merchant["is_transfer"] if merchant else False,
                                "status": "confirmed",
                                "source": "statement",
                                "source_ref": source_ref,
                                "period_key": period_key,
                                "calendar_month": calendar_month(row["txn_date"]),
                            },
                        )
                        inserted += 1
                finally:
                    enc_path.unlink(missing_ok=True)
                    dec_path.unlink(missing_ok=True)

                if not ok_this_message:
                    break

            if ok_this_message:
                last_good_watermark = int(msg["internalDate"])
            else:
                failed += 1
                break  # do not advance the watermark past a failure
    finally:
        for f in tmp_dir.glob("*"):
            f.unlink(missing_ok=True)
        tmp_dir.rmdir()

    if last_good_watermark != watermark:
        db.update(
            "ingest_state",
            {"stream": "statements"},
            {"watermark": last_good_watermark, "updated_at": datetime.now(timezone.utc).isoformat()},
        )

    print(f"ingest-statements: messages={len(messages)} inserted={inserted} failed={failed}")
    return 1 if failed > 0 else 0


if __name__ == "__main__":
    raise SystemExit(main())
