import type { CategorySpendDetail, MonthlyTotal } from "../data/spend";

// Pure presentation-layer logic for the three home-view KPI cards
// (operator's own request: "largest spend by month," "total spent this
// month vs last month," "top 3 categories spent"). No Supabase calls here
// — every function takes data the page has already fetched.

export interface LargestMonth {
  calendarMonth: string;
  total: number;
  /** True when the largest month on record is also the still-in-progress
   * current month — a record that could still be overtaken by month end,
   * not a settled fact, so the card must say so rather than presenting it
   * as final. */
  isPartial: boolean;
}

/** The single highest-spend month in `months` — ties keep the earlier
 * month (stable, deterministic). Returns null for an empty series (a
 * brand-new ledger with no months yet). */
export function findLargestMonth(months: MonthlyTotal[], currentCalendarMonth: string): LargestMonth | null {
  if (months.length === 0) return null;

  const peak = months.reduce((max, m) => (m.total > max.total ? m : max), months[0] as MonthlyTotal);

  return {
    calendarMonth: peak.calendar_month,
    total: peak.total,
    isPartial: peak.calendar_month === currentCalendarMonth,
  };
}

export type ComparisonDirection = "up" | "down" | "flat";

export interface MonthComparison {
  currentCalendarMonth: string;
  currentThroughDay: number;
  currentTotal: number;
  previousCalendarMonth: string;
  /** Previous month's spend through the SAME day-of-month as `currentThroughDay`
   * — the like-for-like half of the comparison. Never the previous month's
   * full total; comparing a partial month to a complete one is exactly the
   * misleading collapse this KPI must not produce. */
  previousThroughSameDay: number;
  /** Previous month's actual full-month total, carried separately as
   * context only — always labelled as "full month" wherever it's shown,
   * never blended into the headline delta. */
  previousFullMonth: number | null;
  delta: number;
  deltaPct: number | null;
  direction: ComparisonDirection;
  isCurrentMonthComplete: boolean;
}

const FLAT_EPSILON = 0.005; // sub-half-cent deltas read as "flat," not a false direction

export function buildMonthComparison(input: {
  currentCalendarMonth: string;
  currentThroughDay: number;
  currentDaysInMonth: number;
  currentTotal: number;
  previousCalendarMonth: string;
  previousThroughSameDay: number;
  previousFullMonth: number | null;
}): MonthComparison {
  const delta = input.currentTotal - input.previousThroughSameDay;
  const direction: ComparisonDirection =
    Math.abs(delta) < FLAT_EPSILON ? "flat" : delta > 0 ? "up" : "down";

  return {
    currentCalendarMonth: input.currentCalendarMonth,
    currentThroughDay: input.currentThroughDay,
    currentTotal: input.currentTotal,
    previousCalendarMonth: input.previousCalendarMonth,
    previousThroughSameDay: input.previousThroughSameDay,
    previousFullMonth: input.previousFullMonth,
    delta,
    deltaPct: input.previousThroughSameDay > 0 ? delta / input.previousThroughSameDay : null,
    direction,
    isCurrentMonthComplete: input.currentThroughDay >= input.currentDaysInMonth,
  };
}

export interface TopCategoryRow {
  category: CategorySpendDetail["category"];
  total: number;
  share: number;
  hasGuessedMerchant: boolean;
}

/** Top `n` categories by spend this period — reuses the same detail rows
 * the rest of the home view already fetched (no new query). */
export function topCategories(
  byCategory: CategorySpendDetail[],
  guessedIds: Set<number>,
  n = 3
): TopCategoryRow[] {
  const grandTotal = byCategory.reduce((sum, c) => sum + c.total, 0);

  return [...byCategory]
    .filter((c) => c.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, n)
    .map((c) => ({
      category: c.category,
      total: c.total,
      share: grandTotal > 0 ? c.total / grandTotal : 0,
      hasGuessedMerchant: c.merchantIds.some((id) => guessedIds.has(id)),
    }));
}
