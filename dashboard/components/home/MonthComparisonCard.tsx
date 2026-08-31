import { formatMoney } from "@/components/honest-data/MoneyFigure";
import { calendarMonthAbbr } from "@/lib/date";
import type { MonthComparison } from "@/lib/derive/kpis";

const DIRECTION_GLYPH: Record<MonthComparison["direction"], string> = { up: "▲", down: "▼", flat: "—" };
const DIRECTION_WORD: Record<MonthComparison["direction"], string> = { up: "more", down: "less", flat: "the same" };

// KPI 2 of 3 (operator: "Total Spent this month vs Last month") — and the
// single most important correctness issue in the whole rebuild. August is
// day 26 of 31: comparing its partial total against July's COMPLETE total
// (S$962 vs S$5,923) would read as a spending collapse that isn't real.
// The headline compares month-to-date against month-to-date — the previous
// month's spend through the SAME day count — and the previous month's full
// total appears only as clearly-labelled context underneath, never blended
// into the delta. This is why this card gets the most explanatory text and
// the primary grid position: it is the KPI most likely to mislead if
// simplified further, so it earns the space to be exact instead.
//
// No good/bad colour coding on the direction — "spent more" isn't
// inherently bad without a budget/cap context (that judgement belongs to
// the category-cap bars elsewhere on this page), so the glyph and text sit
// in plain ink, not the status palette.
export function MonthComparisonCard({ comparison }: { comparison: MonthComparison }) {
  const currentAbbr = calendarMonthAbbr(comparison.currentCalendarMonth);
  const previousAbbr = calendarMonthAbbr(comparison.previousCalendarMonth);
  const pctText =
    comparison.deltaPct !== null ? ` (${Math.round(Math.abs(comparison.deltaPct) * 100)}%)` : "";

  return (
    <article className="kpi-card kpi-card--compare" aria-labelledby="kpi-compare-heading">
      <h3 id="kpi-compare-heading" className="kpi-card__label">
        This month vs last
      </h3>

      <p className="kpi-compare__delta" data-direction={comparison.direction}>
        <span aria-hidden="true" className="kpi-compare__glyph">
          {DIRECTION_GLYPH[comparison.direction]}
        </span>
        {formatMoney(Math.abs(comparison.delta))} {DIRECTION_WORD[comparison.direction]}
        {pctText}
      </p>

      <dl className="kpi-compare__rows">
        <div className="kpi-compare__row">
          <dt>
            {currentAbbr} 1–{comparison.currentThroughDay}
          </dt>
          <dd className="money-figure">{formatMoney(comparison.currentTotal)}</dd>
        </div>
        <div className="kpi-compare__row">
          <dt>
            {previousAbbr} 1–{comparison.currentThroughDay}
          </dt>
          <dd className="money-figure">{formatMoney(comparison.previousThroughSameDay)}</dd>
        </div>
      </dl>

      <p className="kpi-compare__note">
        {!comparison.isCurrentMonthComplete && (
          <>
            {currentAbbr} is still in progress (day {comparison.currentThroughDay}) — compared like-for-like
            against {previousAbbr}&rsquo;s first {comparison.currentThroughDay} days, not its full month.{" "}
          </>
        )}
        {comparison.previousFullMonth !== null && (
          <>
            {previousAbbr}&rsquo;s full month total was <span className="money-figure">{formatMoney(comparison.previousFullMonth)}</span>.
          </>
        )}
      </p>
    </article>
  );
}
