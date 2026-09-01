import { deleteBudgetAction } from "@/lib/actions/budgets";
import { listBudgets } from "@/lib/data/budgets";
import { getTrailingActualsByCategory } from "@/lib/data/spend";
import { createClient } from "@/lib/supabase/server";
import { currentCalendarMonth } from "@/lib/date";
import { ConfirmSubmitButton } from "@/components/ui/ConfirmSubmitButton";
import { BudgetPlannerForm } from "@/components/budgets/BudgetPlannerForm";
import { formatMoney } from "@/components/honest-data/MoneyFigure";

const TRAILING_MONTHS = 6;

// Budget CRUD (Phase D2). `budgets` is empty in production and this page
// is its only insertion path (docs/architecture.md §9, "Manual entry and
// the dashboard as an input surface").
// The amendment's specific ask beyond plain CRUD: a candidate cap is
// compared against real trailing actuals in the SAME view as the input,
// not a separate report — BudgetPlannerForm carries that.
export default async function BudgetsPage() {
  const supabase = await createClient();
  const calendarMonth = currentCalendarMonth();

  const [budgets, actualsByCategory] = await Promise.all([
    listBudgets(supabase),
    getTrailingActualsByCategory(supabase, calendarMonth, TRAILING_MONTHS),
  ]);

  return (
    <div className="budgets-page">
      <header className="page-header">
        <p className="page-header__eyebrow">Planning</p>
        <h1>Budgets</h1>
        <p>
          Caps and alert thresholds, by category and period. Set here, read everywhere else — the home view&rsquo;s
          category bars and hero cap are derived directly from what&rsquo;s below, never hardcoded.
        </p>
      </header>

      <section aria-labelledby="existing-budgets-heading" className="page-section">
        <h2 id="existing-budgets-heading">Current budgets</h2>
        {budgets.length > 0 ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Category</th>
                  <th scope="col">Period</th>
                  <th scope="col">Monthly cap</th>
                  <th scope="col">Alert at</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {budgets.map((b) => (
                  <tr key={b.id}>
                    <td>{b.category}</td>
                    <td>{b.period === "default" ? <span className="tag-default">default</span> : b.period}</td>
                    <td className="money-figure">{formatMoney(Number(b.monthly_cap))}</td>
                    <td className="money-figure">{Math.round(Number(b.alert_at) * 100)}%</td>
                    <td>
                      <form action={deleteBudgetAction}>
                        <input type="hidden" name="id" value={b.id} />
                        <ConfirmSubmitButton label="Delete" confirmLabel="Confirm delete?" />
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <p>No budgets set yet — every category shows &ldquo;no cap&rdquo; on the home view until you add one below.</p>
          </div>
        )}
      </section>

      <section aria-labelledby="new-budget-heading" className="page-section budget-planner">
        <h2 id="new-budget-heading">Add / update a budget</h2>
        <p>
          Pick a category to see the last {TRAILING_MONTHS} months of real spend before committing to a number — caps
          set from evidence, not a guess. Saving with a category/period pair that already has a row replaces it
          (<code>unique (category, period)</code>).
        </p>
        <BudgetPlannerForm
          actualsByCategory={actualsByCategory}
          monthsCount={TRAILING_MONTHS}
          defaultPeriod={calendarMonth}
        />
      </section>
    </div>
  );
}
