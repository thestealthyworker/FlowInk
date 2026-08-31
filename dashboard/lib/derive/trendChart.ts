import type { MonthlyTotal } from "../data/spend";

// Shared geometry for every hand-built line chart in the app (§3 View 2's
// rolling 12-month total, reused as-is by /cards/tier-3 with a reference
// line added) — one pure layout function, no charting library, consumed
// by a plain SVG in the page/component that renders it.

export interface LineChartPoint {
  calendarMonth: string;
  total: number;
  x: number;
  y: number;
  isFxPending: boolean;
}

export interface LineChartLayout {
  points: LineChartPoint[];
  width: number;
  height: number;
  padX: number;
  padY: number;
  maxValue: number;
  /** y-coordinate for a given money value, using the same scale as the
   * plotted points — used to place a fixed reference line (e.g. the
   * Tier-3 S$2,000 threshold) on the identical axis. */
  yFor: (value: number) => number;
}

export function buildLineChartLayout(
  months: MonthlyTotal[],
  fxPendingMonths: Set<string>,
  options: { width?: number; height?: number; padX?: number; padY?: number; minMax?: number } = {}
): LineChartLayout {
  const width = options.width ?? 640;
  const height = options.height ?? 200;
  const padX = options.padX ?? 24;
  const padY = options.padY ?? 20;
  const plotW = width - padX * 2;
  const plotH = height - padY * 2;

  const maxValue = Math.max(...months.map((m) => m.total), options.minMax ?? 0, 1);

  const yFor = (value: number) => padY + plotH - (Math.min(value, maxValue) / maxValue) * plotH;

  const points: LineChartPoint[] = months.map((m, i) => ({
    calendarMonth: m.calendar_month,
    total: m.total,
    x: months.length === 1 ? padX + plotW / 2 : padX + (i / (months.length - 1)) * plotW,
    y: yFor(m.total),
    isFxPending: fxPendingMonths.has(m.calendar_month),
  }));

  return { points, width, height, padX, padY, maxValue, yFor };
}

/** The single lowest-spend month in a series — the Tier-3 record's entire
 * point (§3 View 5): "is committing to Tier 3 safe" is answered by this
 * one number. Ties keep the earliest month (stable, deterministic). */
export function findLowestMonth(months: MonthlyTotal[]): MonthlyTotal | null {
  if (months.length === 0) return null;
  return months.reduce((min, m) => (m.total < min.total ? m : min), months[0] as MonthlyTotal);
}
