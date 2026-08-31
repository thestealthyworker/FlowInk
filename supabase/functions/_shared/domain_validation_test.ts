// WP2 §3 (design/ingestion-routing.md): asserts the TypeScript
// domain-syntax validator against the shared fixture also asserted
// against by the Python port (tests/test_domain_validation_fixture.py).
//
// The fixture, not this file, is the source of truth for which domain
// strings are valid/invalid — see tests/fixtures/domain-validation-cases.json
// for the full rationale on each case, especially the lookalike-subdomain
// attack case (valid SYNTAX, but must be rejected by the separate
// exact-match routing check — see routing_test.ts).
//
// Run: deno test --allow-read supabase/functions/_shared/domain_validation_test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isValidDomainSyntax } from "./routing.ts";

interface FixtureCase {
  domain: string;
  valid: boolean;
  note?: string;
}

const fixtureUrl = new URL(
  "../../../tests/fixtures/domain-validation-cases.json",
  import.meta.url,
);
const fixtureText = await Deno.readTextFile(fixtureUrl);
const fixture: { cases: FixtureCase[] } = JSON.parse(fixtureText);

Deno.test("domain-validation-cases.json fixture loads and is non-empty", () => {
  if (fixture.cases.length === 0) throw new Error("fixture has no cases");
});

Deno.test("domain-validation-cases.json contains the lookalike-subdomain attack case", () => {
  const domains = fixture.cases.map((c) => c.domain);
  if (!domains.includes("uobgroup.com.attacker.io")) {
    throw new Error("fixture is missing the uobgroup.com.attacker.io case");
  }
});

for (const c of fixture.cases) {
  Deno.test(`isValidDomainSyntax(${JSON.stringify(c.domain)}) === ${c.valid} (${c.note ?? ""})`, () => {
    assertEquals(isValidDomainSyntax(c.domain), c.valid);
  });
}
