import type { CardPeriodStatus } from "../supabase/types";

// Presentation-only shaping for the /cards composite gauge (§3 View 4).
// Every number here is read directly off card_period_status()'s jsonb —
// nothing recomputes a threshold, a gate, or a reward the Postgres engine
// already decided (docs/cardledger-build-spec.md §9: "the model may parse
// and classify; it must never decide whether a threshold was met" — the
// same rule this dashboard is held to). Where a fixed dollar figure
// appears below (UOB's three tier amounts), it is used ONLY to place a
// tick mark on an axis — which ticks count as "reached" is still decided
// by comparing against `tier_hit`, a value the engine already computed,
// never by re-deriving spend >= threshold here.

export type CardKind = "uob" | "hsbc" | "citi-ghost" | "generic";

export function detectCardKind(status: CardPeriodStatus): CardKind {
  if (status.active === false) return "citi-ghost";
  if (typeof status.gate_cleared === "boolean" && "quarter" in status) return "uob";
  if (typeof status.bonus_spend === "number") return "hsbc";
  return "generic";
}

// ============ UOB ============

export interface UobTierTick {
  threshold: number;
  label: string;
  reached: boolean;
  isCurrent: boolean;
}

const UOB_TIER_AMOUNTS = [600, 1000, 2000];

export function buildUobTierTicks(status: CardPeriodStatus): UobTierTick[] {
  const tierHit = status.tier_hit as { threshold?: number } | null | undefined;
  const hitThreshold = typeof tierHit?.threshold === "number" ? tierHit.threshold : null;

  return UOB_TIER_AMOUNTS.map((threshold) => ({
    threshold,
    label: `S$${threshold.toLocaleString("en-SG")}`,
    // A tier at or below the engine's own tier_hit is necessarily cleared,
    // since uob_month_status walks thresholds highest-first and stops at
    // the first one it clears — comparing two already-known numbers here,
    // not re-evaluating spend against a threshold.
    reached: hitThreshold !== null && threshold <= hitThreshold,
    isCurrent: hitThreshold !== null && threshold === hitThreshold,
  }));
}

export interface UobGaugeData {
  spend: number;
  daysLeft: number | null;
  isCurrent: boolean;
  txnCount: number | null;
  gateCleared: boolean | null;
  ticks: UobTierTick[];
  gapToNext: number | null;
  txnsNeeded: number | null;
  capRemaining: number | null;
  capAmount: number | null;
  rewardAccrued: number | null;
  atRiskReasons: string[];
}

export function buildUobGaugeData(status: CardPeriodStatus): UobGaugeData {
  return {
    spend: typeof status.spend === "number" ? status.spend : 0,
    daysLeft: typeof status.days_left === "number" ? status.days_left : null,
    isCurrent: status.is_current === true,
    txnCount: typeof status.txn_count === "number" ? status.txn_count : null,
    gateCleared: typeof status.gate_cleared === "boolean" ? status.gate_cleared : null,
    ticks: buildUobTierTicks(status),
    gapToNext: typeof status.gap_to_next === "number" && status.gap_to_next > 0 ? status.gap_to_next : null,
    txnsNeeded: typeof status.txns_needed === "number" ? status.txns_needed : null,
    capRemaining: typeof status.cap_remaining === "number" ? status.cap_remaining : null,
    capAmount: typeof status.cap_amount === "number" ? status.cap_amount : null,
    rewardAccrued: typeof status.reward_accrued === "number" ? status.reward_accrued : null,
    atRiskReasons: Array.isArray(status.at_risk_reasons) ? (status.at_risk_reasons as string[]) : [],
  };
}

export type QuarterPillState = "cleared" | "pending" | "forfeited" | "unknown";

export interface QuarterPillData {
  periodKey: string;
  state: QuarterPillState;
  spend: number | null;
  txnCount: number | null;
  isCurrent: boolean;
}

interface UobQuarterStatus {
  quarter_months?: unknown[];
  blocking_months?: Array<{ period_key: string }>;
  still_achievable_tier?: { threshold: number; payout: number } | null;
  confirmed_tier?: { threshold: number; payout: number } | null;
  forfeited?: boolean;
  at_risk?: boolean;
  grouping?: string;
  anchor_unknown?: boolean;
  approx_payout_at_stake?: number | null;
  error?: string;
}

export function buildQuarterPills(quarter: UobQuarterStatus): QuarterPillData[] {
  const blockingKeys = new Set((quarter.blocking_months ?? []).map((m) => m.period_key));
  const months = (quarter.quarter_months ?? []) as CardPeriodStatus[];

  return months.map((m) => {
    if (m.error) {
      return { periodKey: (m.period_key as string) ?? "unknown", state: "unknown", spend: null, txnCount: null, isCurrent: false };
    }
    const periodKey = String(m.period_key ?? "unknown");
    const isCurrent = m.is_current === true;
    const closed = !isCurrent && m.days_left === 0;
    let state: QuarterPillState = "pending";
    if (blockingKeys.has(periodKey)) state = "forfeited";
    else if (closed) state = "cleared";

    return {
      periodKey,
      state,
      spend: typeof m.spend === "number" ? m.spend : null,
      txnCount: typeof m.txn_count === "number" ? m.txn_count : null,
      isCurrent,
    };
  });
}

// ============ HSBC ============

export interface HsbcGaugeData {
  bonusSpend: number;
  baseSpend: number;
  capAmount: number | null;
  capRemaining: number | null;
  capExhausted: boolean;
  rateTier: string | null;
  daysLeft: number | null;
  rewardAccrued: number | null;
  atRisk: boolean;
}

export function buildHsbcGaugeData(status: CardPeriodStatus): HsbcGaugeData {
  return {
    bonusSpend: typeof status.bonus_spend === "number" ? status.bonus_spend : 0,
    baseSpend: typeof status.base_spend === "number" ? status.base_spend : 0,
    capAmount: typeof status.cap_amount === "number" ? status.cap_amount : null,
    capRemaining: typeof status.cap_remaining === "number" ? status.cap_remaining : null,
    capExhausted: status.cap_exhausted === true,
    rateTier: typeof status.rate_tier === "string" ? status.rate_tier : null,
    daysLeft: typeof status.days_left === "number" ? status.days_left : null,
    rewardAccrued: typeof status.reward_accrued === "number" ? status.reward_accrued : null,
    atRisk: status.at_risk === true,
  };
}
