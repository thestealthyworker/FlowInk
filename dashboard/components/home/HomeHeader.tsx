import { formatMoney } from "@/components/honest-data/MoneyFigure";

// The page's one h1. Replaces the old SpendOverview wrapper (which used
// to also own the composition chart, trend line, and payment-method
// split — all three now live elsewhere or have been folded into the KPI
// row, per the operator's "cleaner, not more" request), so this is now
// just the eyebrow + headline + one-line status a glance-and-decide
// reader wants first: how far into the month, how much so far, anything
// pending.
export function HomeHeader({
  monthLabel,
  total,
  daysElapsed,
  daysRemaining,
  fxPendingCount,
}: {
  monthLabel: string;
  total: number;
  daysElapsed: number;
  daysRemaining: number;
  fxPendingCount: number;
}) {
  return (
    <header className="home-header">
      <p className="home-header__eyebrow">{monthLabel}</p>
      <h1 className="home-header__heading">Where it went</h1>
      <p className="home-header__subtitle">
        <span className="money-figure">{formatMoney(total)}</span> so far · day {daysElapsed}
        {daysRemaining > 0 ? `, ${daysRemaining} day${daysRemaining === 1 ? "" : "s"} left` : ""}
        {fxPendingCount > 0 && (
          <>
            {" · "}
            <a href="#fx-tray-heading">
              {fxPendingCount} pending FX conversion{fxPendingCount === 1 ? "" : "s"}
            </a>
          </>
        )}
      </p>
    </header>
  );
}
