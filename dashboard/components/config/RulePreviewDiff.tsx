import { formatMoney } from "@/components/honest-data/MoneyFigure";
import type { CardPeriodStatus, CardRewardTrack, RulePreview } from "@/lib/supabase/types";

// The centrepiece of "approving is a real decision, not a rubber stamp"
// (WP5's hard requirement): renders preview_method_rule()'s (0018)
// before/after pair — the SAME evaluate_period() the live dashboard
// already trusts, run once as today's config and once with exactly this
// pending row hypothetically active, against a real period's real
// transactions. Nothing here recomputes a reward; every number is read
// straight off the two jsonb payloads.

function trackKey(t: CardRewardTrack): string {
  return `${t.kind}|${t.label}|${JSON.stringify(t.categories ?? null)}`;
}

function trackMap(status: CardPeriodStatus): Map<string, CardRewardTrack> {
  const map = new Map<string, CardRewardTrack>();
  for (const t of status.reward_tracks ?? []) map.set(trackKey(t), t);
  return map;
}

export function RulePreviewDiff({ preview, currency }: { preview: RulePreview; currency: string }) {
  const before = preview.without_rule;
  const after = preview.with_rule;
  const money = (n: number) => formatMoney(n, currency);

  if (before.error || after.error) {
    return (
      <p className="rule-preview__note">
        Could not compute a live preview for this period ({before.error ?? after.error}) — the rule is still fully
        readable above; only the numeric effect preview is unavailable.
      </p>
    );
  }

  if (before.active === false) {
    return (
      <p className="rule-preview__note">
        {before.display_name ?? "This card"} is not active yet, so there is no live period to preview an effect
        against. The rule itself is validated and ready to approve regardless.
      </p>
    );
  }

  const beforeAccrued = before.reward_accrued ?? 0;
  const afterAccrued = after.reward_accrued ?? 0;
  const delta = Math.round((afterAccrued - beforeAccrued) * 100) / 100;

  const beforeTracks = trackMap(before);
  const afterTracks = trackMap(after);
  const newTrackKeys = [...afterTracks.keys()].filter((k) => !beforeTracks.has(k));
  const changedTrackKeys = [...afterTracks.keys()].filter((k) => {
    if (!beforeTracks.has(k)) return false;
    return (beforeTracks.get(k)?.accrued ?? 0) !== (afterTracks.get(k)?.accrued ?? 0);
  });

  return (
    <div className="rule-preview">
      <p className="rule-preview__period">
        Effect on {after.period?.key ?? preview.period_key} — real spend this period: {money(before.spend?.total ?? 0)}
        {before.spend?.txn_count !== undefined ? ` (${before.spend.txn_count} txns)` : ""}.
      </p>

      <div className="rule-preview__totals">
        <div className="rule-preview__figure">
          <span className="rule-preview__figure-label">Reward accrued today</span>
          <span className="rule-preview__figure-value">{money(beforeAccrued)}</span>
        </div>
        <span className="rule-preview__arrow" aria-hidden="true">
          →
        </span>
        <div className="rule-preview__figure">
          <span className="rule-preview__figure-label">If approved</span>
          <span className="rule-preview__figure-value">{money(afterAccrued)}</span>
        </div>
        <span
          className={`rule-preview__delta ${delta > 0 ? "rule-preview__delta--up" : delta < 0 ? "rule-preview__delta--down" : ""}`}
        >
          {delta === 0 ? "no change this period" : `${delta > 0 ? "+" : ""}${money(delta)}`}
        </span>
      </div>

      {newTrackKeys.length === 0 && changedTrackKeys.length === 0 && delta === 0 && (
        <p className="rule-preview__note">
          No visible effect this period — likely because nothing was spent in the categories or window this rule
          covers yet. That does not make the rule wrong; it may simply not have been exercised this period.
        </p>
      )}

      {newTrackKeys.length > 0 && (
        <ul className="rule-preview__track-list">
          {newTrackKeys.map((k) => {
            const t = afterTracks.get(k)!;
            return (
              <li key={k}>
                New track — <strong>{t.label}</strong>: {money(t.accrued)} accrued
                {t.matched_spend !== undefined ? ` on ${money(t.matched_spend)} matched spend` : ""}.
              </li>
            );
          })}
        </ul>
      )}

      {changedTrackKeys.length > 0 && (
        <ul className="rule-preview__track-list">
          {changedTrackKeys.map((k) => {
            const b = beforeTracks.get(k)!;
            const a = afterTracks.get(k)!;
            return (
              <li key={k}>
                <strong>{a.label}</strong>: {money(b.accrued)} → {money(a.accrued)}.
              </li>
            );
          })}
        </ul>
      )}

      {after.cap && (
        <p className="rule-preview__note">
          Shared cap ({after.cap.basis === "spend" ? "eligible spend" : "total reward"} basis): {money(after.cap.remaining ?? 0)}{" "}
          remaining of {money(after.cap.amount)}
          {after.cap.exhausted ? " — exhausted." : "."}
        </p>
      )}
    </div>
  );
}
