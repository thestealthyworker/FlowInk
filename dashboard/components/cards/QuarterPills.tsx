import { formatMoney } from "@/components/honest-data/MoneyFigure";
import { calendarMonthLabel } from "@/lib/date";
import type { QuarterPillData } from "@/lib/derive/cardGauge";

// §3 View 4: "three small pills above the bar, one per statement month in
// the current quarter — filled (cleared), hollow (pending), or an × in
// critical red (forfeited) — making the all-or-nothing quarterly gate
// legible as a shape, not a paragraph of text." Colour is never the only
// signal: each state also carries a distinct glyph/border style.
export function QuarterPills({ pills }: { pills: QuarterPillData[] }) {
  return (
    <ol className="quarter-pills" aria-label="Quarter statement months">
      {pills.map((pill) => {
        const monthLabel = pill.periodKey.includes(":") ? calendarMonthLabel(pill.periodKey.split(":")[1] ?? "") : pill.periodKey;
        return (
          <li key={pill.periodKey} className="quarter-pill" data-state={pill.state} data-is-current={pill.isCurrent || undefined}>
            <span className="quarter-pill__glyph" aria-hidden="true">
              {pill.state === "cleared" && "✓"}
              {pill.state === "forfeited" && "×"}
              {pill.state === "pending" && "○"}
              {pill.state === "unknown" && "–"}
            </span>
            <span className="quarter-pill__label">
              {monthLabel}
              {pill.isCurrent && " (current)"}
            </span>
            {pill.spend !== null && (
              <span className="quarter-pill__spend money-figure">{formatMoney(pill.spend)}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
