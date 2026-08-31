import { formatMoney, MoneyFigure } from "@/components/honest-data/MoneyFigure";
import { prettifyUnit, trackLabel } from "@/lib/derive/cardCopy";
import type { CardRewardTrack } from "@/lib/supabase/types";

// Generalises HsbcGauge.tsx's fill-bar visual to any `kind: 'category_rate'`
// reward_tracks[] entry, one row per entry rather than one hand-picked
// dual segment — a card with two rows (HSBC: bonus + base) renders two
// rows; a card with six (UOB: three tier-3 categories + two
// fully-claimed lower-tier duplicates + the flat SP bills rate) renders
// six, each legible on its own rather than forced into a fixed two-
// segment shape that only ever fit one card's mechanic. The progress
// fill's ceiling is the row's OWN cap (spend-basis: matched spend vs cap;
// reward-basis: accrued vs cap) or its own gating threshold when it has
// no cap — never a shared, hardcoded track width.
export function RateTrack({ track, currency }: { track: CardRewardTrack; currency: string }) {
  const money = (amount: number) => formatMoney(amount, currency);
  const unit = prettifyUnit(track.unit);
  const matchedSpend = track.matched_spend ?? 0;
  const accrued = track.accrued ?? 0;

  if (track.threshold_met === false) {
    return (
      <div className="card-gauge__section card-gauge__section--muted">
        <p className="card-gauge__section-label">{trackLabel(track)}</p>
        <p className="card-gauge__meta">
          Not active yet this period — starts once spend reaches <MoneyFigure amount={track.threshold ?? 0} currency={currency} />.
        </p>
      </div>
    );
  }

  const ceiling = track.cap ? track.cap.amount : track.threshold ?? null;
  const numerator = track.cap?.basis === "reward" ? accrued : matchedSpend;
  const pct = ceiling ? Math.min(numerator / ceiling, 1) : null;

  return (
    <div className="card-gauge__section">
      <p className="card-gauge__section-label">
        {trackLabel(track)}
        {typeof track.rate === "number" && (
          <span className="card-gauge__section-rate">
            {" "}
            · rate {track.rate}
            {unit && ` ${unit}`}
          </span>
        )}
      </p>

      {track.note ? (
        <p className="card-gauge__meta">{track.note}.</p>
      ) : (
        <>
          {pct !== null && (
            <div
              className="card-gauge__track card-gauge__track--slim"
              role="img"
              aria-label={`${money(track.cap?.basis === "reward" ? accrued : matchedSpend)} of ${money(ceiling!)} ${
                track.cap?.basis === "reward" ? "reward cap" : "spend cap"
              }`}
            >
              <div className="card-gauge__fill" style={{ width: `${pct * 100}%` }} />
            </div>
          )}
          <p className="card-gauge__meta">
            <MoneyFigure amount={matchedSpend} currency={currency} /> matched spend earned{" "}
            <MoneyFigure amount={accrued} currency={currency} />
            {unit && ` ${unit}`}
            {track.cap && (
              <>
                {" "}
                of a {money(track.cap.amount)} {track.cap.basis} cap ({money(track.cap.remaining ?? 0)} left
                {track.cap.exhausted ? ", cap reached" : ""})
              </>
            )}
            .{" "}
            {track.overflow_spend != null && track.overflow_spend > 0 && (
              <>
                {track.cap ? (
                  <>
                    <MoneyFigure amount={track.overflow_spend} currency={currency} /> of matched spend exceeded this
                    row&rsquo;s cap and earned at the base rate instead.
                  </>
                ) : (
                  <>
                    Includes <MoneyFigure amount={track.overflow_spend} currency={currency} /> routed here from a
                    capped bonus category above its own limit.
                  </>
                )}
              </>
            )}
          </p>
        </>
      )}
    </div>
  );
}
