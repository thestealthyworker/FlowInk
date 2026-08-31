import type { CategorySpendDetail } from "../data/spend";
import type { Category } from "../supabase/types";

// Pure presentation-layer shaping for the home view's visual overview
// (the composition chart, docs/DASHBOARD_PLAN.md §3 View 3 mark reused
// on the home view) — cap-independent, unlike CategoryBarRow in
// budgetSummary.ts. Reuses the exact MonthlySpendSummary read the hero
// and category bars already fetch (lib/data/spend.ts); no new query.

export interface CompositionRow {
  category: Category | "uncategorised";
  total: number;
  confirmedTotal: number;
  provisionalTotal: number;
  count: number;
  share: number;
  hasGuessedMerchant: boolean;
}

/** Sorted descending by spend — a plain magnitude ordering, not the
 * proximity-to-cap ordering CategoryBarList uses, since composition has
 * no cap to be proximate to. */
export function buildCompositionRows(
  byCategory: CategorySpendDetail[],
  guessedIds: Set<number>
): CompositionRow[] {
  const grandTotal = byCategory.reduce((sum, c) => sum + c.total, 0);

  return byCategory
    .filter((c) => c.total > 0)
    .map((c) => ({
      category: c.category,
      total: c.total,
      confirmedTotal: c.confirmedTotal,
      provisionalTotal: c.provisionalTotal,
      count: c.count,
      share: grandTotal > 0 ? c.total / grandTotal : 0,
      hasGuessedMerchant: c.merchantIds.some((id) => guessedIds.has(id)),
    }))
    .sort((a, b) => b.total - a.total);
}
