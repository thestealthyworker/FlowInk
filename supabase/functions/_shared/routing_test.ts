// WP2 (design/ingestion-routing.md): explicit, named regression tests for
// the anti-spoofing sender-domain check now that it is array-membership
// against a DB-sourced `payment_methods.alert_senders` instead of a
// hardcoded single-domain `===`. Build spec §4 trap 3: "a wrong
// transaction is worse than a missing one" — these are not incidental
// coverage, they are the specific cases the task brief calls out.
//
// Run: deno test --allow-env supabase/functions/_shared/routing_test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildLabelClause,
  buildLabelIdToMethod,
  senderDomainIsTrusted,
  type RoutablePaymentMethod,
} from "./routing.ts";

// ---------- senderDomainIsTrusted: the security-critical checks ----------

Deno.test("senderDomainIsTrusted: empty alert_senders array rejects (fails closed, never silently passes)", () => {
  // Today's behaviour for "no expected domain configured" (the old
  // `!expectedDomain` branch) was reject. An empty array is the array
  // shape's equivalent of that same state and MUST reject identically.
  assertEquals(senderDomainIsTrusted("uobgroup.com", []), false);
});

Deno.test("senderDomainIsTrusted: missing (null) alert_senders rejects (fails closed, never silently passes)", () => {
  assertEquals(senderDomainIsTrusted("uobgroup.com", null), false);
});

Deno.test("senderDomainIsTrusted: undefined alert_senders rejects (fails closed, never silently passes)", () => {
  assertEquals(senderDomainIsTrusted("uobgroup.com", undefined), false);
});

Deno.test("senderDomainIsTrusted: rejects the lookalike-subdomain attack (uobgroup.com.attacker.io does not match a configured uobgroup.com)", () => {
  // The exact attack build spec §4 trap 3 describes: attacker.io owns its
  // own domain and can legitimately pass SPF/DKIM/DMARC for it while using
  // a subdomain that *contains* the bank's real domain as a substring.
  // Naive substring/endsWith matching would pass this; exact array
  // membership must not.
  assertEquals(
    senderDomainIsTrusted("uobgroup.com.attacker.io", ["uobgroup.com"]),
    false,
  );
});

Deno.test("senderDomainIsTrusted: rejects other substring/suffix lookalike variants", () => {
  assertEquals(senderDomainIsTrusted("notuobgroup.com", ["uobgroup.com"]), false);
  assertEquals(senderDomainIsTrusted("uobgroup.com.au", ["uobgroup.com"]), false);
  assertEquals(senderDomainIsTrusted("evil-uobgroup.com", ["uobgroup.com"]), false);
});

Deno.test("senderDomainIsTrusted: accepts an exact match against a single-entry allowlist", () => {
  assertEquals(senderDomainIsTrusted("uobgroup.com", ["uobgroup.com"]), true);
});

Deno.test("senderDomainIsTrusted: accepts an exact match against any entry in a multi-domain allowlist (Citi's two candidate domains)", () => {
  const citiDomains = ["citibank.com.sg", "citi.com"];
  assertEquals(senderDomainIsTrusted("citibank.com.sg", citiDomains), true);
  assertEquals(senderDomainIsTrusted("citi.com", citiDomains), true);
});

Deno.test("senderDomainIsTrusted: a multi-domain allowlist still rejects a lookalike of ANY of its entries", () => {
  const citiDomains = ["citibank.com.sg", "citi.com"];
  assertEquals(senderDomainIsTrusted("citi.com.attacker.io", citiDomains), false);
  assertEquals(senderDomainIsTrusted("citibank.com.sg.attacker.io", citiDomains), false);
});

Deno.test("senderDomainIsTrusted: null actualDomain (unparseable/multi-address From header) rejects even with valid config", () => {
  assertEquals(senderDomainIsTrusted(null, ["uobgroup.com"]), false);
});

Deno.test("senderDomainIsTrusted: an unrelated known domain does not match a different method's allowlist", () => {
  assertEquals(senderDomainIsTrusted("dbs.com", ["uobgroup.com"]), false);
});

// ---------- buildLabelIdToMethod / buildLabelClause: routing-table construction ----------

const SAMPLE_METHODS: RoutablePaymentMethod[] = [
  { id: "uob_one", alert_label: "Payments/UOB", alert_senders: ["uobgroup.com"] },
  { id: "hsbc_revo", alert_label: "Payments/HSBC", alert_senders: ["notification.hsbc.com.hk"] },
  { id: "paylah", alert_label: "Payments/PayLah", alert_senders: ["dbs.com"] },
  // citi_cashback: not yet issued, sender unconfirmed — alert_label is set
  // (the Gmail filter exists) but alert_senders is NULL, matching today's
  // deliberate omission (index.ts's original comment).
  { id: "citi_cashback", alert_label: "Payments/Citi", alert_senders: null },
];

Deno.test("buildLabelIdToMethod maps configured labels to their method id", () => {
  const labelNameToId: Record<string, string> = {
    "Payments/UOB": "label-1",
    "Payments/HSBC": "label-2",
    "Payments/PayLah": "label-3",
    "Payments/Citi": "label-4",
  };
  const result = buildLabelIdToMethod(SAMPLE_METHODS, labelNameToId);
  assertEquals(result, {
    "label-1": "uob_one",
    "label-2": "hsbc_revo",
    "label-3": "paylah",
    "label-4": "citi_cashback",
  });
});

Deno.test("buildLabelIdToMethod skips a method with no alert_label configured", () => {
  const methods: RoutablePaymentMethod[] = [
    { id: "uob_one", alert_label: "Payments/UOB", alert_senders: ["uobgroup.com"] },
    { id: "new_card", alert_label: null, alert_senders: null },
  ];
  const result = buildLabelIdToMethod(methods, { "Payments/UOB": "label-1" });
  assertEquals(result, { "label-1": "uob_one" });
});

Deno.test("buildLabelIdToMethod skips a configured alert_label the Gmail account has no matching label for", () => {
  const result = buildLabelIdToMethod(SAMPLE_METHODS, { "Payments/UOB": "label-1" });
  assertEquals(result, { "label-1": "uob_one" });
});

Deno.test("buildLabelClause builds a label: OR clause from every configured alert_label, space-replaced", () => {
  const clause = buildLabelClause(SAMPLE_METHODS);
  assertEquals(
    clause,
    "label:Payments/UOB OR label:Payments/HSBC OR label:Payments/PayLah OR label:Payments/Citi",
  );
});

Deno.test("buildLabelClause omits methods with no alert_label configured", () => {
  const methods: RoutablePaymentMethod[] = [
    { id: "uob_one", alert_label: "Payments/UOB", alert_senders: ["uobgroup.com"] },
    { id: "new_card", alert_label: null, alert_senders: null },
  ];
  assertEquals(buildLabelClause(methods), "label:Payments/UOB");
});
