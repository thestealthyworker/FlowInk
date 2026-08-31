import { formatMoney } from "@/components/honest-data/MoneyFigure";
import { calendarMonthAbbr } from "@/lib/date";
import type { TrailingCategoryMonth } from "@/lib/data/spend";

// The amendment's specific interactive-planning requirement (§6 D2): the
// last few months of real actuals for the category currently selected,
// drawn against the candidate cap being typed — hand-built SVG bars, no
// charting library, so the comparison this evidence-based-caps ask needs
// lives in the same view as the input, not a separate report.
const W = 300;
const H = 96;
const PAD_X = 6;
const PAD_TOP = 10;
const PAD_BOTTOM = 18;

export function CategorySparkline({
  actuals,
  candidateCap,
}: {
  actuals: TrailingCategoryMonth[];
  candidateCap: number | null;
}) {
  const plotW = W - PAD_X * 2;
  const plotH = H - PAD_TOP - PAD_BOTTOM;
  const barW = actuals.length > 0 ? plotW / actuals.length : plotW;
  const maxValue = Math.max(...actuals.map((a) => a.total), candidateCap ?? 0, 1);

  const capY = candidateCap !== null && candidateCap > 0 ? PAD_TOP + plotH - (Math.min(candidateCap, maxValue) / maxValue) * plotH : null;

  const label = `Last ${actuals.length} months: ${actuals
    .map((a) => `${calendarMonthAbbr(a.calendar_month)} ${formatMoney(a.total)}`)
    .join(", ")}${candidateCap !== null && candidateCap > 0 ? `. Candidate cap ${formatMoney(candidateCap)}.` : ""}`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="budget-spark" role="img" aria-label={label} preserveAspectRatio="xMidYMid meet">
      {actuals.map((a, i) => {
        const barH = maxValue > 0 ? (a.total / maxValue) * plotH : 0;
        const x = PAD_X + i * barW;
        const y = PAD_TOP + plotH - barH;
        const over = candidateCap !== null && candidateCap > 0 && a.total > candidateCap;
        return (
          <g key={a.calendar_month}>
            <rect
              x={x + barW * 0.18}
              y={y}
              width={Math.max(barW * 0.64, 2)}
              height={Math.max(barH, 1)}
              rx="1.5"
              className="budget-spark__bar"
              data-over={over || undefined}
            />
            <text x={x + barW / 2} y={H - 4} className="budget-spark__label" textAnchor="middle">
              {calendarMonthAbbr(a.calendar_month)}
            </text>
          </g>
        );
      })}
      {capY !== null && (
        <>
          <line x1={0} x2={W} y1={capY} y2={capY} className="budget-spark__cap-line" />
          <text x={W} y={capY - 3} className="budget-spark__cap-label" textAnchor="end">
            candidate cap
          </text>
        </>
      )}
    </svg>
  );
}
