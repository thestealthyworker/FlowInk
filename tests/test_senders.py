"""Pure logic tests for the exact-domain sender allowlist, no network.

docs/cardledger-build-spec.md §4 trap 3 / §11: routing by substring (e.g.
``"uobgroup.com" in sender``) lets an attacker who owns attacker.io send
from statements@uobgroup.com.attacker.io, pass SPF/DKIM/DMARC for their
own domain, and be routed to a real card. The critical regression test
here is that exact rejection.

Run: pytest tests/test_senders.py -v
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from lib.senders import (  # noqa: E402
    gmail_sender_prefilter,
    method_id_for_sender,
    parse_domain_map,
    reconcilable_method_ids,
    sender_domain,
    statement_sender_domains,
)

DEFAULT_MAP = {
    "uobgroup.com": "uob_one",
    "citibank.com.sg": "citi_cashback",
    "citi.com": "citi_cashback",
    "hsbc.com.sg": "hsbc_revo",
}


# ---------- sender_domain ----------


def test_sender_domain_extracts_lowercase_domain():
    assert sender_domain("unialerts@uobgroup.com") == "uobgroup.com"
    assert sender_domain("UniAlerts@UOBGROUP.COM") == "uobgroup.com"


def test_sender_domain_handles_display_name_format():
    assert sender_domain('"UOB Alerts" <unialerts@uobgroup.com>') == "uobgroup.com"


def test_sender_domain_ignores_display_name_never_trusts_it():
    # A display name claiming to be the bank is not the sender.
    assert sender_domain('"statements@uobgroup.com" <billing@attacker.io>') == "attacker.io"


def test_sender_domain_rejects_lookalike_subdomain_the_critical_case():
    # The exact attack described in the spec: attacker.io owns its own
    # domain and can legitimately pass SPF/DKIM/DMARC for it while using
    # a subdomain that *contains* the bank's real domain as a substring.
    assert sender_domain("statements@uobgroup.com.attacker.io") == "uobgroup.com.attacker.io"
    assert sender_domain("statements@uobgroup.com.attacker.io") != "uobgroup.com"


def test_sender_domain_none_for_missing_header():
    assert sender_domain(None) is None
    assert sender_domain("") is None


def test_sender_domain_none_for_multiple_addresses():
    assert sender_domain("a@uobgroup.com, b@attacker.io") is None


def test_sender_domain_none_for_malformed_address():
    assert sender_domain("not-an-email") is None


def test_sender_domain_rejects_non_ascii_lookalike():
    # A Cyrillic homoglyph ("а" instead of "a") must never be normalised
    # to, or compared equal against, the ASCII allowlisted domain — the
    # domain regex is ASCII-only by construction, so this is rejected
    # outright rather than silently coerced.
    cyrillic_a = "а"  # CYRILLIC SMALL LETTER A, visually identical to 'a'
    assert sender_domain(f"statements@{cyrillic_a}ttacker.io") is None


# ---------- method_id_for_sender: the critical regression ----------


def test_method_id_for_sender_matches_exact_allowlisted_domain():
    assert method_id_for_sender("unialerts@uobgroup.com", DEFAULT_MAP) == "uob_one"
    assert method_id_for_sender("alerts@hsbc.com.sg", DEFAULT_MAP) == "hsbc_revo"
    assert method_id_for_sender("alerts@citibank.com.sg", DEFAULT_MAP) == "citi_cashback"
    assert method_id_for_sender("alerts@citi.com", DEFAULT_MAP) == "citi_cashback"


def test_method_id_for_sender_rejects_uobgroup_com_attacker_io():
    # This is the defect: substring matching (`"uobgroup.com" in sender`)
    # would route this to uob_one. Exact-domain matching must not.
    assert method_id_for_sender("statements@uobgroup.com.attacker.io", DEFAULT_MAP) is None


def test_method_id_for_sender_rejects_other_substring_variants():
    assert method_id_for_sender("fake@notuobgroup.com", DEFAULT_MAP) is None
    assert method_id_for_sender("fake@uobgroup.com.au", DEFAULT_MAP) is None
    assert method_id_for_sender("fake@evil-uobgroup.com", DEFAULT_MAP) is None


def test_method_id_for_sender_none_for_unknown_domain():
    assert method_id_for_sender("someone@gmail.com", DEFAULT_MAP) is None


def test_method_id_for_sender_none_for_missing_header():
    assert method_id_for_sender(None, DEFAULT_MAP) is None


def test_method_id_for_sender_never_trusts_display_name_spoofing():
    spoofed = '"UOB Alerts <unialerts@uobgroup.com>" <billing@attacker.io>'
    assert method_id_for_sender(spoofed, DEFAULT_MAP) is None


# ---------- parse_domain_map ----------


def test_parse_domain_map_parses_valid_entries():
    parsed = parse_domain_map("uobgroup.com=uob_one,hsbc.com.sg=hsbc_revo")
    assert parsed == {"uobgroup.com": "uob_one", "hsbc.com.sg": "hsbc_revo"}


def test_parse_domain_map_lowercases_domain():
    parsed = parse_domain_map("UOBGROUP.COM=uob_one")
    assert parsed == {"uobgroup.com": "uob_one"}


def test_parse_domain_map_drops_malformed_entries():
    parsed = parse_domain_map("uobgroup.com=uob_one,garbage,=novalue,bad_domain!=x")
    assert parsed == {"uobgroup.com": "uob_one"}


def test_parse_domain_map_drops_entry_with_empty_method_id():
    parsed = parse_domain_map("uobgroup.com=")
    assert parsed == {}


# ---------- statement_sender_domains (env override) ----------


def test_statement_sender_domains_defaults_when_env_unset():
    assert statement_sender_domains({}) == DEFAULT_MAP


def test_statement_sender_domains_uses_env_override():
    env = {"STATEMENT_SENDER_DOMAINS": "example.com=hsbc_revo"}
    assert statement_sender_domains(env) == {"example.com": "hsbc_revo"}


def test_statement_sender_domains_falls_back_to_default_on_garbage_env():
    env = {"STATEMENT_SENDER_DOMAINS": "not,valid,at,all"}
    assert statement_sender_domains(env) == DEFAULT_MAP


# ---------- reconcilable_method_ids ----------


def test_reconcilable_method_ids_excludes_paylah():
    ids = reconcilable_method_ids(DEFAULT_MAP)
    assert "paylah" not in ids
    assert ids == frozenset({"uob_one", "citi_cashback", "hsbc_revo"})


# ---------- gmail_sender_prefilter ----------


def test_gmail_sender_prefilter_builds_or_clause():
    clause = gmail_sender_prefilter(DEFAULT_MAP)
    assert clause.startswith("(") and clause.endswith(")")
    for domain in DEFAULT_MAP:
        assert f"from:{domain}" in clause
