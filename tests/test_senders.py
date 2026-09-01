"""Pure logic tests for the exact-domain sender allowlist, no network.

See docs/architecture.md §5 ("Routing is data, not code") and §10
(security model). The old build spec's "trap 3" this used to cite does
not survive under that number in docs/reference-example-sg.md's current
parser-traps list, so the rationale is spelled out here directly: routing
by substring (e.g. ``"uobgroup.com" in sender``) lets an attacker who owns
attacker.io send from statements@uobgroup.com.attacker.io, pass
SPF/DKIM/DMARC for their own domain, and be routed to a real card. The
critical regression test here is that exact rejection.

Run: pytest tests/test_senders.py -v
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from lib.senders import (  # noqa: E402
    DEFAULT_STATEMENT_SENDER_DOMAINS,
    domains_from_payment_methods,
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


# ---------- WP2 (design/ingestion-routing.md): domains_from_payment_methods ----------
#
# The statement path's routing table used to come from ONE place:
# DEFAULT_STATEMENT_SENDER_DOMAINS, hardcoded here. It now comes from
# payment_methods.statement_senders, read live via domains_from_payment_methods()
# — the same table the alert path (TS) reads for alert_senders. These tests
# use a minimal fake db (only the .select() shape senders.py actually
# calls) rather than a real SupabaseREST/network client, per this file's own
# "no network" framing.


class FakeDB:
    """Minimal stand-in for lib.supabase_rest.SupabaseREST: only the
    .select(table, params) -> list[dict] shape domains_from_payment_methods()
    actually uses."""

    def __init__(self, rows: list[dict]):
        self._rows = rows

    def select(self, table: str, params: dict) -> list[dict]:
        assert table == "payment_methods"
        return self._rows


def test_domains_from_payment_methods_builds_mapping_from_rows():
    db = FakeDB([
        {"id": "uob_one", "statement_senders": ["uobgroup.com"]},
        {"id": "hsbc_revo", "statement_senders": ["hsbc.com.sg"]},
        # Citi: multiple candidate domains for one method, same shape the
        # old hardcoded table already needed.
        {"id": "citi_cashback", "statement_senders": ["citibank.com.sg", "citi.com"]},
    ])
    assert domains_from_payment_methods(db) == {
        "uobgroup.com": "uob_one",
        "hsbc.com.sg": "hsbc_revo",
        "citibank.com.sg": "citi_cashback",
        "citi.com": "citi_cashback",
    }


def test_domains_from_payment_methods_excludes_method_with_null_statement_senders():
    # PayLah has no statement source, today and after this change — a
    # method whose statement_senders is NULL contributes nothing to the
    # map, exactly like its absence from the old hardcoded table.
    db = FakeDB([
        {"id": "uob_one", "statement_senders": ["uobgroup.com"]},
        {"id": "paylah", "statement_senders": None},
    ])
    mapping = domains_from_payment_methods(db)
    assert "paylah" not in mapping.values()
    assert mapping == {"uobgroup.com": "uob_one"}


def test_domains_from_payment_methods_excludes_method_with_empty_statement_senders_array():
    # The empty-array shape must behave identically to NULL: excluded, not
    # a wildcard or an accidental match-everything.
    db = FakeDB([{"id": "citi_cashback", "statement_senders": []}])
    assert domains_from_payment_methods(db) == {}


def test_domains_from_payment_methods_ignores_malformed_domain_in_a_db_row():
    # DB rows are not blindly trusted just because they came from the
    # database instead of an env var: the same _DOMAIN_RE validation
    # parse_domain_map() applies to the env-var path also applies here.
    db = FakeDB([
        {"id": "uob_one", "statement_senders": ["uobgroup.com", "not a domain!!", ""]},
    ])
    assert domains_from_payment_methods(db) == {"uobgroup.com": "uob_one"}


def test_domains_from_payment_methods_empty_table_returns_empty_mapping_not_an_error():
    # A fresh deployment with no routing configured yet is a valid state,
    # not a failure — distinguished from a DB read failure by NOT catching
    # exceptions inside domains_from_payment_methods() at all (see its
    # docstring): this test's FakeDB simply returns no rows, it never
    # raises.
    assert domains_from_payment_methods(FakeDB([])) == {}


def test_domains_from_payment_methods_propagates_a_db_read_failure_rather_than_silently_falling_back():
    class ExplodingDB:
        def select(self, table, params):
            raise RuntimeError("simulated network failure")

    try:
        domains_from_payment_methods(ExplodingDB())
    except RuntimeError:
        pass
    else:
        raise AssertionError(
            "expected domains_from_payment_methods to propagate the DB failure, "
            "not swallow it into an empty/default mapping"
        )


def test_method_id_for_sender_rejects_lookalike_subdomain_even_when_domain_map_is_db_sourced():
    # The critical regression, restated against a DB-built map instead of
    # a hardcoded one: moving the source of the allowlist to the database
    # must not reopen the substring/lookalike hole. Exact match is a
    # property of sender_domain()/method_id_for_sender(), not of where the
    # map's data came from.
    db = FakeDB([{"id": "uob_one", "statement_senders": ["uobgroup.com"]}])
    domain_map = domains_from_payment_methods(db)
    assert method_id_for_sender("statements@uobgroup.com", domain_map) == "uob_one"
    assert method_id_for_sender("statements@uobgroup.com.attacker.io", domain_map) is None


def test_statement_sender_domains_uses_db_when_supplied_and_no_env_override():
    # The production path as of WP2: no env override configured, so the
    # live DB read becomes the default — NOT the hardcoded
    # DEFAULT_STATEMENT_SENDER_DOMAINS constant, which would reintroduce
    # the exact drift this change removes.
    db = FakeDB([{"id": "example_card", "statement_senders": ["example.com"]}])
    result = statement_sender_domains({}, db=db)
    assert result == {"example.com": "example_card"}
    assert result != DEFAULT_STATEMENT_SENDER_DOMAINS


def test_statement_sender_domains_env_override_still_wins_over_a_supplied_db():
    # STATEMENT_SENDER_DOMAINS remains a local/CI escape hatch layered on
    # top of the DB source, per design/ingestion-routing.md — it must
    # still take priority even when a db client is available, so a
    # developer can override routing locally without needing a live DB
    # connection or touching production data.
    db = FakeDB([{"id": "uob_one", "statement_senders": ["uobgroup.com"]}])
    env = {"STATEMENT_SENDER_DOMAINS": "example.com=hsbc_revo"}
    assert statement_sender_domains(env, db=db) == {"example.com": "hsbc_revo"}


def test_statement_sender_domains_falls_back_to_hardcoded_default_with_no_env_and_no_db():
    # Backward-compatible fallback for callers with no DB client at all
    # (pure offline tests, mainly — ingest_statements.py always passes a
    # db in production, so this branch is not the production path).
    assert statement_sender_domains({}) == DEFAULT_STATEMENT_SENDER_DOMAINS
    assert statement_sender_domains({}) == DEFAULT_MAP
