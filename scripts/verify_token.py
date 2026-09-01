#!/usr/bin/env python3
"""Gmail refresh-token smoke test and day-8 diagnostic.

See docs/setup/gmail.md §3 ("Configure the OAuth consent screen") and §9
("The day-8 check") — this content moved into that setup guide rather
than either of the two docs the old build spec's architecture material
split into. If the Google Cloud OAuth consent screen was left in
"Testing" publishing status, the
refresh token silently expires after 7 days — the pipeline works all week
then dies every Sunday. Run this once right after capturing the token, and
again on day 8. If it fails on day 8, the consent screen was never
actually published to Production.

Credential resolution order:
  1. --auth-dir (default ~/cardledger-auth), reading client_secret.json
     (Google's own download format: {"installed": {"client_id": ...,
     "client_secret": ...}}) and refresh_token.txt. This is the local,
     one-time setup path (§12 0A(ii)) — delete this directory once secrets
     are stored and this script passes.
  2. Falling back to the environment: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET,
     GMAIL_REFRESH_TOKEN. Use this for the day-8 (and any later) check,
     once the local auth dir is already gone — export the same values
     that were passed to `supabase secrets set`.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import requests


def load_credentials(auth_dir: Path) -> tuple[str, str, str] | None:
    secret_file = auth_dir / "client_secret.json"
    token_file = auth_dir / "refresh_token.txt"
    if not secret_file.exists() or not token_file.exists():
        return None
    raw = json.loads(secret_file.read_text())
    block = raw.get("installed") or raw.get("web") or raw
    client_id = block["client_id"]
    client_secret = block["client_secret"]
    refresh_token = token_file.read_text().strip()
    return client_id, client_secret, refresh_token


def load_from_env() -> tuple[str, str, str] | None:
    client_id = os.environ.get("GMAIL_CLIENT_ID")
    client_secret = os.environ.get("GMAIL_CLIENT_SECRET")
    refresh_token = os.environ.get("GMAIL_REFRESH_TOKEN")
    if client_id and client_secret and refresh_token:
        return client_id, client_secret, refresh_token
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--auth-dir", default=str(Path.home() / "cardledger-auth"))
    args = parser.parse_args()

    creds = load_credentials(Path(args.auth_dir)) or load_from_env()
    if not creds:
        print(
            f"No credentials found in {args.auth_dir} (client_secret.json + "
            "refresh_token.txt) or in GMAIL_CLIENT_ID/GMAIL_CLIENT_SECRET/"
            "GMAIL_REFRESH_TOKEN environment variables.",
            file=sys.stderr,
        )
        return 2

    client_id, client_secret, refresh_token = creds

    token_res = requests.post(
        "https://oauth2.googleapis.com/token",
        data={
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        },
        timeout=30,
    )
    if not token_res.ok:
        # Never print the response body: this script's output lands in
        # persistent GitHub Actions logs (readable by anyone with repo
        # access, §11), and Google's error responses can echo back
        # request parameters. Status code plus a fixed string is enough
        # to diagnose from here.
        print(f"FAILED to mint access token: HTTP {token_res.status_code}", file=sys.stderr)
        print(
            "If this is the day-8 check: the OAuth consent screen was probably "
            "left in 'Testing' status and the refresh token has expired. "
            "Publish it to 'Production' in Google Cloud Console and re-run "
            "the one-time consent flow.",
            file=sys.stderr,
        )
        return 1

    access_token = token_res.json()["access_token"]
    print("Access token minted OK.")

    # §7: "Scope: https://www.googleapis.com/auth/gmail.readonly and
    # nothing more." Prove the grant is exactly that scope, not a superset
    # a misconfigured OAuth client could have requested.
    REQUIRED_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
    tokeninfo_res = requests.get(
        "https://oauth2.googleapis.com/tokeninfo",
        params={"access_token": access_token},
        timeout=30,
    )
    if not tokeninfo_res.ok:
        print(f"FAILED to verify token scope: HTTP {tokeninfo_res.status_code}", file=sys.stderr)
        return 1
    granted_scopes = set((tokeninfo_res.json().get("scope") or "").split())
    if granted_scopes != {REQUIRED_SCOPE}:
        print(
            f"FAILED scope assertion: expected exactly {{'{REQUIRED_SCOPE}'}}, "
            f"got {granted_scopes or '(empty)'} — the OAuth client is requesting "
            "more than gmail.readonly, or the grant is stale. Fix before trusting "
            "this token in the pipeline.",
            file=sys.stderr,
        )
        return 1
    print(f"Scope OK: exactly {REQUIRED_SCOPE}")

    list_res = requests.get(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        headers={"Authorization": f"Bearer {access_token}"},
        params={"q": "label:Payments", "maxResults": 1},
        timeout=30,
    )
    if not list_res.ok:
        print(f"FAILED to list messages: HTTP {list_res.status_code}", file=sys.stderr)
        return 1

    body = list_res.json()
    result_size = body.get("resultSizeEstimate", 0)
    print(f"label:Payments — resultSizeEstimate={result_size}")
    if body.get("messages"):
        print(f"Sample message id: {body['messages'][0]['id']}")
    else:
        print("No messages found under label:Payments yet — check the label/filter is applied.")

    print("verify_token: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
