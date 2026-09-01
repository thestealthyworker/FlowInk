"""Exact-domain sender allowlist for statement email routing.

See docs/architecture.md §5 ("Routing is data, not code" — the
`alert_senders`/`statement_senders` exact-domain arrays this module
resolves against) and §10 (security model). The old build spec's "trap 3"
enumeration this citation used to point at does not survive under that
number in docs/reference-example-sg.md's current parser-traps list, so
the anti-spoofing rationale below is preserved here rather than cited
elsewhere: a substring test such as ``"uobgroup.com" in sender`` is not a
sender check: an attacker who owns ``attacker.io`` can send from
``statements@uobgroup.com.attacker.io``, pass SPF/DKIM/DMARC legitimately
for their own domain, and be routed to a real card. Statement rows are
written as ``status='confirmed'``, which the schema treats as truth, so a
bad route here corrupts the ledger.

So: parse the address out of the ``From`` header and compare the domain to
the right of the final ``@`` against an exact allowlist. No substring, no
suffix, no subdomain wildcard.

The Gmail ``from:`` operator is token-based and also matches lookalike
subdomains, so the query built here is only a cheap pre-filter. The
authoritative check is :func:`method_id_for_sender`, applied to every
message after it is fetched.

WP2 (design/ingestion-routing.md): this module's mapping used to be a
single hardcoded ``DEFAULT_STATEMENT_SENDER_DOMAINS`` dict — the *only*
routing table the statement path knew, and one that had already drifted
from the alert path's (TS) ``SENDER_DOMAINS``: this file additionally
guessed ``citibank.com.sg``/``citi.com`` for Citi, which the TS side
deliberately omitted. :func:`statement_sender_domains` now reads
``payment_methods.statement_senders`` live via the caller's
``SupabaseREST`` client (the same one ``ingest_statements.py`` already
constructs) when one is supplied — that is the actual production default
now, and it is the *same table* ``ingest-alerts/index.ts`` reads for the
alert path's ``alert_senders``. ``DEFAULT_STATEMENT_SENDER_DOMAINS`` below
is kept only as a fallback for callers with no DB client available (pure
offline unit tests, mainly) — ``ingest_statements.py`` always passes a
``db``, so this fallback is never reached in production.
"""
from __future__ import annotations

import os
import re
from email.utils import getaddresses
from typing import Protocol

# Fallback only — see module docstring. NOT the production source of
# truth any more; that is payment_methods.statement_senders, read via
# domains_from_payment_methods() below. Used when statement_sender_domains()
# is called with no env override and no db client (offline/pure-logic
# tests, or a caller that hasn't been wired up to a db client yet).
DEFAULT_STATEMENT_SENDER_DOMAINS: dict[str, str] = {
    "uobgroup.com": "uob_one",
    "citibank.com.sg": "citi_cashback",
    "citi.com": "citi_cashback",
    "hsbc.com.sg": "hsbc_revo",
}

# Hostnames are ASCII-only here by construction: a unicode or punycode
# lookalike (аttacker.io with a Cyrillic 'а', or xn--...) must never
# compare equal to an allowlisted domain, so anything outside this class
# is rejected rather than normalised.
_DOMAIN_RE = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$")

_ENV_VAR = "STATEMENT_SENDER_DOMAINS"


def is_valid_domain_syntax(domain: str) -> bool:
    """Domain-SYNTAX validator: is ``domain`` shaped like a plausible DNS
    hostname? This is NOT a trust/routing decision — a syntactically valid
    domain (e.g. ``uobgroup.com.attacker.io``) can still be exactly the
    lookalike-subdomain attack this module's docstring describes; that is
    rejected separately, by exact-match allowlist comparison in
    :func:`method_id_for_sender`, not by this function.

    Exposed as a public function (unlike the underlying ``_DOMAIN_RE`` it
    wraps) so both this module's own callers and the onboarding-wizard
    input-validation path (design/onboarding.md) use the identical check,
    and so it can be asserted against the shared
    ``tests/fixtures/domain-validation-cases.json`` cases alongside its
    TypeScript port (``routing.ts``'s ``isValidDomainSyntax``) — see WP2
    (design/ingestion-routing.md §3).

    Expects an already-lowercased, already-trailing-dot-stripped input,
    matching how every existing call site in this module normalises before
    matching (this function does not normalise for you).
    """
    return bool(_DOMAIN_RE.match(domain))


class _SupportsSelect(Protocol):
    """The one method domains_from_payment_methods() needs from a db
    client — structural, not a hard dependency on lib.supabase_rest, so a
    test can pass any object (even a plain fake) that shapes up like this."""

    def select(self, table: str, params: dict[str, object]) -> list[dict]: ...


