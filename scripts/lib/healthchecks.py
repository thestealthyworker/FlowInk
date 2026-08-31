"""Python mirror of supabase/functions/_shared/healthchecks.ts.

Telegram was removed on 2026-08-25 (docs/cardledger-build-spec.md §10
AMENDMENT). healthchecks.io is now the only out-of-band alarm across BOTH
runtimes: Edge Functions (Deno, `_shared/healthchecks.ts`) and this GitHub
Actions / `scripts/` runtime (Python). `scripts/` cannot import the Deno
module, so this file duplicates its API on purpose rather than being a
second, drifted mechanism — see that file for the fuller rationale on why
healthchecks.io specifically (a dead-man's-switch: it alerts when pings
*stop*, which is what catches a paused project or a silently dropped cron
schedule).

Three request shapes, same base URL:
    POST <url>       -> success ping ("still alive")
    POST <url>/fail   -> explicit failure, triggers an alert email immediately
    POST <url>/log    -> informational, recorded but does not alert

Callers choose which one: reserve /fail for genuine system-health problems
(the reconcile run itself crashing) and use /log for data-quality signals
(an above-threshold miss rate) — using /fail for routine data-quality noise
trains the operator to ignore the alarm, which defeats the point of having
one.

Same requirement the old telegram helper (and its Deno replacement) call
out: the one function responsible for surfacing every failure mode must not
itself fail silently. So: a short timeout, this never raises, and every
call returns a result the caller can check instead of the failure being
swallowed. A missing HEALTHCHECKS_PING_URL logs loudly and returns
ok=False rather than raising — a missing alarm URL must not crash the
reconciliation run that was trying to report a *different* problem.
"""
from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from typing import Literal

import requests

PING_TIMEOUT_SECONDS = 5


@dataclass(frozen=True)
class HealthcheckPingResult:
    ok: bool
    # Populated when ok is False. Safe to log.
    error: str | None = None


def _ping(suffix: Literal["", "/fail", "/log"], body: str | None = None) -> HealthcheckPingResult:
    base_url = os.environ.get("HEALTHCHECKS_PING_URL")
    if not base_url:
        error = "HEALTHCHECKS_PING_URL not configured"
        print(f"healthchecks.io ping skipped ({suffix or 'success'}): {error}", file=sys.stderr)
        return HealthcheckPingResult(ok=False, error=error)

    try:
        if body is not None:
            res = requests.post(f"{base_url}{suffix}", data=body.encode("utf-8"), timeout=PING_TIMEOUT_SECONDS)
        else:
            res = requests.get(f"{base_url}{suffix}", timeout=PING_TIMEOUT_SECONDS)
        if not res.ok:
            error = f"healthchecks.io returned HTTP {res.status_code}"
            print(f"healthchecks.io ping failed ({suffix or 'success'}): {error}", file=sys.stderr)
            return HealthcheckPingResult(ok=False, error=error)
        return HealthcheckPingResult(ok=True)
    except requests.RequestException as exc:
        error = str(exc)
        print(f"healthchecks.io ping failed ({suffix or 'success'}): {error}", file=sys.stderr)
        return HealthcheckPingResult(ok=False, error=error)


def ping_success() -> HealthcheckPingResult:
    """Success ping — "still alive". No body: healthchecks needs nothing more."""
    return _ping("")


def ping_fail(reason: str) -> HealthcheckPingResult:
    """Failure ping — triggers an alert email immediately. Reserve for
    genuine system-health problems: the run itself crashing, a source gone
    silent. ``reason`` becomes the ping body, so keep it short and specific
    — it's what shows up in the alert.
    """
    return _ping("/fail", reason)


def ping_log(detail: str) -> HealthcheckPingResult:
    """Informational ping — recorded on the healthchecks.io dashboard but
    does NOT alert. For data-quality issues (e.g. an above-threshold miss
    rate) that are not themselves evidence the system is down.
    """
    return _ping("/log", detail)
