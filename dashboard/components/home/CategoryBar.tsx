import type { CSSProperties } from "react";
import type { CategoryBarRow } from "@/lib/derive/budgetSummary";
import { GuessedCategoryLabel } from "@/components/honest-data/GuessedCategoryLabel";
import { formatMoney } from "@/components/honest-data/MoneyFigure";

// The core mark (§3 View 1): a horizontal bar against a cap, not a gauge
// or donut. Status colour is never the only signal — a text tag and the
// diagonal overage texture carry the same distinction without colour.
export function CategoryBar({ row, index }: { row: CategoryBarRow; index: number }) {
  const pct = row.cap > 0 ? row.spend / row.cap : row.spend > 0 ? Infinity : 0;
  const cappedPct = Math.min(pct, 1);
  const confirmedFraction = row.spend > 0 ? row.confirmedSpend / row.spend : 0;
  const provisionalFraction = row.spend > 0 ? row.provisionalSpend / row.spend : 0;
  const overage = row.cap > 0 && row.spend > row.cap ? row.spend - row.cap : 0;
  const overageWidthPct = overage > 0 ? Math.min(50, 15 + (overage / row.cap) * 100) : 0;

  return (
    <li className="bar-row" style={{ "--bar-index": index } as CSSProperties}>
      <div className="bar-row__label">
        <GuessedCategoryLabel category={row.category} isGuessed={row.hasGuessedMerchant} />
        {row.status !== "good" && (
          <span className="bar-row__status-tag" data-status={row.status}>
            {row.status === "critical" ? "Over" : "Near cap"}
          </span>
        )}
      </div>

      <div className="bar-row__track">
        <div
          className="bar-row__fill"
          data-status={row.status}
          style={{ "--pct": cappedPct } as CSSProperties}
        >
          <span className="bar-row__fill-confirmed" style={{ width: `${confirmedFraction * 100}%` }} />
          <span className="bar-row__fill-provisional" style={{ width: `${provisionalFraction * 100}%` }} />
        </div>
        {overage > 0 && <div className="bar-row__overage" style={{ width: `${overageWidthPct}%` }} />}
      </div>

      <div className="bar-row__value">
        <span className="money-figure">{formatMoney(row.spend)}</span>
        {" / "}
        <span className="money-figure">{formatMoney(row.cap)}</span>
        {overage > 0 && <span className="bar-row__overage-label">+{formatMoney(overage)} over</span>}
      </div>
    </li>
  );
}
