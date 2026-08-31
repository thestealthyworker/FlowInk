"""Gmail readonly client for the GitHub Actions runtime. Same refresh-token
flow as the Edge Function version (supabase/functions/_shared/gmail.ts),
duplicated deliberately — GitHub Actions and Edge Functions are separate
runtimes with separate secret stores (docs/cardledger-build-spec.md §12).
"""
from __future__ import annotations

import base64
import os
from typing import Any

import requests

GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me"


def get_access_token() -> str:
    res = requests.post(
        "https://oauth2.googleapis.com/token",
        data={
            "client_id": os.environ["GMAIL_CLIENT_ID"],
            "client_secret": os.environ["GMAIL_CLIENT_SECRET"],
            "refresh_token": os.environ["GMAIL_REFRESH_TOKEN"],
            "grant_type": "refresh_token",
        },
        timeout=30,
    )
    res.raise_for_status()
    return res.json()["access_token"]


def list_message_ids(
    access_token: str,
    query: str,
    max_results: int = 50,
    *,
    hard_cap: int = 1000,
) -> list[str]:
    """Every message id matching ``query``, up to ``hard_cap``.

    Gmail's list API is paginated (``max_results`` is a per-page size, not
    a total) and returns newest-first. A caller that reads only the first
    page — as this previously did — silently caps backlog recovery at the
    newest ``max_results`` messages and skips everything older, which is
    exactly backwards for catching up after an outage. Follow
    ``nextPageToken`` until it is exhausted or ``hard_cap`` is reached; the
    caller sorts by ``internalDate`` before processing, so page order does
    not matter here.
    """
    ids: list[str] = []
    page_token: str | None = None
    while len(ids) < hard_cap:
        params: dict[str, Any] = {"q": query, "maxResults": min(max_results, hard_cap - len(ids))}
        if page_token:
            params["pageToken"] = page_token
        res = requests.get(
            f"{GMAIL_API}/messages",
            headers={"Authorization": f"Bearer {access_token}"},
            params=params,
            timeout=30,
        )
        res.raise_for_status()
        body = res.json()
        ids.extend(m["id"] for m in body.get("messages", []))
        page_token = body.get("nextPageToken")
        if not page_token:
            break
    return ids


def get_message(access_token: str, message_id: str) -> dict[str, Any]:
    res = requests.get(
        f"{GMAIL_API}/messages/{message_id}",
        headers={"Authorization": f"Bearer {access_token}"},
        params={"format": "full"},
        timeout=30,
    )
    res.raise_for_status()
    return res.json()


def find_pdf_attachments(message: dict[str, Any]) -> list[dict[str, str]]:
    """Returns [{filename, attachmentId}] for every PDF part in the message."""
    found: list[dict[str, str]] = []

    def walk(part: dict[str, Any]) -> None:
        filename = part.get("filename") or ""
        body = part.get("body") or {}
        if filename.lower().endswith(".pdf") and body.get("attachmentId"):
            found.append({"filename": filename, "attachmentId": body["attachmentId"]})
        for child in part.get("parts", []) or []:
            walk(child)

    walk(message.get("payload", {}))
    return found


def download_attachment(access_token: str, message_id: str, attachment_id: str) -> bytes:
    res = requests.get(
        f"{GMAIL_API}/messages/{message_id}/attachments/{attachment_id}",
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=60,
    )
    res.raise_for_status()
    data = res.json()["data"]
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))
