import { formatMoney } from "@/components/honest-data/MoneyFigure";
import type { MethodSplitRow } from "@/lib/derive/methodSplit";

// The supporting mark (§3 View 3): a single stacked bar, not a donut —
// 4-5 segments read faster as a bar, and the mandatory 2px surface gap
// between segments (the dataviz skill's spacer rule) comes from the
// flex `gap` on `.method-split__bar` rather than a border, so no ink is
// spent separating segments that isn't the segments themselves.
export function PaymentMethodSplitChart({ rows }: { rows: MethodSplitRow[] }) {
  if (rows.length === 0) {
    return (
      <section aria-labelledby="method-split-heading" className="method-split">
        <h2 id="method-split-heading">By payment method</h2>
        <p>No spend recorded yet this month.</p>
      </section>
    );
  }

  const summary = `Spend by payment method this month: ${rows
    .map((r) => `${r.displayName} ${formatMoney(r.total)} (${Math.round(r.share * 100)}%)`)
    .join(", ")}.`;

  return (
    <section aria-labelledby="method-split-heading" className="method-split">
      <h2 id="method-split-heading">By payment method</h2>

      <div className="method-split__bar" role="img" aria-label={summary}>
        {rows.map((row) => (
          <span
            key={row.method_id}
            className="method-split__segment"
            data-tone={row.tone}
            style={{ flexGrow: Math.max(row.share, 0.02), background: `var(${row.colorVar})` }}
          />
        ))}
      </div>

      <ul className="method-split__legend">
        {rows.map((row) => (
          <li key={row.method_id} className="method-split__legend-item" data-tone={row.tone}>
            <span
              className="method-split__swatch"
              style={{ background: `var(${row.colorVar})` }}
              aria-hidden="true"
            />
            <span className="method-split__name">
              {row.displayName}
              {row.tone === "retired" && <span className="method-split__retired-tag"> Retired</span>}
            </span>
            <span className="money-figure">{formatMoney(row.total)}</span>
            <span className="method-split__share">{Math.round(row.share * 100)}%</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
