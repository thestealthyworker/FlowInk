import { GuessedCategoryLabel } from "@/components/honest-data/GuessedCategoryLabel";
import { formatMoney } from "@/components/honest-data/MoneyFigure";
import { categoryColorVar } from "@/lib/derive/seriesColor";
import type { TopCategoryRow } from "@/lib/derive/kpis";

// KPI 3 of 3 (operator: "Top 3 categories spent"). Deliberately the
// smallest, least chart-like of the three cards — a ranked list reads
// faster than a bar or number here, and giving it a distinct shape (chips
// in a row, not a stacked card) is the "differentiated treatment" the
// design-quality rule calls for: three KPIs that all look like the same
// tile would bury the fact that they answer different kinds of question.
export function TopCategoriesCard({ rows }: { rows: TopCategoryRow[] }) {
  if (rows.length === 0) {
    return (
      <article className="kpi-card kpi-card--top" aria-labelledby="kpi-top-heading">
        <h3 id="kpi-top-heading" className="kpi-card__label">
          Top categories this month
        </h3>
        <p className="kpi-card__meta">No categorised spend yet this month.</p>
      </article>
    );
  }

  return (
    <article className="kpi-card kpi-card--top" aria-labelledby="kpi-top-heading">
      <h3 id="kpi-top-heading" className="kpi-card__label">
        Top categories this month
      </h3>
      <ol className="kpi-top__list">
        {rows.map((row, i) => (
          <li key={row.category} className="kpi-top__chip">
            <span className="kpi-top__rank" aria-hidden="true">
              {i + 1}
            </span>
            <span
              className="kpi-top__swatch"
              style={{ background: `var(${categoryColorVar(row.category)})` }}
              aria-hidden="true"
            />
            <span className="kpi-top__name">
              <GuessedCategoryLabel category={row.category} isGuessed={row.hasGuessedMerchant} />
            </span>
            <span className="kpi-top__figures">
              <span className="money-figure">{formatMoney(row.total)}</span>
              <span className="kpi-top__share">{Math.round(row.share * 100)}%</span>
            </span>
          </li>
        ))}
      </ol>
    </article>
  );
}
