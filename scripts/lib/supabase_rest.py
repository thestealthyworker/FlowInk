"""Thin PostgREST client. GitHub Actions is a separate runtime from Edge
Functions (see docs/cardledger-build-spec.md §12) and has no direct
Postgres connection string configured — it talks to Supabase the same way
the dashboard eventually will, over the REST API, but with the
service-role key so it bypasses RLS.
"""
from __future__ import annotations

import os
from typing import Any

import requests


class SupabaseREST:
    def __init__(self) -> None:
        url = os.environ["SUPABASE_URL"].rstrip("/")
        key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
        self.base = f"{url}/rest/v1"
        self.headers = {
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        }

    def select(self, table: str, params: dict[str, Any], *, page_size: int = 1000) -> list[dict]:
        """Fetch every matching row, paginating past PostgREST's row cap.

        Without an explicit ``Range``, PostgREST silently truncates a
        result at its configured max-rows setting with no error — a
        caller that never checks ``Content-Range`` (as this client
        previously didn't) gets a quietly incomplete result set instead of
        a failure. Loop on ``Range`` until a page comes back shorter than
        requested.
        """
        results: list[dict] = []
        offset = 0
        while True:
            headers = {
                **self.headers,
                "Range-Unit": "items",
                "Range": f"{offset}-{offset + page_size - 1}",
            }
            res = requests.get(f"{self.base}/{table}", headers=headers, params=params, timeout=30)
            if res.status_code not in (200, 206):
                res.raise_for_status()
            page = res.json()
            results.extend(page)
            if len(page) < page_size:
                break
            offset += page_size
        return results

    def insert(self, table: str, rows: list[dict] | dict, on_conflict: str | None = None) -> list[dict]:
        headers = {**self.headers, "Prefer": "return=representation,resolution=merge-duplicates"}
        params = {"on_conflict": on_conflict} if on_conflict else {}
        res = requests.post(f"{self.base}/{table}", headers=headers, params=params, json=rows, timeout=30)
        res.raise_for_status()
        return res.json()

    def update(self, table: str, match: dict[str, Any], patch: dict[str, Any]) -> list[dict]:
        headers = {**self.headers, "Prefer": "return=representation"}
        params = {f"{k}": f"eq.{v}" for k, v in match.items()}
        res = requests.patch(f"{self.base}/{table}", headers=headers, params=params, json=patch, timeout=30)
        res.raise_for_status()
        return res.json()

    def rpc(self, function: str, args: dict[str, Any]) -> Any:
        """Call a Postgres function over PostgREST's ``/rpc/<function>``
        endpoint — the same call shape ``dashboard/lib/actions/config.ts``
        makes via ``supabase.rpc(...)`` from the Next.js runtime, just
        issued from this REST client's runtime instead (WP7's validator:
        see ``scripts/lib/rules_validator.py``). Every RPC this project
        exposes to a non-superuser role is ``security invoker`` (0018's
        own comment on ``submit_method_rule`` — the one deliberate
        exception, ``is_operator()``, is ``security definer`` by design,
        0008's header explains why), so a call made with the service-role
        key here runs with service_role's own privileges — RLS bypassed,
        ``is_operator()`` reading ``auth.uid()`` as null and evaluating
        false — never with elevated authority contributed by this client.
        Raises ``requests.HTTPError`` (with the Postgres error message in
        the response body) on a failed call, e.g. a ``RAISE EXCEPTION``
        inside the function or a trigger it fires — never swallowed here,
        matching every other method on this class.
        """
        res = requests.post(f"{self.base}/rpc/{function}", headers=self.headers, json=args, timeout=30)
        res.raise_for_status()
        return res.json()
