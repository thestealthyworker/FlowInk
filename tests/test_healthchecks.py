"""Tests for scripts/lib/healthchecks.py, the Python mirror of
supabase/functions/_shared/healthchecks.ts.

Covers the three states the module contract cares about: no
HEALTHCHECKS_PING_URL configured (must not raise, must not attempt a
network call, must log loudly), a successful ping, and a failed ping
(non-2xx response or a network exception) — in each case the caller gets
back a checkable result rather than an exception or a silent no-op, which
is exactly the gap `send_telegram()`'s unset-env no-op used to leave open.

Run: pytest tests/test_healthchecks.py -v
"""
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
import requests

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from lib.healthchecks import (  # noqa: E402
    HealthcheckPingResult,
    ping_fail,
    ping_log,
    ping_success,
)

PING_URL = "https://hc-ping.com/test-uuid"


# ---------- HEALTHCHECKS_PING_URL unset ----------


def test_ping_success_without_url_configured_returns_not_ok_and_does_not_raise(monkeypatch):
    monkeypatch.delenv("HEALTHCHECKS_PING_URL", raising=False)
    with patch("lib.healthchecks.requests.get") as mock_get, patch("lib.healthchecks.requests.post") as mock_post:
        result = ping_success()

    assert result == HealthcheckPingResult(ok=False, error="HEALTHCHECKS_PING_URL not configured")
    mock_get.assert_not_called()
    mock_post.assert_not_called()


def test_ping_fail_without_url_configured_returns_not_ok_and_does_not_raise(monkeypatch):
    monkeypatch.delenv("HEALTHCHECKS_PING_URL", raising=False)
    result = ping_fail("reconcile run crashed: boom")
    assert result.ok is False
    assert result.error == "HEALTHCHECKS_PING_URL not configured"


def test_ping_log_without_url_configured_returns_not_ok_and_does_not_raise(monkeypatch):
    monkeypatch.delenv("HEALTHCHECKS_PING_URL", raising=False)
    result = ping_log("miss rate 12.0%: 3/25")
    assert result.ok is False
    assert result.error == "HEALTHCHECKS_PING_URL not configured"


# ---------- success ----------


def test_ping_success_sends_a_plain_get_with_no_body(monkeypatch):
    monkeypatch.setenv("HEALTHCHECKS_PING_URL", PING_URL)
    mock_response = MagicMock(ok=True, status_code=200)
    with patch("lib.healthchecks.requests.get", return_value=mock_response) as mock_get, \
         patch("lib.healthchecks.requests.post") as mock_post:
        result = ping_success()

    assert result == HealthcheckPingResult(ok=True)
    mock_get.assert_called_once()
    assert mock_get.call_args.args[0] == PING_URL
    mock_post.assert_not_called()


def test_ping_fail_posts_the_reason_to_the_fail_suffix(monkeypatch):
    monkeypatch.setenv("HEALTHCHECKS_PING_URL", PING_URL)
    mock_response = MagicMock(ok=True, status_code=200)
    with patch("lib.healthchecks.requests.post", return_value=mock_response) as mock_post:
        result = ping_fail("reconcile run crashed: boom")

    assert result.ok is True
    mock_post.assert_called_once()
    assert mock_post.call_args.args[0] == f"{PING_URL}/fail"
    assert mock_post.call_args.kwargs["data"] == b"reconcile run crashed: boom"


def test_ping_log_posts_the_detail_to_the_log_suffix(monkeypatch):
    monkeypatch.setenv("HEALTHCHECKS_PING_URL", PING_URL)
    mock_response = MagicMock(ok=True, status_code=200)
    with patch("lib.healthchecks.requests.post", return_value=mock_response) as mock_post:
        result = ping_log("miss rate 12.0%: 3/25 unmatched")

    assert result.ok is True
    mock_post.assert_called_once()
    assert mock_post.call_args.args[0] == f"{PING_URL}/log"
    assert mock_post.call_args.kwargs["data"] == b"miss rate 12.0%: 3/25 unmatched"


# ---------- failure: non-2xx and network exceptions ----------


def test_ping_fail_reports_non_2xx_response_as_not_ok(monkeypatch):
    monkeypatch.setenv("HEALTHCHECKS_PING_URL", PING_URL)
    mock_response = MagicMock(ok=False, status_code=500)
    with patch("lib.healthchecks.requests.post", return_value=mock_response):
        result = ping_fail("reconcile run crashed: boom")

    assert result.ok is False
    assert result.error == "healthchecks.io returned HTTP 500"


def test_ping_success_swallows_network_exception_into_a_result(monkeypatch):
    monkeypatch.setenv("HEALTHCHECKS_PING_URL", PING_URL)
    with patch("lib.healthchecks.requests.get", side_effect=requests.ConnectionError("dns failure")):
        result = ping_success()

    assert result.ok is False
    assert "dns failure" in result.error


@pytest.mark.parametrize("fn,expected_suffix", [(ping_fail, "/fail"), (ping_log, "/log")])
def test_post_variants_swallow_network_exception_into_a_result(monkeypatch, fn, expected_suffix):
    monkeypatch.setenv("HEALTHCHECKS_PING_URL", PING_URL)
    with patch("lib.healthchecks.requests.post", side_effect=requests.Timeout("timed out")):
        result = fn("some reason")

    assert result.ok is False
    assert "timed out" in result.error
