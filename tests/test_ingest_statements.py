"""Tests for the WP3 optional-integration guards in
scripts/ingest_statements.py (design/optional-integrations.md).

The main correctness risk this file exists to pin: making "not configured"
skip cleanly is easy to get wrong in a dangerous direction — swallowing a
REAL misconfiguration silently. Every test below is written against that
exact boundary:

  - genuinely NO payment method has a statement sender configured -> skip
    cleanly, exit 0, no job failure.
  - Gmail itself isn't configured at all -> skip cleanly, exit 0 (mirrors
    supabase/functions/ingest-alerts/index.ts's identical guard).
  - a payment method DOES have a statement sender configured, but
    STATEMENT_PDF_PASSWORD is missing -> fail loudly, exit 1. Silence here
    would hide a real misconfiguration, not a deliberate absence.

Run: pytest tests/test_ingest_statements.py -v
"""
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

import ingest_statements as ing  # noqa: E402

DEFAULT_MAP = {
    "uobgroup.com": "uob_one",
    "citibank.com.sg": "citi_cashback",
    "citi.com": "citi_cashback",
    "hsbc.com.sg": "hsbc_revo",
}

GMAIL_ENV = {
    "GMAIL_CLIENT_ID": "client-id",
    "GMAIL_CLIENT_SECRET": "client-secret",
    "GMAIL_REFRESH_TOKEN": "refresh-token",
}


def method(id_, *, active=True, last4=None, statement_senders=None):
    # statement_senders mirrors payment_methods.statement_senders (WP2,
    # 0014_ingestion_routing_as_data.sql) — the same rows this helper
    # builds are fed to senders.domains_from_payment_methods() via the
    # mock db's select() below, not just to active_methods_with_statement_
    # sender() directly, so this field must be present for the main()-level
    # tests to exercise the real db-backed domain_map WP2 established
    # rather than silently resolving to an empty map.
    return {
        "id": id_,
        "last4": last4,
        "period_type": "calendar",
        "cycle_day": None,
        "active": active,
        "statement_senders": statement_senders,
    }


# ---------- gmail_configured: pure presence check ----------


def test_gmail_configured_true_when_all_three_present():
    assert ing.gmail_configured(dict(GMAIL_ENV)) is True


def test_gmail_configured_false_when_any_one_missing():
    for missing in ("GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"):
        env = dict(GMAIL_ENV)
        del env[missing]
        assert ing.gmail_configured(env) is False, f"expected False with {missing} missing"


def test_gmail_configured_false_when_env_var_is_empty_string():
    # An empty string is falsy, not "configured with a blank value" —
    # matches getAccessToken()'s own `!refreshToken` check in
    # supabase/functions/_shared/gmail.ts.
    env = dict(GMAIL_ENV)
    env["GMAIL_REFRESH_TOKEN"] = ""
    assert ing.gmail_configured(env) is False


def test_gmail_configured_false_when_totally_unset():
    assert ing.gmail_configured({}) is False


# ---------- active_methods_with_statement_sender: the absence side ----------


def test_no_active_methods_when_deployment_only_has_paylah():
    # PayLah has no statement source by construction (senders.py's own
    # reconcilable_method_ids() docstring) — a deployment with only
    # PayLah configured must resolve to "no statement senders configured"
    # even though a payment method exists and is active.
    methods = [method("paylah", last4="1234")]
    assert ing.active_methods_with_statement_sender(methods, DEFAULT_MAP) == frozenset()


def test_no_active_methods_when_no_payment_methods_at_all():
    assert ing.active_methods_with_statement_sender([], DEFAULT_MAP) == frozenset()


def test_no_active_methods_when_domain_map_is_empty():
    methods = [method("uob_one", last4="1111")]
    assert ing.active_methods_with_statement_sender(methods, {}) == frozenset()


def test_active_methods_excludes_inactive_ones():
    # A retired card that still has a statement-sender route configured
    # must not count — retired_cards (0004_retired_cards.sql) already
    # sets active=false for exactly this reason.
    methods = [method("uob_one", active=False, last4="1111")]
    assert ing.active_methods_with_statement_sender(methods, DEFAULT_MAP) == frozenset()


def test_active_methods_includes_active_configured_method():
    methods = [method("uob_one", last4="1111"), method("paylah", last4="2222")]
    assert ing.active_methods_with_statement_sender(methods, DEFAULT_MAP) == frozenset({"uob_one"})


# ---------- main(): the exit-code boundary itself ----------


