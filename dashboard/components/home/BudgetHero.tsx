import { AmountWithProvisionalSplit } from "@/components/honest-data/ProvisionalAmount";
import { formatMoney } from "@/components/honest-data/MoneyFigure";

// The hero (§1 Layer 2, §2 point 1): this month's total confirmed spend
// against the derived total cap, days elapsed/remaining, and a projected
// month-end figure directly beneath in --color-ink-secondary. The one
// deliberate grid-breaking overlap + hard shadow live in app/styles/home.css.
//
// h2, not h1: the page's one h1 now lives in SpendOverview's headline
// (components/home/SpendOverview.tsx), which leads the page per the
// operator's visual-first restructuring. This card is still the budget
// read that matters most once caps exist — just no longer the first
// thing on the page — so it keeps its heading semantics, one level down.
export function BudgetHero({
  monthLabel,
  confirmedTotal,
  provisionalTotal,
  totalCap,
  daysElapsed,
  daysRemaining,
  projected,
}: {
  monthLabel: string;
  confirmedTotal: number;
  provisionalTotal: number;
  totalCap: number;
  daysElapsed: number;
  daysRemaining: number;
  projected: number | null;
}) {
  const total = confirmedTotal + provisionalTotal;

  return (
    <section className="hero" aria-labelledby="hero-heading">
      <p className="hero__eyebrow">{monthLabel}</p>
      <h2 id="hero-heading" className="hero__figure">
        {formatMoney(total)}
      </h2>
      <p className="hero__cap">
        of <span className="money">{formatMoney(totalCap)}</span> budgeted
      </p>
      <dl className="hero__split">
        <dt>Split:</dt>
        <dd>
          <AmountWithProvisionalSplit confirmedTotal={confirmedTotal} provisionalTotal={provisionalTotal} />
        </dd>
      </dl>
      <p className="hero__meta">
        Day {daysElapsed} · {daysRemaining} day{daysRemaining === 1 ? "" : "s"} left
        {projected !== null && (
          <>
            {" · "}Projected <span className="money">{formatMoney(projected)}</span> by month end
          </>
        )}
      </p>
    </section>
  );
}
