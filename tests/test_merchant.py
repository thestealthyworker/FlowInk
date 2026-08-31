"""Pure logic tests, no network. Run: pytest tests/test_merchant.py"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from lib.merchant import find_merchant, normalize_merchant  # noqa: E402

# The line-wrap artefact from the confirmed PayLah sample (§4 parser trap 5).
PAYLAH_MERCHANT_RAW = "N.N.HARBOURLIGHT BISTRO PTE. LT\nD."


def test_normalize_strips_punctuation_and_collapses_whitespace():
    assert normalize_merchant(PAYLAH_MERCHANT_RAW) == "N N HARBOURLIGHT BISTRO"


def test_normalize_strips_corporate_suffixes():
    assert normalize_merchant("Chrono24 GmbH") == "CHRONO24"
    assert normalize_merchant("Acme Pte Ltd") == "ACME"


def test_normalize_is_idempotent_and_uppercase():
    once = normalize_merchant("TikTok Shop Seller")
    assert once == normalize_merchant(once)
    assert once == once.upper()


def test_find_merchant_matches_seeded_harbourlight_row():
    merchants = [
        {"id": 1, "match_pattern": "TIKTOK SHOP", "category": "online"},
        {"id": 2, "match_pattern": "CHRONO24", "category": "retail"},
        {"id": 3, "match_pattern": "HARBOURLIGHT", "category": "dining"},
    ]
    normalized = normalize_merchant(PAYLAH_MERCHANT_RAW)
    match = find_merchant(merchants, normalized)
    assert match is not None
    assert match["id"] == 3


def test_find_merchant_returns_none_for_unknown_merchant():
    merchants = [{"id": 1, "match_pattern": "TIKTOK SHOP", "category": "online"}]
    assert find_merchant(merchants, normalize_merchant("Some New Cafe Pte Ltd")) is None


def test_find_merchant_prefers_longer_pattern():
    merchants = [
        {"id": 1, "match_pattern": "SHOP", "category": "other"},
        {"id": 2, "match_pattern": "TIKTOK SHOP", "category": "online"},
    ]
    match = find_merchant(merchants, normalize_merchant("TikTok Shop Seller"))
    assert match["id"] == 2


# ============ digit-run stripping (backfill Fix 2a) ============

def test_normalize_strips_standalone_long_digit_run_reference_numbers():
    # Real backfill data: a different 9-digit ride id on every BUS/MRT row.
    assert normalize_merchant("BUS/MRT 833948420 SINGAPORE") == "BUS MRT SINGAPORE"
    assert normalize_merchant("BUS/MRT 836727704 SINGAPORE") == "BUS MRT SINGAPORE"


def test_normalize_does_not_strip_short_digit_runs_in_merchant_names():
    # Collateral-damage guard: a merchant whose name legitimately contains
    # digits must not be mangled just because it also contains a number.
    assert normalize_merchant("HH @ 602 TAMPINES Singapore") == "HH 602 TAMPINES SINGAPORE"
    assert normalize_merchant("7-ELEVEN -LUCKY PLAZA Singapore") == "7 ELEVEN LUCKY PLAZA SINGAPORE"
    assert normalize_merchant("247 FITNESS SINGAPORE SINGAPORE") == "247 FITNESS SINGAPORE SINGAPORE"


# ============ statement truncation collapse (backfill Fix 2b) ============

def test_normalize_collapses_hsbc_truncated_sheng_siong_to_uob_full_spelling():
    hsbc_variant = normalize_merchant("SHENG SIONG SUPERMARKE SINGAPORE   SG")
    uob_variant = normalize_merchant("SHENG SIONG SUPERMARKET -SINGAPORE")
    assert hsbc_variant == uob_variant == "SHENG SIONG SUPERMARKET SINGAPORE"
