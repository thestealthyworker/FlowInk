import { TrendLineChart } from "@/components/trends/TrendLineChart";
import { formatMoney } from "@/components/honest-data/MoneyFigure";
import { getCardDashboardStatus } from "@/lib/data/cards";
import { getFxPendingMonths, getTwelveMonthTrend } from "@/lib/data/spend";
import { currentCalendarMonth, calendarMonthLabel } from "@/lib/date";
import { findLowestMonth } from "@/lib/derive/trendChart";
import { createClient } from "@/lib/supabase/server";

const TIER3_THRESHOLD = 2000;

// View 5 — the Tier-3 record (docs/DASHBOARD_PLAN.md §3 View 5, §6 D4).
// Reuses View 2's monthly-total line exactly, with a fixed S$2,000
// reference line and the lowest month in the trailing window called out —
// "the entire answer to 'is committing to Tier 3 safe.'" The
// anchor_unknown caveat comes straight off uob_quarter_status() — never
// re-derived, never presented as settled fact.
export default async function TierThreePage() {
  const supabase = await createClient();
  const calendarMonth = currentCalendarMonth();

  const [trend, fxPendingMonths, cards] = await Promise.all([
    getTwelveMonthTrend(supabase, calendarMonth),
    getFxPendingMonths(supabase, calendarMonth),
    getCardDashboardStatus(supabase),
  ]);

  const uob = cards.find((c) => c.method_id === "uob_one");
  // WP4 cutover: card_period_status()'s cross-period field is now `group`
  // (evaluate_period_group()'s own shape, 0015/0017), not the old
  // `quarter` key uob_quarter_status() used to return.
  const quarter = uob?.status.group as
    | { anchor_unknown?: boolean; grouping?: string; forfeited?: boolean; still_achievable_tier?: { threshold: number; payout: number } | null }
    | undefined;

  // The lowest-month callout is the entire point of this view (§3 View 5)
  // — but the current month is always partial (§4's non-negotiable rule),
  // so it will almost always show as spuriously "lowest" for reasons that
  // have nothing to do with spending discipline. Completed months only for
  // the verdict; the partial month still plots on the chart (as any other
  // point) but is called out separately rather than allowed to masquerade
  // as evidence.
  const completedMonths = trend.filter((m) => m.calendar_month !== calendarMonth);
  const lowest = findLowestMonth(completedMonths);
  const monthsBelow = completedMonths.filter((m) => m.total < TIER3_THRESHOLD).length;
  const currentMonthPoint = trend.find((m) => m.calendar_month === calendarMonth) ?? null;

  return (
    <div className="tier3-page">
      <header className="page-header">
        <p className="page-header__eyebrow">Card optimisation</p>
        <h1>The Tier-3 record</h1>
        <p>
          Month-over-month spend against the S$2,000 UOB One Tier-3 threshold — the evidence for whether committing to
          Tier 3 is safe, per the S$60/quarter (Tier 1) → S$100 (Tier 2) → S$200 (Tier 3) payout ladder.
        </p>
      </header>

      {quarter?.anchor_unknown && (
        <div className="tier3-caveat" role="note">
          <p>
            <strong>UOB&rsquo;s quarterly gate uses a trailing-window approximation.</strong> The card&rsquo;s approval
            date (<code>payment_methods.quarter_anchor_date</code>) is unknown, so the engine cannot align this to the
            bank&rsquo;s real anchored quarter — it groups the nearest three statement months instead and labels the
            result <code>anchor_unknown_trailing_window</code>. This drives a real ~S$312/quarter decision; treat the
            payout figure below as directional, not confirmed, until the anchor date is set.
          </p>
        </div>
      )}

      <section aria-labelledby="tier3-chart-heading" className="page-section">
        <h2 id="tier3-chart-heading">Total spend, last 12 months</h2>
        <TrendLineChart
          months={trend}
          fxPendingMonths={fxPendingMonths}
          referenceLine={{ value: TIER3_THRESHOLD, label: "Tier 3 threshold" }}
          calloutMonth={lowest ? { calendarMonth: lowest.calendar_month, total: lowest.total, label: `Lowest completed — ${formatMoney(lowest.total)}` } : undefined}
          partialMonth={calendarMonth}
          title="Total spend by month against the Tier 3 threshold"
        />
      </section>

      {lowest && (
        <section aria-labelledby="tier3-verdict-heading" className="page-section tier3-verdict">
          <h2 id="tier3-verdict-heading">The verdict</h2>
          <p>
            The lowest <em>completed</em> month in this window was <strong>{calendarMonthLabel(lowest.calendar_month)}</strong> at{" "}
            <span className="money-figure">{formatMoney(lowest.total)}</span>
            {lowest.total >= TIER3_THRESHOLD
              ? " — every completed month in this window cleared S$2,000. Tier 3 has held up so far."
              : ` — S$${(TIER3_THRESHOLD - lowest.total).toFixed(2)} short of Tier 3. ${monthsBelow} of ${completedMonths.length} completed months in this window fell below the threshold.`}
          </p>
          {currentMonthPoint && (
            <p className="form-hint">
              {calendarMonthLabel(currentMonthPoint.calendar_month)} is still in progress (
              <span className="money-figure">{formatMoney(currentMonthPoint.total)}</span> so far) and is deliberately
              excluded from the verdict above — a partial month is always the lowest point on this chart for reasons
              that have nothing to do with spending discipline.
            </p>
          )}
          {quarter?.forfeited && (
            <p>
              <span className="card-gauge__tag card-gauge__tag--critical">Forfeited</span> The current quarter has
              already lost the gate in at least one closed statement month.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
