"""Python port of supabase/functions/_shared/merchant.ts — keep both in
sync. See docs/cardledger-build-spec.md §4 parser trap 5.
"""
from __future__ import annotations

import re

CORPORATE_SUFFIXES = ["PTE LTD", "PTE", "LTD", "LLC", "GMBH", "INC", "CO", "LT D"]
# "PTE. LTD" (with periods) is deliberately absent: punctuation is stripped
# a few lines below, before any suffix is ever matched, so a literal
# period-bearing suffix can never match and was dead weight. "PTE LTD"
# (no periods) already covers the post-strip form.

# Minimum length of a whitespace-delimited, all-digit token before it is
# treated as a per-transaction reference number (bus/MRT ride id, POS
# terminal serial, ZIP code) rather than part of the merchant's name, and
# stripped. Real historical backfill data: "BUS/MRT 833948420 SINGAPORE"
# is a different string on every ride (9-digit ride id) — 34 rides in the
# backfill dataset normalised to 34 distinct merchants before this rule,
# 1 after. Threshold is 4, not lower, specifically so short numeric
# *name* components survive: "HH @ 602 TAMPINES" (3 digits) and
# "7-ELEVEN" (1 digit) must not be mangled into a useless pattern — see
# tests/test_merchant.py for both as regression cases.
MIN_STRIPPED_DIGIT_RUN_LENGTH = 4

# Known merchant-name truncation artefacts caused by a fixed-width source
# field cutting a name off mid-word. Not a general de-truncation engine —
# that would risk merging genuinely different merchants that happen to
# share a prefix (e.g. a truncated "CAT" must never absorb "CATERING").
# Each entry here is a specific, verified pair: HSBC's statement export
# truncates "SHENG SIONG SUPERMARKET" to "SHENG SIONG SUPERMARKE" (missing
# the final "T"; confirmed against 17 HSBC-sourced rows in the backfill
# dataset, all with the identical truncated spelling), while UOB's export
# of the same merchant is untruncated (9 rows). Left unfixed, the same
# grocery store split into two merchants (17 + 9 = 26 transactions) across
# two buckets. Applied to the whitespace-delimited prefix, after digit-run
# and trailing-locale stripping, before corporate-suffix stripping.
KNOWN_TRUNCATIONS = {
    "SHENG SIONG SUPERMARKE": "SHENG SIONG SUPERMARKET",
}


def _strip_digit_run_tokens(s: str) -> str:
    tokens = [
        tok for tok in s.split(" ")
        if not (tok.isdigit() and len(tok) >= MIN_STRIPPED_DIGIT_RUN_LENGTH)
    ]
    return " ".join(tokens)


def _strip_trailing_locale_code(s: str) -> str:
    # Statement exports append a trailing "SG" (ISO country code) after
    # "SINGAPORE" as a separate locale field, not part of the merchant's
    # name (observed on ~50 distinct HSBC/UOB merchant strings in the
    # backfill dataset, always immediately after "SINGAPORE"). Scoped to
    # that exact two-token tail so a merchant whose own name happens to
    # end in "SG" without a preceding "SINGAPORE" token is left alone.
    tokens = s.split(" ")
    if len(tokens) >= 2 and tokens[-1] == "SG" and tokens[-2] == "SINGAPORE":
        tokens = tokens[:-1]
    return " ".join(tokens)


def _canonicalize_known_truncations(s: str) -> str:
    for truncated, full in KNOWN_TRUNCATIONS.items():
        if s == truncated:
            return full
        if s.startswith(truncated + " "):
            return full + s[len(truncated):]
    return s


def normalize_merchant(raw: str) -> str:
    s = raw.upper()
    s = re.sub(r"[^A-Z0-9\s]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    s = _strip_digit_run_tokens(s)
    s = _strip_trailing_locale_code(s)
    s = _canonicalize_known_truncations(s)
    # Loop to a fixed point: stacked suffixes (e.g. "...PTE LT D" once the
    # line-wrap artefact "LT\nD" is folded back into "LT D") need more than
    # one pass, or the outer suffix ("PTE") is left behind.
    stripped = True
    while stripped:
        stripped = False
        for suffix in CORPORATE_SUFFIXES:
            new_s = re.sub(rf"\s{re.escape(suffix)}$", "", s)
            if new_s != s:
                s = new_s
                stripped = True
                break
    return s.strip()


def find_merchant(merchants: list[dict], normalized_raw: str) -> dict | None:
    candidates = [m for m in merchants if m["match_pattern"] in normalized_raw]
    candidates.sort(key=lambda m: len(m["match_pattern"]), reverse=True)
    return candidates[0] if candidates else None
