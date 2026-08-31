// Period-key resolution. Read docs/cardledger-build-spec.md §3 before
// touching this file — card periods are not calendar months, and are not
// the same as each other. UOB One and Citi run on statement months
// (anchored to the card's cycle_day, i.e. statement close day); HSBC
// Revolution runs on calendar months.
//
// A transaction belongs to TWO periods, stored separately and never
// collapsed (§4): `calendar_month` for budgeting, `period_key` for card
// rules. This module only resolves the latter.
//
// Kept behaviourally identical to scripts/lib/period.py. period_test.ts
// covers the day-29/30/31 cases; see the note on month arithmetic below.

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function calendarMonth(txnDate: string): string {
  return txnDate.slice(0, 7); // 'YYYY-MM-DD' -> 'YYYY-MM'
}

/**
 * Parses and range-checks a strict ISO `YYYY-MM-DD` date.
 * Throws on anything else — `Date.parse` is far too permissive to trust
 * on a value that ends up as a permanent `period_key` in the ledger.
 */
export function parseIsoDate(txnDate: string): { year: number; month: number; day: number } {
  const match = ISO_DATE.exec(txnDate);
  if (!match) throw new Error(`txn_date '${txnDate}' is not a strict ISO YYYY-MM-DD date`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) throw new Error(`txn_date '${txnDate}' has an out-of-range month`);
  if (day < 1 || day > daysInMonth(year, month)) {
    throw new Error(`txn_date '${txnDate}' is not a real calendar date`);
  }
  return { year, month, day };
}

export function isValidIsoDate(txnDate: string): boolean {
  try {
    parseIsoDate(txnDate);
    return true;
  } catch {
    return false;
  }
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Resolves the statement/calendar period a transaction falls into for a
 * given card, as `${methodId}:YYYY-MM`.
 *
 * For period_type = 'statement', cycle_day is the statement close day.
 * A transaction on or before the close day belongs to the statement
 * closing that month; after it, to the statement closing next month.
 *
 * Month arithmetic is done on (year, month) integers and NOT with
 * Date.setUTCMonth. setUTCMonth preserves the day-of-month, so
 * 2026-01-31 + 1 month overflows into March — which silently assigned
 * every month-end transaction to the wrong statement month, permanently,
 * because reconcile never rewrites period_key.
 *
 * uob_one's cycle_day is unknown until a real statement is read (§5, §12
 * item 6) — this returns `${methodId}:pending` in that case rather than
 * guessing, so ingestion doesn't stall waiting on it. Once cycle_day is
 * set, a backfill pass must re-resolve any 'pending' rows.
 */
export function resolvePeriodKey(
  methodId: string,
  periodType: "calendar" | "statement",
  cycleDay: number | null,
  txnDate: string,
): string {
  const { year, month, day } = parseIsoDate(txnDate);

  if (periodType === "calendar") {
    return `${methodId}:${calendarMonth(txnDate)}`;
  }

  if (cycleDay == null) {
    return `${methodId}:pending`;
  }

  let periodYear = year;
  let periodMonth = month;
  if (day > cycleDay) {
    periodMonth += 1;
    if (periodMonth > 12) {
      periodMonth = 1;
      periodYear += 1;
    }
  }
  return `${methodId}:${periodYear}-${String(periodMonth).padStart(2, "0")}`;
}
