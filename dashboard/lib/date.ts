// Calendar-month helper shared by every page that defaults to "this
// month" (§4: budgets and spend analysis run on calendar months,
// independent of any card's statement cycle — never derive this from a
// card's period_key). Uses UTC field extraction on a Date constructed
// from the current instant; the SGT/UTC offset (+8, no DST) never moves
// the calendar date far enough to matter for a month boundary except in
// the last ~8 hours of a UTC day, which is an acceptable approximation
// for a dashboard default — the operator can always type a different
// month into the query string later if this ever lands on the wrong side
// of midnight SGT.
export function currentCalendarMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function parseCalendarMonth(calendarMonth: string): { year: number; month: number } {
  const [year, month] = calendarMonth.split("-").map(Number);
  return { year: year ?? 1970, month: month ?? 1 };
}

/** Number of calendar days in a 'YYYY-MM' month. */
export function daysInCalendarMonth(calendarMonth: string): number {
  const { year, month } = parseCalendarMonth(calendarMonth);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Days elapsed so far in `calendarMonth`. For the current month, this is
 * today's date-of-month; for a month fully in the past it is the whole
 * month; for a month in the future it is 0 — used to derive a projected
 * month-end figure for the budget hero (§2 of the dashboard plan), never
 * a card's statement cycle.
 */
export function daysElapsedInCalendarMonth(calendarMonth: string): number {
  const now = currentCalendarMonth();
  const totalDays = daysInCalendarMonth(calendarMonth);
  if (calendarMonth < now) return totalDays;
  if (calendarMonth > now) return 0;
  return new Date().getUTCDate();
}

export function daysRemainingInCalendarMonth(calendarMonth: string): number {
  return Math.max(0, daysInCalendarMonth(calendarMonth) - daysElapsedInCalendarMonth(calendarMonth));
}

/** Naive linear projection: what the month-end total looks like if the
 * average daily rate so far continues. Explicitly a projection, never
 * rendered as a confirmed figure (§4's honesty rule applies to derived
 * numbers too, not only raw ones). */
export function projectedMonthEnd(totalSoFar: number, calendarMonth: string): number | null {
  const elapsed = daysElapsedInCalendarMonth(calendarMonth);
  if (elapsed <= 0) return null;
  const totalDays = daysInCalendarMonth(calendarMonth);
  return (totalSoFar / elapsed) * totalDays;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Human label for a 'YYYY-MM' string, e.g. "August 2026". */
export function calendarMonthLabel(calendarMonth: string): string {
  const { year, month } = parseCalendarMonth(calendarMonth);
  return `${MONTH_NAMES[month - 1] ?? calendarMonth} ${year}`;
}

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Three-letter month abbreviation for a 'YYYY-MM' string, e.g. "Aug" —
 * shared by every chart/KPI that labels a month compactly. */
export function calendarMonthAbbr(calendarMonth: string): string {
  const { month } = parseCalendarMonth(calendarMonth);
  return MONTH_ABBR[month - 1] ?? calendarMonth;
}

/** The `count` calendar months ending at (and including) `throughMonth`,
 * oldest first — used for the first-run panel's trailing-actuals view. */
export function trailingCalendarMonths(throughMonth: string, count: number): string[] {
  const { year, month } = parseCalendarMonth(throughMonth);
  const months: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(year, month - 1 - i, 1));
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return months;
}

/** The single calendar month immediately before `calendarMonth` — used by
 * the home view's month-to-date comparison (never derived by slicing
 * `trailingCalendarMonths`'s generic-array result, which loses its known
 * length under `noUncheckedIndexedAccess`). */
export function previousCalendarMonth(calendarMonth: string): string {
  const { year, month } = parseCalendarMonth(calendarMonth);
  const d = new Date(Date.UTC(year, month - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
