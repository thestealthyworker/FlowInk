// WP2 (design/ingestion-routing.md): pure routing logic factored out of
// ingest-alerts/index.ts so it can be unit-tested directly (routing_test.ts)
// rather than only incidentally exercised through the full Deno.serve
// handler. These functions used to be a hardcoded LABEL_TO_METHOD /
// SENDER_DOMAINS pair of constants in index.ts; the routing *decision* is
// unchanged, only its *source* moved to `payment_methods` rows fetched at
// request time.

/** The subset of a payment_methods row this module needs. */
export interface RoutablePaymentMethod {
  id: string;
  alert_label: string | null;
  alert_senders: string[] | null;
}

/**
 * Builds Gmail labelId -> payment_methods.id from live rows, replacing the
 * old hardcoded LABEL_TO_METHOD constant. A method with no alert_label
 * configured (NULL — e.g. citi_cashback today, sender/label not yet
 * confirmed) contributes nothing: it is simply not routable via the alert
 * path yet, exactly as it isn't today.
 */
export function buildLabelIdToMethod(
  methods: RoutablePaymentMethod[],
  labelNameToId: Record<string, string>,
): Record<string, string> {
  const labelIdToMethod: Record<string, string> = {};
  for (const m of methods) {
    if (!m.alert_label) continue;
    const labelId = labelNameToId[m.alert_label];
    if (labelId) labelIdToMethod[labelId] = m.id;
  }
  return labelIdToMethod;
}

/**
 * Gmail query OR-clause built from every configured method's alert_label —
 * same shape as the old LABEL_TO_METHOD-keyed clause (see docs/architecture.md
 * §5, "Routing is data, not code", for the nested-label trap:
 * `label:Parent` does not match sub-labels, so this must enumerate
 * every leaf label explicitly), now driven by the fetched rows so a newly
 * configured label is picked up without a code change or redeploy.
 * A method with no alert_label configured is skipped, same as
 * `buildLabelIdToMethod`.
 */
export function buildLabelClause(methods: RoutablePaymentMethod[]): string {
  return methods
    .map((m) => m.alert_label)
    .filter((label): label is string => !!label)
    .map((name) => `label:${name.replace(/ /g, "-")}`)
    .join(" OR ");
}

/**
 * The anti-spoofing sender-domain check (see docs/architecture.md §5,
 * "Routing is data, not code", and §10, security model — the old build
 * spec's "trap 3 / item 3" this used to cite does not survive under that
 * number in docs/reference-example-sg.md's current parser-traps list).
 * The label identifies the issuer; it does not prove who actually sent the mail — a
 * Gmail filter can be spoofed by anyone who gets a lookalike domain past
 * the recipient's own rules. This is the authoritative check.
 *
 * Generalised from a single `===` comparison against one hardcoded domain
 * to array membership against `payment_methods.alert_senders`, since a
 * method can now legitimately have more than one confirmed sender domain.
 * The security properties are unchanged in kind, not weakened:
 *
 *   - An empty or missing (null/undefined) `expectedDomains` MUST behave
 *     IDENTICALLY to today's "no expected domain configured" branch:
 *     reject, never silently pass. This is the same rule the old code
 *     enforced via `!expectedDomain` — restated for a list instead of a
 *     single optional string, not weakened by the restatement.
 *   - Exact membership only, never substring/suffix/prefix. `actualDomain`
 *     is already the exact parsed domain from `senderDomain()` (gmail.ts),
 *     and `Array.prototype.includes` performs nothing but per-element
 *     strict equality — so a lookalike subdomain like
 *     `uobgroup.com.attacker.io` can never match a configured
 *     `uobgroup.com`: it is a different string, full stop. See
 *     routing_test.ts's "lookalike subdomain" case for the explicit,
 *     named regression test.
 *
 * `actualDomain === null` (an unparseable or multi-address From header)
 * also always rejects — there is nothing to check membership of.
 */
export function senderDomainIsTrusted(
  actualDomain: string | null,
  expectedDomains: string[] | null | undefined,
): boolean {
  if (actualDomain === null) return false;
  if (!expectedDomains || expectedDomains.length === 0) return false;
  return expectedDomains.includes(actualDomain);
}

// WP2 §3 (design/ingestion-routing.md): domain-SYNTAX validator, a
// TypeScript port of scripts/lib/senders.py's `_DOMAIN_RE` /
// `is_valid_domain_syntax`. This is NOT a trust/routing decision — a
// syntactically valid domain (e.g. `uobgroup.com.attacker.io`) can still
// be exactly the lookalike-subdomain attack this file's header comment
// and senders.py's module docstring describe; that is rejected
// separately, by exact-match allowlist comparison in
// `senderDomainIsTrusted` above, not by this function.
//
// The two runtimes cannot share code here (README.md's "four runtimes,
// four stores" framing), so instead they share test CASES:
// tests/fixtures/domain-validation-cases.json, asserted against by both
// this function (domain_validation_test.ts) and the Python copy
// (tests/test_domain_validation_fixture.py) — so they cannot silently
// drift the way LABEL_TO_METHOD and DEFAULT_STATEMENT_SENDER_DOMAINS
// already did before this package.
//
// Expects an already-lowercased, already-trailing-dot-stripped input,
// matching how senders.py's callers normalise before matching — this
// function does not normalise for you.
const DOMAIN_SYNTAX_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function isValidDomainSyntax(domain: string): boolean {
  return DOMAIN_SYNTAX_RE.test(domain);
}
