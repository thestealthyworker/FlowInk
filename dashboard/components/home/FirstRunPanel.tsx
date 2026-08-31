import Link from "next/link";
import { formatMoney } from "@/components/honest-data/MoneyFigure";
import type { Category } from "@/lib/supabase/types";

export interface TrailingCategoryActual {
  category: Category | "uncategorised";
  total: number;
  monthsCovered: number;
}

// h2, not h1: the page's h1 now lives in SpendOverview's headline, which
// leads the page ahead of this panel per the visual-first restructuring.
//
// The empty-budgets first-run state (§4, §6 D1 acceptance): `budgets` is
// genuinely empty in production, so this is the literal first screen the
// operator sees — the moment they set caps against real actuals, not a
// hypothetical "just in case" empty state. Occupies the hero's position
// rather than a 0/0 progress bar (§4). Shows the trailing months of real
// spend so the operator has something to set a cap *against*, in the same
// view as the total they already came here to check.
export function FirstRunPanel({
  monthLabel,
  totalSpend,
  trailingMonths,
  trailingActuals,
  otherShare,
}: {
  monthLabel: string;
  totalSpend: number;
  trailingMonths: number;
  trailingActuals: TrailingCategoryActual[];
  otherShare: number;
}) {
  return (
    <section className="hero firstrun" aria-labelledby="hero-heading">
      <p className="hero__eyebrow">{monthLabel}</p>
      <h2 id="hero-heading" className="hero__figure">
        {formatMoney(totalSpend)}
      </h2>
      <p className="hero__cap">spent so far — no budget caps set for this period</p>

      <p className="firstrun__intro">
        Set a cap for a category to start tracking against it. Here&rsquo;s where the last {trailingMonths} months
        actually went:
      </p>

      <ol className="firstrun-list">
        {trailingActuals.slice(0, 6).map((row) => (
          <li key={row.category} className="firstrun-list__row">
            <span className="firstrun-list__name">{row.category}</span>
            <span className="firstrun-list__figures">
              <span className="money-figure">{formatMoney(row.total)} total</span>
              <span className="money-figure">{formatMoney(row.total / row.monthsCovered)}/mo avg</span>
            </span>
          </li>
        ))}
      </ol>

      {otherShare >= 0.3 && (
        <p className="firstrun__note">
          {Math.round(otherShare * 100)}% of the last {trailingMonths} months sits in &ldquo;other&rdquo; — likely
          mis-triaged rather than a real long tail. <Link href="/triage">Work through triage</Link> before setting
          that category&rsquo;s cap.
        </p>
      )}

      <Link href="/budgets" className="hero__cta">
        Set your first budget →
      </Link>
    </section>
  );
}