def _mock_db(methods, integration_status_calls):
    """A SupabaseREST stand-in that answers payment_methods and records
    every integration_status write, without touching the network.
    """
    db = MagicMock()

    def select(table, params, **kwargs):
        if table == "payment_methods":
            return methods
        raise AssertionError(f"unexpected select({table!r}) — main() should not reach this in the guarded paths")

    def insert(table, row, on_conflict=None):
        if table == "integration_status":
            integration_status_calls.append(row)
            return [row]
        raise AssertionError(f"unexpected insert({table!r}) — main() should not reach this in the guarded paths")

    db.select.side_effect = select
    db.insert.side_effect = insert
    return db


def test_main_skips_cleanly_when_no_statement_senders_configured(monkeypatch):
    for k, v in GMAIL_ENV.items():
        monkeypatch.setenv(k, v)
    monkeypatch.delenv("STATEMENT_PDF_PASSWORD", raising=False)
    # Garbage value -> parse_domain_map() yields nothing, so
    # statement_sender_domains() falls through to the db-backed read
    # (WP2) rather than this override — same outcome either way here
    # since the one configured method (PayLah) has no statement_senders.
    monkeypatch.setenv("STATEMENT_SENDER_DOMAINS", "not,valid,at,all")
    # Only PayLah configured -> genuinely no statement senders.
    integration_status_calls: list[dict] = []
    mock_db = _mock_db([method("paylah", last4="2222")], integration_status_calls)

    with patch.object(ing, "SupabaseREST", return_value=mock_db), patch.object(ing, "get_access_token") as mock_token:
        exit_code = ing.main()

    assert exit_code == 0
    mock_token.assert_not_called()  # never even reaches Gmail
    assert integration_status_calls == [
        {
            "key": "statement_ingestion",
            "configured": False,
            "detail": "no active payment method has a statement sender configured",
        }
    ]


def test_main_skips_cleanly_when_gmail_not_configured(monkeypatch):
    for k in GMAIL_ENV:
        monkeypatch.delenv(k, raising=False)
    monkeypatch.delenv("STATEMENT_PDF_PASSWORD", raising=False)
    integration_status_calls: list[dict] = []
    # Statement senders ARE configured here — Gmail absence must still
    # win and skip cleanly, since without Gmail nothing downstream can
    # run regardless of what else is configured.
    mock_db = _mock_db(
        [method("uob_one", last4="1111", statement_senders=["uobgroup.com"])],
        integration_status_calls,
    )

    with patch.object(ing, "SupabaseREST", return_value=mock_db), patch.object(ing, "get_access_token") as mock_token:
        exit_code = ing.main()

    assert exit_code == 0
    mock_token.assert_not_called()
    assert len(integration_status_calls) == 1
    assert integration_status_calls[0]["configured"] is True  # senders ARE configured, just blocked on Gmail
    assert "Gmail not configured" in integration_status_calls[0]["detail"]


def test_main_fails_loudly_when_senders_configured_but_password_missing(monkeypatch):
    # The critical negative case: this must NOT be swallowed as "not
    # configured". A deployment that configured a statement sender but
    # forgot the password gets a loud, non-zero exit.
    for k, v in GMAIL_ENV.items():
        monkeypatch.setenv(k, v)
    monkeypatch.delenv("STATEMENT_PDF_PASSWORD", raising=False)
    integration_status_calls: list[dict] = []
    mock_db = _mock_db(
        [method("uob_one", last4="1111", statement_senders=["uobgroup.com"])],
        integration_status_calls,
    )

    with patch.object(ing, "SupabaseREST", return_value=mock_db), patch.object(ing, "get_access_token") as mock_token:
        exit_code = ing.main()

    assert exit_code == 1
    mock_token.assert_not_called()  # fails before ever touching Gmail's actual API
    assert len(integration_status_calls) == 1
    assert integration_status_calls[0]["configured"] is True
    assert "STATEMENT_PDF_PASSWORD not set" in integration_status_calls[0]["detail"]
    assert "uob_one" in integration_status_calls[0]["detail"]


def test_main_does_not_fail_when_password_missing_but_no_senders_configured(monkeypatch):
    # Same missing-password environment as the failing case above, but
    # with no statement senders configured — must take the absence path
    # (exit 0), not the misconfiguration path (exit 1). This is the
    # inverse pin of the previous test and is the whole point of
    # reordering the checks: password-presence must never be evaluated
    # before the "is this feature even in use" check.
    for k, v in GMAIL_ENV.items():
        monkeypatch.setenv(k, v)
    monkeypatch.delenv("STATEMENT_PDF_PASSWORD", raising=False)
    integration_status_calls: list[dict] = []
    mock_db = _mock_db([method("paylah", last4="2222")], integration_status_calls)

    with patch.object(ing, "SupabaseREST", return_value=mock_db), patch.object(ing, "get_access_token") as mock_token:
        exit_code = ing.main()

    assert exit_code == 0
    mock_token.assert_not_called()
