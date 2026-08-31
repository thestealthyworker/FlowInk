import Link from "next/link";
import { formatMoney } from "@/components/honest-data/MoneyFigure";
import { buildQuarterPills, type UobGaugeData } from "@/lib/derive/cardGauge";
import { QuarterPills } from "./QuarterPills";

const REASON_COPY: Record<string, string> = {
  below_min_spend: "Below the S$600 minimum spend this statement month.",
  below_txn_count: "Below the 10-transaction minimum this statement month.",
};

// §3 View 4: UOB's all-or-nothing minimum-spend gate. A single fill against
// a S$2,000 ceiling with tick marks at each tier threshold, plus the
// three-pill quarter strip. All figures come straight from
// card_period_status() — the ticks' "reached" state is a static-constant
// comparison against the engine's own `tier_hit`, never a re-derived
// spend-vs-threshold decision (see lib/derive/cardGauge.ts's header note).
export function UobGauge({
  data,
  quarter,
}: {
  data: UobGaugeData;
  quarter: { grouping?: string; anchor_unknown?: boolean; forfeited?: boolean; at_risk?: boolean; approx_payout_at_stake?: number | null; quarter_months?: unknown[]; blocking_months?: Array<{ period_key: string }> };
}) {
  const trackMax = 2000;
  const pct = Math.min(data.spend / trackMax, 1);
  const pills = buildQuarterPills(quarter);

  return (
    <div className="card-gauge">
      <div className="card-gauge__figures">
        <span className="money-figure card-gauge__headline">{formatMoney(data.spend)}</span>
        <span className="card-gauge__sub">
          this statement month{data.daysLeft !== null && ` · ${data.daysLeft} day${data.daysLeft === 1 ? "" : "s"} left`}
        </span>
      </div>

      <div className="card-gauge__track" role="img" aria-label={`${formatMoney(data.spend)} spent this statement month against tier thresholds up to S$2,000`}>
        <div className="card-gauge__fill" style={{ width: `${pct * 100}%` }} />
        {data.ticks.map((tick) => (
          <span
            key={tick.threshold}
            className="card-gauge__tick"
            data-reached={tick.reached || undefined}
            data-current={tick.isCurrent || undefined}
            style={{ left: `${Math.min((tick.threshold / trackMax) * 100, 100)}%` }}
          >
            <span className="card-gauge__tick-label">{tick.label}</span>
          </span>
        ))}
      </div>

      <p className="card-gauge__meta">
        {data.txnCount !== null && (
          <>
            {data.txnCount} transaction{data.txnCount === 1 ? "" : "s"}
            {data.gateCleared === false && data.txnsNeeded !== null && ` — ${data.txnsNeeded} more needed to clear the 10-txn gate`}
            {data.gateCleared === true && " — 10-txn gate cleared"}
            {". "}
          </>
        )}
        {data.gapToNext !== null && (
          <>
            <span className="money-figure">{formatMoney(data.gapToNext)}</span> to the next tier.{" "}
          </>
        )}
        {data.rewardAccrued !== null && (
          <>
            Additional cashback this month so far:{" "}
            <span className="money-figure">{formatMoney(data.rewardAccrued)}</span>
            {data.capAmount !== null && ` of a S$${data.capAmount} cap`}.
          </>
        )}
      </p>

      {data.atRiskReasons.length > 0 && (
        <ul className="card-gauge__reasons">
          {data.atRiskReasons.map((reason) => (
            <li key={reason}>{REASON_COPY[reason] ?? reason}</li>
          ))}
        </ul>
      )}

      <div className="card-gauge__quarter">
        <p className="card-gauge__quarter-heading">
          Quarter gate
          {quarter.forfeited && <span className="card-gauge__tag card-gauge__tag--critical">Forfeited</span>}
          {!quarter.forfeited && quarter.at_risk && <span className="card-gauge__tag card-gauge__tag--warning">At risk</span>}
        </p>

        {quarter.anchor_unknown && (
          <p className="card-gauge__caveat">
            Card approval date unknown — this groups the nearest three statement months as a trailing-window
            approximation, not the bank&rsquo;s real anchored quarter. Treat the payout figure as directional until
            reconciled. <Link href="/cards/tier-3">See the Tier-3 record →</Link>
          </p>
        )}

        <QuarterPills pills={pills} />

        {!quarter.forfeited && quarter.approx_payout_at_stake != null && (
          <p className="card-gauge__meta">
            Approx. <span className="money-figure">{formatMoney(quarter.approx_payout_at_stake)}</span> payout at stake
            this quarter if the gate holds.
          </p>
        )}
      </div>
    </div>
  );
}
