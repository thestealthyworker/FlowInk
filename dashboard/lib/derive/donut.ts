import { categoryColorVar } from "./seriesColor";
import type { CompositionRow } from "./spendComposition";

// The donut's series shaping. The dataviz skill's own anti-pattern list is
// explicit: "A donut/pie for comparing close values" is wrong, and part-to-
// whole reads honestly only "at a glance, <= 6 segments." The fixed
// category vocabulary has 11 members (12 counting the synthetic
// 'uncategorised' bucket), so the donut folds everything past the top 5
// into one "Everything else" wedge — never a 7th, 8th... generated slot.
// This is a chart-display-only fold: every folded category still gets its
// own row in the table-view twin below the chart, so nothing is hidden,
// only re-grouped for the one visualisation that can't carry 11 wedges.
const MAX_DIRECT_SEGMENTS = 5;
export const FOLD_KEY = "everything-else";

export interface DonutSegment {
  key: string;
  label: string;
  total: number;
  confirmedTotal: number;
  provisionalTotal: number;
  share: number;
  colorVar: string;
  isFold: boolean;
  hasGuessedMerchant: boolean;
  /** Only set on the fold segment — the rows it absorbed, for the legend's
   * "what's inside Everything else" disclosure. */
  folded?: CompositionRow[];
}

export function buildDonutSegments(rows: CompositionRow[]): DonutSegment[] {
  const sorted = [...rows].filter((r) => r.total > 0).sort((a, b) => b.total - a.total);
  const grandTotal = sorted.reduce((sum, r) => sum + r.total, 0);

  if (sorted.length <= MAX_DIRECT_SEGMENTS + 1) {
    return sorted.map((r) => toSegment(r, grandTotal));
  }

  const head = sorted.slice(0, MAX_DIRECT_SEGMENTS);
  const tail = sorted.slice(MAX_DIRECT_SEGMENTS);

  const fold: DonutSegment = {
    key: FOLD_KEY,
    label: "Everything else",
    total: tail.reduce((sum, r) => sum + r.total, 0),
    confirmedTotal: tail.reduce((sum, r) => sum + r.confirmedTotal, 0),
    provisionalTotal: tail.reduce((sum, r) => sum + r.provisionalTotal, 0),
    share: grandTotal > 0 ? tail.reduce((sum, r) => sum + r.total, 0) / grandTotal : 0,
    colorVar: "--series-other",
    isFold: true,
    hasGuessedMerchant: tail.some((r) => r.hasGuessedMerchant),
    folded: tail,
  };

  return [...head.map((r) => toSegment(r, grandTotal)), fold];
}

function toSegment(row: CompositionRow, grandTotal: number): DonutSegment {
  return {
    key: row.category,
    label: row.category,
    total: row.total,
    confirmedTotal: row.confirmedTotal,
    provisionalTotal: row.provisionalTotal,
    share: grandTotal > 0 ? row.total / grandTotal : 0,
    colorVar: categoryColorVar(row.category),
    isFold: false,
    hasGuessedMerchant: row.hasGuessedMerchant,
  };
}