def domains_from_payment_methods(db: _SupportsSelect) -> dict[str, str]:
    """Build ``{domain: method_id}`` from ``payment_methods.statement_senders``.

    This is the single source of truth ``ingest_statements.py`` reads by
    default (via :func:`statement_sender_domains`) — the same table
    ``ingest-alerts/index.ts`` reads for the alert path's
    ``alert_senders``, closing the drift this module's docstring
    describes.

    A DB read failure (network error, bad credentials, ...) is allowed to
    propagate rather than being swallowed into an empty mapping: silently
    falling back to a stale hardcoded table here would reintroduce exactly
    the drift this change exists to remove, and silently returning ``{}``
    on a genuine outage would be indistinguishable from "no cards
    configured yet", which is itself a real, valid state this function can
    return (a fresh deployment with no routing configured at all). The
    caller (``ingest_statements.py``) fails loudly (non-zero exit) on an
    unhandled exception here, which is correct: this is a startup-time
    dependency, not a per-message one.

    A method row with a null/missing ``statement_senders`` (e.g. PayLah,
    which has no statement source at all) contributes nothing — exactly
    today's behaviour, where such a method is simply absent from the map.
    """
    rows = db.select("payment_methods", {"select": "id,statement_senders"})
    mapping: dict[str, str] = {}
    for row in rows:
        method_id = row.get("id")
        if not method_id:
            continue
        for raw_domain in row.get("statement_senders") or []:
            domain = (raw_domain or "").strip().lower().rstrip(".")
            if domain and _DOMAIN_RE.match(domain):
                mapping[domain] = method_id
    return mapping


def parse_domain_map(raw: str) -> dict[str, str]:
    """Parse ``domain=method_id,domain=method_id`` into a mapping.

    Entries that are malformed, or whose domain fails :data:`_DOMAIN_RE`,
    are dropped rather than half-trusted.
    """
    mapping: dict[str, str] = {}
    for entry in raw.split(","):
        domain, sep, method_id = entry.partition("=")
        if not sep:
            continue
        domain = domain.strip().lower().rstrip(".")
        method_id = method_id.strip()
        if not method_id or not _DOMAIN_RE.match(domain):
            continue
        mapping[domain] = method_id
    return mapping


def statement_sender_domains(
    env: dict[str, str] | None = None,
    db: _SupportsSelect | None = None,
) -> dict[str, str]:
    """The active allowlist.

    Priority order:

    1. ``STATEMENT_SENDER_DOMAINS`` env var, if set and parses to at least
       one valid entry — a deploy-time escape hatch for local/CI testing
       without touching the database, kept exactly as before.
    2. Otherwise, if a ``db`` client is supplied: a live read of
       ``payment_methods.statement_senders`` (:func:`domains_from_payment_methods`)
       — the production default as of WP2 (design/ingestion-routing.md).
       ``ingest_statements.py`` always passes ``db``, so this is the path
       every real run takes.
    3. Otherwise (no env override, no db client): the hardcoded
       :data:`DEFAULT_STATEMENT_SENDER_DOMAINS` fallback, for callers that
       have no database available — mainly pure offline unit tests.
    """
    env = os.environ if env is None else env
    raw = (env.get(_ENV_VAR) or "").strip()
    if raw:
        parsed = parse_domain_map(raw)
        if parsed:
            return parsed
    if db is not None:
        return domains_from_payment_methods(db)
    return dict(DEFAULT_STATEMENT_SENDER_DOMAINS)


def sender_domain(from_header: str | None) -> str | None:
    """Return the domain of the single address in a ``From`` header.

    Returns ``None`` for a missing header, for a header carrying anything
    other than exactly one address (RFC 5322 permits a list; a statement
    never uses one, and an ambiguous sender is not a trusted sender), and
    for any domain that is not plain ASCII DNS.

    A display name is never consulted, so
    ``"statements@uobgroup.com" <billing@attacker.io>`` resolves to
    ``attacker.io``.
    """
    if not from_header:
        return None
    addresses = [addr for _name, addr in getaddresses([from_header]) if addr]
    if len(addresses) != 1:
        return None
    addr = addresses[0].strip().lower()
    if addr.count("@") != 1:
        return None
    domain = addr.rsplit("@", 1)[1].rstrip(".")
    if not _DOMAIN_RE.match(domain):
        return None
    return domain


def method_id_for_sender(
    from_header: str | None,
    domain_map: dict[str, str] | None = None,
) -> str | None:
    """Route a ``From`` header to a payment_methods.id, or ``None``.

    ``None`` means "do not guess" (§4 trap 3): the caller must record a
    failure and skip the message.
    """
    domain = sender_domain(from_header)
    if domain is None:
        return None
    mapping = statement_sender_domains() if domain_map is None else domain_map
    return mapping.get(domain)


def reconcilable_method_ids(domain_map: dict[str, str] | None = None) -> frozenset[str]:
    """Methods that have a statement source, and so a reconciliation path.

    Anything outside this set (PayLah above all) can never produce a
    statement row, so its provisional rows can never match and must never
    be reversed as stale — see reconcile.py.
    """
    mapping = statement_sender_domains() if domain_map is None else domain_map
    return frozenset(mapping.values())


def gmail_sender_prefilter(domain_map: dict[str, str] | None = None) -> str:
    """Gmail ``from:`` clause for the allowlisted domains.

    Non-authoritative: Gmail matches lookalike subdomains here. Narrowing
    the fetch is all this is for.
    """
    mapping = statement_sender_domains() if domain_map is None else domain_map
    domains = sorted(set(mapping))
    return "(" + " OR ".join(f"from:{d}" for d in domains) + ")"
