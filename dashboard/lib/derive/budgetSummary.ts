import type { Budget, Category } from "../supabase/types";

// Pure presentation-layer logic — no Supabase calls. Merges a category's
// period-specific budget row with its 'default' fallback row (schema:
// unique (category, period)), and derives the whole-month cap as
// sum(monthly_cap) across every category that has *some* resolved cap
// (§2 DECISION POINT 1 of docs/DASHBOARD_PLAN.md: derived sum, not an
// explicit 'total' sentinel row — the fixed 11-category vocabulary has no
// slot for one).

export interface ResolvedCategoryBudget {
  category: Category;
  monthlyCap: number;
  alertAt: number;
  source: "period" | "default";
}

export function resolveCategoryBudgets(budgets: Budget[], period: string): ResolvedCategoryBudget[] {
  const byCategory = new Map<Category, ResolvedCategoryBudget>();

  for (const row of budgets) {
    if (row.period !== "default") continue;
    byCategory.set(row.category, {
      category: row.category,
      monthlyCap: Number(row.monthly_cap),
      alertAt: Number(row.alert_at),
      source: "default",
    });
  }

  for (const row of budgets) {
    if (row.period !== period) continue;
    byCategory.set(row.category, {
      category: row.category,
      monthlyCap: Number(row.monthly_cap),
      alertAt: Number(row.alert_at),
      source: "period",
    });
  }

  return [...byCategory.values()];
}

export function deriveTotalCap(resolved: ResolvedCategoryBudget[]): number {
  return resolved.reduce((sum, r) => sum + r.monthlyCap, 0);
}

export type CategoryBarStatus = "good" | "warning" | "critical";

/** good <alert_at, warning alert_at–100%, critical >=100% (§3 View 1). */
export function categoryBarStatus(spend: number, cap: number, alertAt: number): CategoryBarStatus {
  if (cap <= 0) return spend > 0 ? "critical" : "good";
  const pct = spend / cap;
  if (pct >= 1) return "critical";
  if (pct >= alertAt) return "warning";
  return "good";
}

export interface CategoryBarRow {
  category: Category;
  spend: number;
  confirmedSpend: number;
  provisionalSpend: number;
  cap: number;
  alertAt: number;
  status: CategoryBarStatus;
  hasGuessedMerchant: boolean;
}

/** Closest-to-breach first (highest spend/cap ratio), never alphabetical
 * and never raw-spend order — the one ordering that answers "what's about
 * to blow its cap" at a glance (§2). */
export function sortByProximityToCap(rows: CategoryBarRow[]): CategoryBarRow[] {
  return [...rows].sort((a, b) => {
    const pctA = a.cap > 0 ? a.spend / a.cap : Number.POSITIVE_INFINITY;
    const pctB = b.cap > 0 ? b.spend / b.cap : Number.POSITIVE_INFINITY;
    if (pctB !== pctA) return pctB - pctA;
    return b.spend - a.spend;
  });
}
