import type { CardPeriodThreshold, CardRewardTrack } from "@/lib/supabase/types";

// Pure copy-generation helpers for the generic card panel
// (components/cards/CardStatusPanel.tsx and friends) — kept separate from
// the components so the "never hardcode an amount or a bank's specific
// mechanic, only generate copy from the contract's own fields" rule (WP4)
// is auditable in one small file rather than scattered across JSX.
// Nothing here recomputes a threshold, a gate, or a reward the Postgres
// evaluator already decided — every function takes numbers/strings the
// contract already returned and turns them into a sentence or a label.

/**
 * A `reward_tracks[].label` is derived server-side (0015) from the first
 * clause of the operator's free-text `method_rules.notes` — written for a
 * human reading a migration file, not for end-user display. Usually fine
 * ("Groceries at Tier 3."), but a staged/draft row's notes can start with
 * an internal marker word ("STAGED. ...") that survives the SQL's own
 * `coalesce(nullif(..., ''), 'Category bonus')` untouched, because that
 * guard only catches an EMPTY first clause, not a non-empty-but-
 * meaningless one. Detected generically (a single all-caps token, no
 * per-card string list) rather than special-cased for Citi specifically.
 */
export function isGarbageLabel(label: string): boolean {
  const stripped = label.replace(/\.+$/, "").trim();
  if (stripped.length === 0) return true;
  return /^[A-Z0-9]+$/.test(stripped) && stripped.length < 12;
}

function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Used only when a track's own label is empty or garbage (see above) —
 * built from the same structured fields the label would otherwise
 * describe, never a hardcoded per-card string. */
export function fallbackTrackLabel(track: Pick<CardRewardTrack, "kind" | "categories">): string {
  if (track.kind === "tier") return "Spend tiers";
  if (track.categories && track.categories.length > 0) {
    return track.categories.map(titleCase).join(" & ");
  }
  return "Base rate";
}

export function trackLabel(track: Pick<CardRewardTrack, "kind" | "categories" | "label">): string {
  return isGarbageLabel(track.label) ? fallbackTrackLabel(track) : track.label;
}

/** reward_unit is a technical identifier (e.g.
 * 'miles_best_partner_equivalent_2.5to1', 'cashback_sgd_additional') set
 * once per payment_methods row, generically, in place of a per-card
 * hardcoded literal (0015's own header note explains why it exists as
 * data at all). Rendered as-is with separators loosened for legibility —
 * never replaced with an invented pretty name, since this app has no way
 * to know a good display name for a reward unit it has never seen. */
export function prettifyUnit(unit: string | null | undefined): string | null {
  if (!unit) return null;
  return unit.replace(/_/g, " ");
}

/**
 * A tier that is not yet reached must explain why — either a spend gap
 * (thresholds[].gap > 0) or a transaction-count gap that a spend gap of
 * 0.00 alone doesn't reveal (thresholds[].txn_min, exposed in 27c9ad5
 * specifically to close this gap). Picks the lowest-value unmet
 * threshold (the nearest one to being cleared) and returns one sentence —
 * mirrors the single "gap to next tier" line the old UOB-only gauge
 * showed, generalised to any card with a tier track and correct for the
 * txn-count-only case the old gauge never explained.
 */
export function nextTierNote(
  thresholds: CardPeriodThreshold[],
  txnCount: number | null,
  formatAmount: (amount: number) => string
): string | null {
  const unmet = thresholds.filter((t) => !t.reached);
  if (unmet.length === 0) return null;
  const nearest = unmet.reduce((a, b) => (a.value < b.value ? a : b));
  const spendGap = nearest.gap ?? 0;

  if (spendGap > 0) {
    return `${formatAmount(spendGap)} more spend needed for the ${formatAmount(nearest.value)} tier.`;
  }
  if (txnCount !== null && nearest.txn_min > txnCount) {
    const short = nearest.txn_min - txnCount;
    return `Spend already clears the ${formatAmount(nearest.value)} tier, but ${short} more transaction${
      short === 1 ? "" : "s"
    } needed (minimum ${nearest.txn_min}).`;
  }
  return null;
}
