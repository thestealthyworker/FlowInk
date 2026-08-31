// Tests for period.ts. Run: deno test supabase/functions/_shared/period_test.ts
//
// See docs/cardledger-build-spec.md §3 — the trap that will break this
// system if got wrong. UOB One and Citi Cash Back are statement-month
// based (anchored to cycle_day); HSBC Revolution is calendar-month based.
//
// Mirrors tests/test_period.py (scripts/lib/period.py), kept behaviourally
// identical per the comment at the top of period.ts.

import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { calendarMonth, isValidIsoDate, parseIsoDate, resolvePeriodKey } from "./period.ts";

Deno.test("calendarMonth extracts YYYY-MM", () => {
  assertEquals(calendarMonth("2026-09-18"), "2026-09");
});

Deno.test("calendar period ignores cycle_day", () => {
  // HSBC Revolution: calendar months, cycle_day is irrelevant/null.
  assertEquals(resolvePeriodKey("hsbc_revo", "calendar", null, "2026-09-30"), "hsbc_revo:2026-09");
  assertEquals(resolvePeriodKey("hsbc_revo", "calendar", null, "2026-10-01"), "hsbc_revo:2026-10");
});

Deno.test("statement period before close day stays in current month", () => {
  // cycle_day = 25: a txn on the 10th belongs to the statement closing this month.
  assertEquals(resolvePeriodKey("citi_cashback", "statement", 25, "2026-09-10"), "citi_cashback:2026-09");
});

Deno.test("statement period after close day rolls to next month", () => {
  assertEquals(resolvePeriodKey("citi_cashback", "statement", 25, "2026-09-28"), "citi_cashback:2026-10");
});

Deno.test("statement period rolls over year boundary", () => {
  assertEquals(resolvePeriodKey("citi_cashback", "statement", 25, "2026-12-28"), "citi_cashback:2027-01");
});

Deno.test("statement period unknown cycle_day is pending, not a guess", () => {
  // uob_one's cycle_day is unknown until a real statement is read (§5, §12
  // item 6) — must not silently guess a period.
  assertEquals(resolvePeriodKey("uob_one", "statement", null, "2026-09-10"), "uob_one:pending");
});

// The case whose absence let the original bug ship: a transaction on day
// 29, 30 or 31 of a long month, rolling into a SHORTER following month.
// `Date.setUTCMonth` preserves the day-of-month rather than clamping it,
// so Jan 31 + 1 month overflows past Feb's 28/29 days into March — see
// the note in period.ts. resolvePeriodKey does pure (year, month) integer
// arithmetic specifically to avoid that; these confirm it actually does.
Deno.test("day 31 in January rolls into February, not March (non-leap year)", () => {
  // 2026 is not a leap year; Feb 2026 has 28 days. cycle_day = 1 forces
  // every day-of-month > 1 to roll to the next statement month.
  assertEquals(resolvePeriodKey("citi_cashback", "statement", 1, "2026-01-31"), "citi_cashback:2026-02");
});

Deno.test("day 30 in a 31-day month rolls into a 28-day February, not overflowing", () => {
  assertEquals(resolvePeriodKey("citi_cashback", "statement", 5, "2026-01-30"), "citi_cashback:2026-02");
});

Deno.test("day 29 in January rolls into February in a leap year without overflowing to March", () => {
  // 2028 is a leap year (Feb has 29 days) — still shorter than January's
  // 31, still must not overflow.
  assertEquals(resolvePeriodKey("citi_cashback", "statement", 10, "2028-01-29"), "citi_cashback:2028-02");
});

Deno.test("day 31 in a 31-day month with a late cycle_day stays put, no false rollover", () => {
  // day (31) is NOT greater than cycle_day (31), so this must stay in the
  // same statement month — guards the boundary condition itself, not just
  // the overflow.
  assertEquals(resolvePeriodKey("citi_cashback", "statement", 31, "2026-01-31"), "citi_cashback:2026-01");
});

Deno.test("parseIsoDate rejects a non-existent calendar date", () => {
  assertThrows(() => parseIsoDate("2026-02-30"));
});

Deno.test("parseIsoDate rejects a malformed string", () => {
  assertThrows(() => parseIsoDate("2026/09/18"));
});

Deno.test("isValidIsoDate is true for a real date and false for a fake one", () => {
  assertEquals(isValidIsoDate("2026-09-18"), true);
  assertEquals(isValidIsoDate("2026-02-30"), false);
});
