import type { CSSProperties } from "react";
import { GuessedCategoryLabel } from "@/components/honest-data/GuessedCategoryLabel";
import { AmountWithProvisionalSplit } from "@/components/honest-data/ProvisionalAmount";
import { categoryColorVar } from "@/lib/derive/seriesColor";
import type { CompositionRow } from "@/lib/derive/spendComposition";

// §3 View 3: "reuses the exact bar component from View 1, unfiltered by a
// cap (a plain magnitude bar, sorted descending)." CategoryBar
// (components/home/CategoryBar.tsx) is built around a cap comparison
// (status colour, overage texture) that has no meaning without a cap —
// this is that same track/fill visual language with the cap-specific
// parts genuinely removed, not forced through props that don't apply,
// coloured by the category's own identity hue (categoryColorVar) instead
// of a good/warning/critical status since there is no threshold here.
export function MagnitudeBarList({ rows }: { rows: CompositionRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="empty-state">
        <p>No categorised spend in this period.</p>
      </div>
    );
  }

  const max = Math.max(...rows.map((r) => r.total), 1);

  return (
    <ul className="magnitude-bar-list">
      {rows.map((row, index) => (
        <li key={row.category} id={`cat-${row.category}`} className="magnitude-bar-row" style={{ "--bar-index": index } as CSSProperties}>
          <div className="magnitude-bar-row__label">
            <span className="magnitude-bar-row__swatch" style={{ background: `var(${categoryColorVar(row.category)})` }} aria-hidden="true" />
            <GuessedCategoryLabel category={row.category} isGuessed={row.hasGuessedMerchant} />
          </div>
          <div className="magnitude-bar-row__track">
            <div
              className="magnitude-bar-row__fill"
              style={{ "--pct": row.total / max, background: `var(${categoryColorVar(row.category)})` } as CSSProperties}
            />
          </div>
          <div className="magnitude-bar-row__value">
            <AmountWithProvisionalSplit confirmedTotal={row.confirmedTotal} provisionalTotal={row.provisionalTotal} />
            <span className="magnitude-bar-row__share">{Math.round(row.share * 100)}%</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
