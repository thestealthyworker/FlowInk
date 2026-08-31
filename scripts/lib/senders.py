"""Exact-domain sender allowlist for statement email routing.

docs/cardledger-build-spec.md §4 trap 3 and §11. A substring test such as
``"uobgroup.com" in sender`` is not a sender check: an attacker who owns
``attacker.io`` can send from ``statements@uobgroup.com.attacker.io``,
pass SPF/DKIM/DMARC legitimately for their own domain, and be routed to a
real card. Statement rows are written as ``status='confirmed'``, which the
spec designates as truth, so a bad route here corrupts the ledger.

So: parse the address out of the ``From`` header and compare the domain to
the right of the final ``@`` against an exact allowlist. No substring, no
suffix, no subdomain wildcard.

The Gmail ``from:`` operator is token-based and also matches lookalike
subdomains, so the query built here is only a cheap pre-filter. The
authoritative check is :func:`method_id_for_sender`, applied to every
message after it is fetched.
"""
from __future__ import annotations

import os
import re
from email.utils import getaddresses

# domain -> payment_methods.id. Exact match only.
# Citi's real statement sender is unknown until the card is issued (§13
# item 2); both published Citibank Singapore domains are listed so the
# route exists the day it arrives, and STATEMENT_SENDER_DOMAINS can add
# more without a code change if the real one differs.
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


def statement_sender_domains(env: dict[str, str] | None = None) -> dict[str, str]:
    """The active allowlist. ``STATEMENT_SENDER_DOMAINS`` replaces the default."""
    env = os.environ if env is None else env
    raw = (env.get(_ENV_VAR) or "").strip()
    if not raw:
        return dict(DEFAULT_STATEMENT_SENDER_DOMAINS)
    parsed = parse_domain_map(raw)
    return parsed or dict(DEFAULT_STATEMENT_SENDER_DOMAINS)


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
