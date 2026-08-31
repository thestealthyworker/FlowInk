import { formatMoney } from "@/components/honest-data/MoneyFigure";
import { calendarMonthLabel } from "@/lib/date";
import type { CardPeriodGroup } from "@/lib/supabase/types";

// Generalises QuarterPills.tsx to any card whose `group` field is present
// (`has_group`, driven by payment_methods.aggregation_window — never a
// hardcoded "this is UOB" check). Pill count comes from `group.window`,
// not a hardcoded 3; the pending/cleared/forfeited glyph-and-colour logic
// is unchanged from the original component, since it was already generic.
type GroupPillState = "cleared" | "pending" | "forfeited" | "unknown";

interface GroupPillData {
  periodKey: string;
  state: GroupPillState;
  spend: number | null;
  txnCount: number | null;
  isCurrent: boolean;
}

function buildGroupPills(group: CardPeriodGroup): GroupPillData[] {
  const blockingKeys = new Set(group.blocking_members.map((m) => m.period_key));

  return group.members.map((m) => {
    if (m.error || !m.period) {
      return { periodKey: (m.period?.key as string) ?? "unknown", state: "unknown", spend: null, txnCount: null, isCurrent: false };
    }
    const periodKey = m.period.key;
    const isCurrent = m.period.is_current;
    const closed = !isCurrent && m.period.days_left === 0;
    let state: GroupPillState = "pending";
    if (blockingKeys.has(periodKey)) state = "forfeited";
    else if (closed) state = "cleared";

    return {
      periodKey,
      state,
      spend: m.spend?.total ?? null,
      txnCount: m.spend?.txn_count ?? null,
      isCurrent,
    };
  });
}

export function GroupStrip({ group, currency }: { group: CardPeriodGroup; currency: string }) {
  const pills = buildGroupPills(group);
  // period.kind is identical across every member of a group by
  // construction (evaluate_period_group only ever calls evaluate_period
  // for the same method_id); read it off the first real member rather
  // than assuming "statement" or "calendar".
  const periodKind = group.members.find((m) => m.period)?.period?.kind ?? "statement";

  return (
    <div className="card-gauge__group">
      <p className="card-gauge__group-heading">
        {group.window}-period gate
        {group.forfeited && <span className="card-gauge__tag card-gauge__tag--critical">Forfeited</span>}
        {!group.forfeited && group.at_risk && <span className="card-gauge__tag card-gauge__tag--warning">At risk</span>}
      </p>

      {group.anchor_unknown && (
        <p className="card-gauge__caveat">
          This card&rsquo;s aggregation anchor date is unknown, so the engine cannot align this to the issuer&rsquo;s
          real anchored cycle — it groups the nearest {group.window} consecutive {periodKind} periods as a trailing-
          window approximation instead. Treat the payout figure below as directional until the anchor date is set.
        </p>
      )}

      <ol className="group-strip" aria-label={`${periodKind} periods in this cycle`}>
        {pills.map((pill) => {
          const monthLabel = pill.periodKey.includes(":") ? calendarMonthLabel(pill.periodKey.split(":")[1] ?? "") : pill.periodKey;
          return (
            <li key={pill.periodKey} className="group-pill" data-state={pill.state} data-is-current={pill.isCurrent || undefined}>
              <span className="group-pill__glyph" aria-hidden="true">
                {pill.state === "cleared" && "✓"}
                {pill.state === "forfeited" && "×"}
                {pill.state === "pending" && "○"}
                {pill.state === "unknown" && "–"}
              </span>
              <span className="group-pill__label">
                {monthLabel}
                {pill.isCurrent && " (current)"}
              </span>
              {pill.spend !== null && <span className="group-pill__spend money-figure">{formatMoney(pill.spend, currency)}</span>}
            </li>
          );
        })}
      </ol>

      {!group.forfeited && group.approx_payout_at_stake != null && (
        <p className="card-gauge__meta">
          Approx. <span className="money-figure">{formatMoney(group.approx_payout_at_stake, currency)}</span> payout at
          stake this cycle if every period holds.
        </p>
      )}
    </div>
  );
}
