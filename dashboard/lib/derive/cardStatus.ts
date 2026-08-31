import { formatMoney } from "@/components/honest-data/MoneyFigure";
import type { CardDashboardStatusRow, CardPeriodStatus } from "../supabase/types";

export type CardTone = "good" | "warning" | "critical" | "neutral" | "ghost";

export interface CardSummary {
  headline: string;
  toneWord: string;
  tone: CardTone;
  daysLeft: number | null;
  atRisk: boolean;
}

// Shared by CardStatusStrip (the full per-card list) and CardWatchLine (the
// single most-urgent card surfaced near the top of the home view) — one
// parser for card_period_status()'s jsonb shape, which differs per card
// (method_rules-driven). Moved out of the strip component so both callers
// read the same tone/headline logic rather than drifting apart.
export function summarizeCardStatus(status: CardPeriodStatus): CardSummary {
  if (status.active === false) {
    // The DB's `note` field is a developer-facing implementation comment
    // (references a migration section, a column name) — never surfaced
    // verbatim; the plan's own language for this state is a single short
    // line (§3 View 4: "not yet issued").
    return { headline: "This card has not been issued yet.", toneWord: "Not issued", tone: "ghost", daysLeft: null, atRisk: false };
  }

  if (status.error) {
    return { headline: String(status.error), toneWord: "Unavailable", tone: "neutral", daysLeft: null, atRisk: false };
  }

  const daysLeft = typeof status.days_left === "number" ? status.days_left : null;
  const atRisk = status.at_risk === true;
  const daysSuffix = daysLeft !== null ? ` · ${daysLeft} day${daysLeft === 1 ? "" : "s"} left` : "";

  // HSBC shape: bonus_spend against a spend-unit cap.
  if (typeof status.bonus_spend === "number" && typeof status.cap_amount === "number") {
    const headline = `${formatMoney(status.bonus_spend)} / ${formatMoney(status.cap_amount)} bonus cap${daysSuffix}`;
    const capExhausted = status.cap_exhausted === true;
    return {
      headline,
      toneWord: capExhausted ? "Cap reached" : atRisk ? "Unused headroom" : "On track",
      tone: capExhausted ? "good" : atRisk ? "warning" : "neutral",
      daysLeft,
      atRisk,
    };
  }

  // UOB shape: an all-or-nothing minimum-spend gate.
  if (typeof status.gate_cleared === "boolean") {
    if (status.gate_cleared) {
      const spend = typeof status.spend === "number" ? status.spend : 0;
      return { headline: `Gate cleared · ${formatMoney(spend)} this period${daysSuffix}`, toneWord: "Cleared", tone: "good", daysLeft, atRisk: false };
    }
    const needed = typeof status.spend_needed_for_gate === "number" ? status.spend_needed_for_gate : null;
    const headline = needed !== null ? `${formatMoney(needed)} to clear gate${daysSuffix}` : `Gate not yet cleared${daysSuffix}`;
    return { headline, toneWord: atRisk ? "At risk" : "In progress", tone: atRisk ? "critical" : "warning", daysLeft, atRisk };
  }

  // Generic fallback for any other shape.
  const spend = typeof status.spend === "number" ? formatMoney(status.spend) : null;
  return {
    headline: `${spend ?? "—"} this period${daysSuffix}`,
    toneWord: atRisk ? "At risk" : "On track",
    tone: atRisk ? "warning" : "neutral",
    daysLeft,
    atRisk,
  };
}

export interface CardWatch {
  methodId: string;
  displayName: string;
  summary: CardSummary;
}

// Home view's single card-related KPI (operator: "this doesn't show any
// info on my credit card metrics"). The plan (§1, §2) is explicit that
// budgets/spend lead and cards are secondary — a full gauge grid belongs
// to Phase D4's dedicated /cards view, not here. What earns a place on
// this page is the ONE fact that would change a decision made today:
// which card is closest to a deadline or threshold. Priority: an
// actively at-risk card first (tie-broken by soonest deadline), else
// simply the soonest-ending active period. Cards with no numeric
// days_left (not yet issued, errored) never win the pick.
export function pickCardToWatch(cards: CardDashboardStatusRow[]): CardWatch | null {
  const candidates = cards
    .map((c) => ({ methodId: c.method_id, displayName: c.display_name, summary: summarizeCardStatus(c.status) }))
    .filter((c): c is CardWatch => c.summary.daysLeft !== null);

  if (candidates.length === 0) return null;

  const atRisk = candidates.filter((c) => c.summary.atRisk);
  const pool = atRisk.length > 0 ? atRisk : candidates;

  return pool.reduce((soonest, c) => ((c.summary.daysLeft as number) < (soonest.summary.daysLeft as number) ? c : soonest));
}
