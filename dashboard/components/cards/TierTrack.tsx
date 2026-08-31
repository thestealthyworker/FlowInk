import { formatMoney, MoneyFigure } from "@/components/honest-data/MoneyFigure";
import { nextTierNote, prettifyUnit, trackLabel } from "@/lib/derive/cardCopy";
import type { CardRewardTrack } from "@/lib/supabase/types";

// Generalises UobGauge.tsx's fill-bar-with-tick-marks visual (kept
// verbatim as a visual pattern, per WP4's brief — only its inputs change)
// to any card whose reward_tracks[] includes a `kind: 'tier'` entry,
// reading `thresholds[]` instead of a hardcoded UOB_TIER_AMOUNTS array.
// Tick reached/current state comes straight off the engine's own
// `thresholds[].reached` / `is_current_tier` — never recomputed here.
export function TierTrack({
  track,
  spend,
  txnCount,
  currency,
}: {
  track: CardRewardTrack;
  spend: number;
  txnCount: number | null;
  currency: string;
}) {
  const thresholds = track.thresholds ?? [];
  const money = (amount: number) => formatMoney(amount, currency);
  const trackMax = Math.max(spend, ...thresholds.map((t) => t.value), 1);
  const pct = Math.min(spend / trackMax, 1);
  const currentTier = thresholds.find((t) => t.is_current_tier);
  const note = nextTierNote(thresholds, txnCount, money);
  const unit = prettifyUnit(track.unit);

  return (
    <div className="card-gauge__section">
      <p className="card-gauge__section-label">{trackLabel(track)}</p>

      <div
        className="card-gauge__track"
        role="img"
        aria-label={`${money(spend)} spent this period against tier thresholds up to ${money(trackMax)}`}
      >
        <div className="card-gauge__fill" style={{ width: `${pct * 100}%` }} />
        {thresholds.map((t) => (
          <span
            key={t.value}
            className="card-gauge__tick"
            data-reached={t.reached || undefined}
            data-current={t.is_current_tier || undefined}
            style={{ left: `${Math.min((t.value / trackMax) * 100, 100)}%` }}
          >
            <span className="card-gauge__tick-label">{money(t.value)}</span>
          </span>
        ))}
      </div>

      <p className="card-gauge__meta">
        <MoneyFigure amount={spend} currency={currency} /> this period. {note}
      </p>

      {currentTier && (
        <p className="card-gauge__meta">
          Payout secured this period so far: <MoneyFigure amount={track.accrued} currency={currency} />
          {unit && ` (${unit})`} — tracked separately from any per-transaction rate reward below.
        </p>
      )}
    </div>
  );
}
