// Tests for merchant.ts. Run: deno test supabase/functions/_shared/merchant_test.ts
//
// Mirrors tests/test_merchant.py (scripts/lib/merchant.py). Also covers
// the empty/short-pattern catch-all defect (item 6, code review): a
// punctuation-only merchant string normalises to "", and an unguarded
// `"ANYTHING".includes("")` would make that row match everything.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { findMerchant, isUsableMatchPattern, normalizeMerchant, type MerchantRow } from "./merchant.ts";

// The line-wrap artefact from the confirmed PayLah sample (§4 parser trap 5).
const PAYLAH_MERCHANT_RAW = "N.N.HARBOURLIGHT BISTRO PTE. LT\nD.";

function merchant(overrides: Partial<MerchantRow> & Pick<MerchantRow, "id" | "match_pattern">): MerchantRow {
  return {
    display_name: overrides.match_pattern,
    category: "other",
    hsbc_eligible: null,
    is_transfer: false,
    confidence: "guessed",
    ...overrides,
  };
}

Deno.test("normalizeMerchant strips punctuation and collapses whitespace", () => {
  assertEquals(normalizeMerchant(PAYLAH_MERCHANT_RAW), "N N HARBOURLIGHT BISTRO");
});

Deno.test("normalizeMerchant strips corporate suffixes", () => {
  assertEquals(normalizeMerchant("Chrono24 GmbH"), "CHRONO24");
  assertEquals(normalizeMerchant("Acme Pte Ltd"), "ACME");
});

Deno.test("normalizeMerchant is idempotent and uppercase", () => {
  const once = normalizeMerchant("TikTok Shop Seller");
  assertEquals(once, normalizeMerchant(once));
  assertEquals(once, once.toUpperCase());
});

Deno.test("findMerchant matches the seeded HARBOURLIGHT row", () => {
  const merchants: MerchantRow[] = [
    merchant({ id: 1, match_pattern: "TIKTOK SHOP", category: "online" }),
    merchant({ id: 2, match_pattern: "CHRONO24", category: "retail" }),
    merchant({ id: 3, match_pattern: "HARBOURLIGHT", category: "dining" }),
  ];
  const normalized = normalizeMerchant(PAYLAH_MERCHANT_RAW);
  const match = findMerchant(merchants, normalized);
  assertEquals(match?.id, 3);
});

Deno.test("findMerchant returns null for an unknown merchant", () => {
  const merchants: MerchantRow[] = [merchant({ id: 1, match_pattern: "TIKTOK SHOP" })];
  assertEquals(findMerchant(merchants, normalizeMerchant("Some New Cafe Pte Ltd")), null);
});

Deno.test("findMerchant prefers the longer pattern", () => {
  const merchants: MerchantRow[] = [
    merchant({ id: 1, match_pattern: "SHOP" }),
    merchant({ id: 2, match_pattern: "TIKTOK SHOP" }),
  ];
  const match = findMerchant(merchants, normalizeMerchant("TikTok Shop Seller"));
  assertEquals(match?.id, 2);
});

Deno.test("findMerchant does not mid-token substring match ('CAT' must not match 'CATERING')", () => {
  const merchants: MerchantRow[] = [merchant({ id: 1, match_pattern: "CAT" })];
  assertEquals(findMerchant(merchants, normalizeMerchant("Catering Co")), null);
});

Deno.test("normalizeMerchant on a punctuation-only string normalises to empty", () => {
  assertEquals(normalizeMerchant("..."), "");
  assertEquals(normalizeMerchant("&"), "");
  assertEquals(normalizeMerchant("--"), "");
});

Deno.test("isUsableMatchPattern rejects empty and near-empty normalised strings", () => {
  assertEquals(isUsableMatchPattern(""), false);
  assertEquals(isUsableMatchPattern("A"), false);
  assertEquals(isUsableMatchPattern("AB"), false);
  assertEquals(isUsableMatchPattern("ABC"), true);
});

Deno.test("findMerchant ignores an unusable (empty/short) match_pattern even if present in the table", () => {
  // Defensive: even if a catch-all row somehow made it into the table
  // (e.g. written before this guard existed), findMerchant must not use
  // it to classify everything.
  const merchants: MerchantRow[] = [
    merchant({ id: 1, match_pattern: "", is_transfer: true }),
    merchant({ id: 2, match_pattern: "AB", is_transfer: true }),
  ];
  assertEquals(findMerchant(merchants, normalizeMerchant("Totally Unrelated Merchant")), null);
});

// ============ digit-run stripping (backfill Fix 2a) ============

Deno.test("normalizeMerchant strips standalone long digit-run reference numbers", () => {
  // Real backfill data: a different 9-digit ride id on every BUS/MRT row.
  assertEquals(normalizeMerchant("BUS/MRT 833948420 SINGAPORE"), "BUS MRT SINGAPORE");
  assertEquals(normalizeMerchant("BUS/MRT 836727704 SINGAPORE"), "BUS MRT SINGAPORE");
});

Deno.test("normalizeMerchant does not strip short digit runs in merchant names", () => {
  // Collateral-damage guard: a merchant whose name legitimately contains
  // digits must not be mangled just because it also contains a number.
  assertEquals(normalizeMerchant("HH @ 602 TAMPINES Singapore"), "HH 602 TAMPINES SINGAPORE");
  assertEquals(normalizeMerchant("7-ELEVEN -LUCKY PLAZA Singapore"), "7 ELEVEN LUCKY PLAZA SINGAPORE");
  assertEquals(normalizeMerchant("247 FITNESS SINGAPORE SINGAPORE"), "247 FITNESS SINGAPORE SINGAPORE");
});

// ============ statement truncation collapse (backfill Fix 2b) ============

Deno.test("normalizeMerchant collapses the HSBC-truncated Sheng Siong spelling to UOB's full spelling", () => {
  const hsbcVariant = normalizeMerchant("SHENG SIONG SUPERMARKE SINGAPORE   SG");
  const uobVariant = normalizeMerchant("SHENG SIONG SUPERMARKET -SINGAPORE");
  assertEquals(hsbcVariant, "SHENG SIONG SUPERMARKET SINGAPORE");
  assertEquals(uobVariant, "SHENG SIONG SUPERMARKET SINGAPORE");
});
