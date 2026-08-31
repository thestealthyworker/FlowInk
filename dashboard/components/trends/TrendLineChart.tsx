import { formatMoney } from "@/components/honest-data/MoneyFigure";
import type { MonthlyTotal } from "@/lib/data/spend";
import { calendarMonthAbbr, calendarMonthLabel } from "@/lib/date";
import { buildLineChartLayout } from "@/lib/derive/trendChart";

// §3 View 2's core mark, reused unchanged by /cards/tier-3 with a
// reference line added (§3 View 5) — a single 2px line, slot-1 blue,
// markers at each month, hand-built SVG, no charting library. A month
// with any FX-pending (uncosted) transaction gets a hollow dashed ring
// instead of a solid marker, so "this figure is a floor, not the true
// number" reads as a shape difference rather than a tooltip you have to
// find (§3's own "shadow line" idea, simplified to one honest, legible
// mark rather than a second overlapping line at this data density).
export function TrendLineChart({
  months,
  fxPendingMonths,
  referenceLine,
  calloutMonth,
  partialMonth,
  title,
}: {
  months: MonthlyTotal[];
  fxPendingMonths: Set<string>;
  referenceLine?: { value: number; label: string };
  calloutMonth?: { calendarMonth: string; total: number; label: string };
  /** The current, still-in-progress calendar month (§4: non-negotiable —
   * a partial month must never imply spending collapsed). When it matches
   * the final point, that last segment renders dashed and the point
   * hollow, instead of reading as a completed month's real low. */
  partialMonth?: string;
  title: string;
}) {
  if (months.length === 0) {
    return (
      <div className="empty-state">
        <p>No spend recorded yet.</p>
      </div>
    );
  }

  const layout = buildLineChartLayout(months, fxPendingMonths, {
    minMax: referenceLine?.value,
  });
  const isPartialIndex = (i: number) => partialMonth !== undefined && layout.points[i]?.calendarMonth === partialMonth;
  const lastIndex = layout.points.length - 1;
  const lastIsPartial = isPartialIndex(lastIndex);

  const solidPoints = lastIsPartial ? layout.points.slice(0, lastIndex) : layout.points;
  const solidPath = solidPoints.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");
  const partialSegmentPath =
    lastIsPartial && lastIndex > 0
      ? `M ${layout.points[lastIndex - 1]!.x.toFixed(2)} ${layout.points[lastIndex - 1]!.y.toFixed(2)} L ${layout.points[lastIndex]!.x.toFixed(2)} ${layout.points[lastIndex]!.y.toFixed(2)}`
      : null;
  const anyFxPending = layout.points.some((p) => p.isFxPending);

  const summary = `${title}: ${months
    .map((m) => `${calendarMonthAbbr(m.calendar_month)} ${formatMoney(m.total)}`)
    .join(", ")}.`;

  return (
    <div className="trend-chart">
      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        className="trend-chart__svg"
        role="img"
        aria-label={summary}
        preserveAspectRatio="xMidYMid meet"
      >
        <line
          x1={layout.padX}
          x2={layout.width - layout.padX}
          y1={layout.height - layout.padY}
          y2={layout.height - layout.padY}
          className="trend-chart__baseline"
        />

        {referenceLine && (
          <>
            <line
              x1={layout.padX}
              x2={layout.width - layout.padX}
              y1={layout.yFor(referenceLine.value)}
              y2={layout.yFor(referenceLine.value)}
              className="trend-chart__reference"
            />
            <text x={layout.width - layout.padX} y={layout.yFor(referenceLine.value) - 5} textAnchor="end" className="trend-chart__reference-label">
              {referenceLine.label} · {formatMoney(referenceLine.value)}
            </text>
          </>
        )}

        <path d={solidPath} className="trend-chart__line" fill="none" />
        {partialSegmentPath && <path d={partialSegmentPath} className="trend-chart__line trend-chart__line--partial" fill="none" />}

        {layout.points.map((p, i) => {
          const isPartial = isPartialIndex(i);
          return (
            <g key={p.calendarMonth}>
              {p.isFxPending ? (
                <circle cx={p.x} cy={p.y} r="4.5" className="trend-chart__marker trend-chart__marker--fx" />
              ) : isPartial ? (
                <circle cx={p.x} cy={p.y} r="4.5" className="trend-chart__marker trend-chart__marker--partial" />
              ) : (
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={p.calendarMonth === calloutMonth?.calendarMonth ? 5.5 : 3.5}
                  className="trend-chart__marker"
                  data-callout={p.calendarMonth === calloutMonth?.calendarMonth || undefined}
                />
              )}
              <text x={p.x} y={layout.height - 4} textAnchor="middle" className="trend-chart__month-label">
                {calendarMonthAbbr(p.calendarMonth)}
                {isPartial ? "*" : ""}
              </text>
            </g>
          );
        })}

        {calloutMonth &&
          (() => {
            const calloutPoint = layout.points.find((p) => p.calendarMonth === calloutMonth.calendarMonth);
            if (!calloutPoint) return null;
            const refY = referenceLine ? layout.yFor(referenceLine.value) : null;
            const labelAbove = calloutPoint.y - 10;
            // Nudge the label below the point instead when it would land
            // within a few pixels of the reference line — a genuine
            // collision at some data values, not a hypothetical one.
            const labelY = refY !== null && Math.abs(labelAbove - refY) < 14 ? calloutPoint.y + 16 : labelAbove;
            return (
              <text x={calloutPoint.x} y={labelY} textAnchor="middle" className="trend-chart__callout-label">
                {calloutMonth.label}
              </text>
            );
          })()}
      </svg>

      {lastIsPartial && (
        <p className="trend-chart__fx-note">
          <span aria-hidden="true" className="trend-chart__fx-note-marker trend-chart__fx-note-marker--partial" />
          {calendarMonthAbbr(partialMonth!)}* is still in progress — not a finished month, never read it as one.
        </p>
      )}

      {anyFxPending && (
        <p className="trend-chart__fx-note">
          <span aria-hidden="true" className="trend-chart__fx-note-marker" /> Hollow marker — month includes
          FX-pending spend not yet counted in the total above (§4: never a guessed SGD figure).
        </p>
      )}

      <details className="trend-chart__table">
        <summary>View as table</summary>
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Month</th>
              <th scope="col">Total</th>
              <th scope="col"></th>
            </tr>
          </thead>
          <tbody>
            {months.map((m) => (
              <tr key={m.calendar_month}>
                <th scope="row">{calendarMonthLabel(m.calendar_month)}</th>
                <td className="money-figure">{formatMoney(m.total)}</td>
                <td>
                  {[
                    fxPendingMonths.has(m.calendar_month) ? "FX-pending spend excluded" : null,
                    m.calendar_month === partialMonth ? "In progress" : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
