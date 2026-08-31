"use client";

import { useMemo, useState } from "react";
import { formatMoney } from "@/components/honest-data/MoneyFigure";
import { saveBudgetAction } from "@/lib/actions/budgets";
import type { TrailingActualsByCategory } from "@/lib/data/spend";
import { CATEGORIES, type Category } from "@/lib/supabase/types";
import { CategorySparkline } from "./CategorySparkline";

// The one genuinely interactive surface in Phase D2 (§6 D2's own acceptance
// bar: "the six-month sparkline immediately on selecting that category,
// before any value is typed"). A server action (saveBudgetAction) is
// called directly from this client form — Next.js allows a "use server"
// export to be imported and used as a form `action` from either a server
// or a client component; no fetch/route handler needed.
export function BudgetPlannerForm({
  actualsByCategory,
  monthsCount,
  defaultPeriod,
}: {
  actualsByCategory: TrailingActualsByCategory;
  monthsCount: number;
  defaultPeriod: string;
}) {
  const [category, setCategory] = useState<Category | "">("");
  const [capInput, setCapInput] = useState("");

  const actuals = category ? actualsByCategory[category] : null;
  const candidateCap = capInput.trim() === "" ? null : Number(capInput);
  const validCap = candidateCap !== null && Number.isFinite(candidateCap) && candidateCap > 0 ? candidateCap : null;

  const avgMonthly = useMemo(() => {
    if (!actuals || actuals.length === 0) return 0;
    return actuals.reduce((sum, a) => sum + a.total, 0) / actuals.length;
  }, [actuals]);

  return (
    <form action={saveBudgetAction} className="budget-form">
      <div className="budget-form__fields">
        <label htmlFor="category">Category</label>
        <select
          id="category"
          name="category"
          required
          value={category}
          onChange={(event) => setCategory(event.target.value as Category)}
        >
          <option value="" disabled>
            Choose a category
          </option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>

        <label htmlFor="period">Period</label>
        <input id="period" name="period" type="text" required defaultValue={defaultPeriod} placeholder="2026-09 or default" />
        <p className="form-hint">
          A specific month (<code>2026-09</code>) or <code>default</code> — the fallback cap applied whenever no
          month-specific row exists for that category.
        </p>

        <label htmlFor="monthly_cap">Monthly cap (SGD)</label>
        <input
          id="monthly_cap"
          name="monthly_cap"
          type="number"
          step="0.01"
          min="0.01"
          required
          value={capInput}
          onChange={(event) => setCapInput(event.target.value)}
        />

        <label htmlFor="alert_at">Alert threshold (0–1)</label>
        <input id="alert_at" name="alert_at" type="number" step="0.01" min="0.01" max="1" placeholder="0.80" />
        <p className="form-hint">Category bar turns amber at this share of the cap. Leave blank for 80%.</p>

        <button type="submit" className="entry-form__submit">
          Save budget
        </button>
      </div>

      <div className="budget-form__evidence" aria-live="polite">
        {actuals ? (
          <>
            <p className="budget-form__evidence-label">
              Last {monthsCount} months — {category}
            </p>
            <CategorySparkline actuals={actuals} candidateCap={validCap} />
            <p className="budget-form__evidence-note">
              Averaged <span className="money-figure">{formatMoney(avgMonthly)}</span>/month over this window.
              {validCap !== null && (
                <>
                  {" "}
                  {actuals.filter((a) => a.total > validCap).length} of {actuals.length} months would have been over a{" "}
                  <span className="money-figure">{formatMoney(validCap)}</span> cap.
                </>
              )}
            </p>
          </>
        ) : (
          <p className="budget-form__evidence-placeholder">
            Choose a category to see the last {monthsCount} months of real spend, drawn against your candidate cap as
            you type it.
          </p>
        )}
      </div>
    </form>
  );
}
