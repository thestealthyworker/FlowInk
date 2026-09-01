"""Parser regression test against the confirmed alert-email fixtures
(docs/reference-example-sg.md's "Alert email formats and parser traps"
section, and docs/architecture.md §5's "Parser contract" subsection).
Every parser change should run
against these — add a new fixture + expected.json pair whenever a new
bank format is first encountered, or a parse_failures row is fixed.

Requires ANTHROPIC_API_KEY (real API call — this exercises the actual
parser contract, not a mock). Skips cleanly if unset, so this file is
still safe to collect in an environment with no key configured.

Run: pytest tests/test_parser.py -v
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest
import requests

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

FIXTURES_DIR = Path(__file__).parent / "fixtures"

# Kept identical to supabase/functions/_shared/anthropic.ts PARSER_SYSTEM_PROMPT.
SYSTEM_PROMPT = """You extract structured transaction data from Singapore bank alert emails.

Return ONLY a single JSON object matching the schema. No markdown fences,
no preamble, no explanation.

Schema:
{
  "amount": number,
  "currency": string,        // ISO 4217
  "merchant_raw": string,
  "last4": string | null,
  "txn_date": string,        // ISO 8601 (YYYY-MM-DD)
  "txn_time": string | null,
  "txn_type": "purchase" | "transfer" | "topup" | "refund" | "unknown",
  "confidence": "high" | "low"
}

Rules:
- Never convert currency. Record the currency and amount exactly as stated.
- Never infer a value that is not present. Use null.
- Never guess the card. If no last-4 digits appear, last4 is null.
- Ambiguous dates: DD/MM/YY unless the day is unambiguously above 12.
- If the email gives a date with no year (e.g. PayLah's "22 Aug"), infer
  the year from the "Email received" date given below. If that inferred
  date would be in the future, use the prior year instead (December ->
  January rollover).
- Set confidence to "low" if any field required guessing.

If the email is not a transaction alert (marketing, statement notice,
security notice), return {"txn_type": "not_a_transaction"}.
"""


def load_fixture(path: Path) -> tuple[dict, str]:
    raw = path.read_text()
    header_block, body = raw.split("\n\n", 1)
    headers = {}
    for line in header_block.splitlines():
        key, _, value = line.partition(":")
        headers[key.strip()] = value.strip()
    return headers, body


def call_parser(headers: dict, body: str) -> dict:
    api_key = os.environ["ANTHROPIC_API_KEY"]
    user_text = f"Email received: {headers['InternalDate']}\nSubject: {headers['Subject']}\n\n{body}"
    res = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "content-type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        },
        json={
            "model": "claude-haiku-4-5-20251001",
            "max_tokens": 512,
            "temperature": 0,
            "system": SYSTEM_PROMPT,
            "messages": [{"role": "user", "content": user_text}],
        },
        timeout=30,
    )
    res.raise_for_status()
    text = res.json()["content"][0]["text"]
    return json.loads(text.strip())


FIXTURE_STEMS = sorted({p.stem for p in FIXTURES_DIR.glob("*.txt")})

requires_api_key = pytest.mark.skipif(
    "ANTHROPIC_API_KEY" not in os.environ, reason="ANTHROPIC_API_KEY not set"
)


@requires_api_key
@pytest.mark.parametrize("stem", FIXTURE_STEMS)
def test_fixture_matches_expected(stem: str):
    headers, body = load_fixture(FIXTURES_DIR / f"{stem}.txt")
    expected = json.loads((FIXTURES_DIR / f"{stem}.expected.json").read_text())

    actual = call_parser(headers, body)

    assert actual["txn_type"] != "not_a_transaction", "should be recognised as a real transaction"
    assert actual["currency"] == expected["currency"], "must never convert currency"
    assert abs(float(actual["amount"]) - float(expected["amount"])) < 0.01
    assert actual["last4"] == expected["last4"]
    assert actual["txn_date"] == expected["txn_date"]
    assert actual["confidence"] == "high"
