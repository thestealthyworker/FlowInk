import { formatMoney } from "@/components/honest-data/MoneyFigure";
import type { HsbcGaugeData } from "@/lib/derive/cardGauge";

// §3 View 4: "a dual-segment fill: base-rate spend and bonus-rate spend in
// two visually distinct fills within the same track... HSBC's bonus-rate
// assumption is asterisked inline — 'assumes contactless — unconfirmed
// until reconciliation' — directly beside the bonus segment, never a
// buried footnote" (§5 build spec: payment-method condition unknowable
// from alert data alone). Both segment widths are the engine's own
// bonus_spend/base_spend, not re-derived.
export function HsbcGauge({ data }: { data: HsbcGaugeData }) {
  const trackMax = data.capAmount ?? Math.max(data.bonusSpend, 1);
  const bonusPct = Math.min(data.bonusSpend / trackMax, 1) * 100;
  const totalSpend = data.bonusSpend + data.baseSpend;

  return (
    <div className="card-gauge">
      <div className="card-gauge__figures">
        <span className="money-figure card-gauge__headline">{formatMoney(data.bonusSpend)}</span>
        <span className="card-gauge__sub">
          bonus-rate spend of {data.capAmount !== null ? formatMoney(data.capAmount) : "no cap"}
          {data.daysLeft !== null && ` · ${data.daysLeft} day${data.daysLeft === 1 ? "" : "s"} left`}
        </span>
      </div>

      <div
        className="card-gauge__track card-gauge__track--dual"
        role="img"
        aria-label={`${formatMoney(data.bonusSpend)} bonus-rate spend and ${formatMoney(data.baseSpend)} base-rate spend this month`}
      >
        <div className="card-gauge__fill card-gauge__fill--bonus" style={{ width: `${bonusPct}%` }} />
        {data.capAmount !== null && (
          <span className="card-gauge__cap-marker" style={{ left: "100%" }} aria-hidden="true" />
        )}
      </div>

      <p className="card-gauge__meta">
        <span className="money-figure">{formatMoney(data.bonusSpend)}</span> bonus-rate (
        {data.rateTier === "enhanced_8mpd" ? "8 mpd" : "4 mpd"}) + <span className="money-figure">{formatMoney(data.baseSpend)}</span>{" "}
        base-rate (1 mpd) = <span className="money-figure">{formatMoney(totalSpend)}</span> total this month.
        <br />
        <em className="card-gauge__asterisk">
          * Assumes contactless / online payment — unconfirmed until statement reconciliation (bonus categories
          require it and alert data cannot confirm it).
        </em>
      </p>

      {data.rewardAccrued !== null && (
        <p className="card-gauge__meta">
          Estimated miles this month: <span className="money-figure">{data.rewardAccrued.toFixed(1)} mpd-equiv</span>
        </p>
      )}

      {data.capAmount !== null && !data.capExhausted && (
        <p className="card-gauge__reasons">
          <span className="card-gauge__tag card-gauge__tag--warning">Unused headroom</span>{" "}
          <span className="money-figure">{formatMoney(data.capRemaining ?? 0)}</span> of bonus-rate cap left this
          month.
        </p>
      )}
    </div>
  );
}
