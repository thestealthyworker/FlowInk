import { LargestMonthCard } from "./LargestMonthCard";
import { MonthComparisonCard } from "./MonthComparisonCard";
import { TopCategoriesCard } from "./TopCategoriesCard";
import type { MonthlyTotal } from "@/lib/data/spend";
import type { LargestMonth, MonthComparison, TopCategoryRow } from "@/lib/derive/kpis";

// The operator's three named KPIs, laid out with real hierarchy rather
// than three identical tiles (design-quality's banned "dashboard-by-
// numbers" pattern). Priority follows freshness/actionability, not the
// order they were asked in: the month-vs-month comparison is the
// freshest "should I be worried right now" fact, so it takes the primary
// (widest, most explanatory) slot; the record month is context, sized
// down; top categories is the most glanceable, so it reads as a compact
// chip row rather than another stacked card. Grid asymmetry (7/5 split,
// then a full-width row) is set in app/styles/home.css.
export function KpiGrid({
  comparison,
  largest,
  trendMonths,
  topCategoryRows,
}: {
  comparison: MonthComparison;
  largest: LargestMonth | null;
  trendMonths: MonthlyTotal[];
  topCategoryRows: TopCategoryRow[];
}) {
  return (
    <section className="kpi-grid" aria-label="This month at a glance">
      <MonthComparisonCard comparison={comparison} />
      {largest && <LargestMonthCard largest={largest} months={trendMonths} />}
      <TopCategoriesCard rows={topCategoryRows} />
    </section>
  );
}
