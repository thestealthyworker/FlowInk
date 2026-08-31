import { formatMoney } from "@/components/honest-data/MoneyFigure";
import type { MonthlyTotal } from "@/lib/data/spend";
import { calendarMonthAbbr, calendarMonthLabel } from "@/lib/date";
import type { LargestMonth } from "@/lib/derive/kpis";

const SPARK_W = 108;
const SPARK_H = 34;
const SPARK_PAD = 4;

// KPI 1 of 3 (operator: "largest spend by month"). Secondary weight in the
// grid — a historical record, not the freshest actionable fact — so it
// carries a supporting sparkline (marks-and-anatomy's stat-tile contract:
// "trend: optional, 12-point sparkline, current period in the accent")
// rather than the biggest type on the page. The sparkline is decorative
// context only: the headline text already states the month and the
// amount, so nothing here gates on the chart rendering or being seen.
export function LargestMonthCard({ largest, months }: { largest: LargestMonth; months: MonthlyTotal[] }) {
  const points = sparklinePoints(months);
  const peakIndex = months.findIndex((m) => m.calendar_month === largest.calendarMonth);

  return (
    <article className="kpi-card kpi-card--largest" aria-labelledby="kpi-largest-heading">
      <h3 id="kpi-largest-heading" className="kpi-card__label">
        Biggest month{largest.isPartial ? " so far" : ""}
      </h3>
      <p className="kpi-card__figure">{formatMoney(largest.total)}</p>
      <p className="kpi-card__meta">
        {calendarMonthLabel(largest.calendarMonth)}
        {largest.isPartial && " — still climbing, in progress"}
      </p>

      {points.length > 1 && (
        <svg
          className="kpi-spark"
          viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
          aria-hidden="true"
          focusable="false"
          preserveAspectRatio="none"
        >
          <polyline points={points.map((p) => `${p.x},${p.y}`).join(" ")} className="kpi-spark__line" />
          {points.map((p, i) => (
            <circle
              key={months[i]?.calendar_month ?? i}
              cx={p.x}
              cy={p.y}
              r={i === peakIndex ? 3 : 1.6}
              className={i === peakIndex ? "kpi-spark__point kpi-spark__point--peak" : "kpi-spark__point"}
            />
          ))}
        </svg>
      )}

      <p className="visually-hidden">
        Monthly totals: {months.map((m) => `${calendarMonthAbbr(m.calendar_month)} ${formatMoney(m.total)}`).join(", ")}.
      </p>
    </article>
  );
}

function sparklinePoints(months: MonthlyTotal[]): { x: number; y: number }[] {
  if (months.length === 0) return [];
  const max = Math.max(...months.map((m) => m.total)) || 1;
  const plotW = SPARK_W - SPARK_PAD * 2;
  const plotH = SPARK_H - SPARK_PAD * 2;

  return months.map((m, i) => ({
    x: SPARK_PAD + (months.length === 1 ? plotW / 2 : (i / (months.length - 1)) * plotW),
    y: SPARK_PAD + plotH - (m.total / max) * plotH,
  }));
}
