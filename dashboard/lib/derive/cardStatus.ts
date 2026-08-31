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
// summariser for card_period_status()'s contract (WP4: repointed to the
// generic evaluator, 0017_repoint_card_period_status.sql), read generically
// off `gates[]` / `cap` / `at_risk` rather than shape-sniffing which bank
// this is (the old version of this file branched on `bonus_spend` /
// `gate_cleared` field presence — exactly the guessing WP4 removes).
export function summarizeCardStatus(status: CardPeriodStatus): CardSummary {
  if (status.active === false) {
    return { headline: "This card has not been issued yet.", toneWord: "Not issued", tone: "ghost", daysLeft: null, atRisk: false };
  }

  if (status.error) {
    return { headline: String(status.error), toneWord: "Unavailable", tone: "neutral", daysLeft: null, atRisk: false };
  }

  if (status.has_rules === false) {
    const spend = typeof status.spend?.total === "number" ? status.spend.total : null;
    return {
      headline: spend !== null ? `${formatMoney(spend, status.currency)} this period` : "No reward rules configured",
      toneWord: "Budget only",
      tone: "neutral",
      daysLeft: null,
      atRisk: false,
    };
  }

  const currency = status.currency ?? "SGD";
  const daysLeft = typeof status.period?.days_left === "number" ? status.period.days_left : null;
  const atRisk = status.at_risk?.value === true;
  const daysSuffix = daysLeft !== null ? ` · ${daysLeft} day${daysLeft === 1 ? "" : "s"} left` : "";
  const spend = typeof status.spend?.total === "number" ? status.spend.total : 0;
  const gates = status.gates ?? [];
  const anyGateFailed = gates.some((g) => !g.cleared);
  const allGatesCleared = gates.length > 0 && gates.every((g) => g.cleared);
  const cap = status.cap ?? null;

  const headline = `${formatMoney(spend, currency)} this period${daysSuffix}`;

  if (cap?.exhausted) {
    return { headline, toneWord: "Cap reached", tone: "good", daysLeft, atRisk: false };
  }
  if (anyGateFailed && atRisk) {
    return { headline, toneWord: "At risk", tone: "critical", daysLeft, atRisk };
  }
  if (atRisk) {
    return { headline, toneWord: "Unused headroom", tone: "warning", daysLeft, atRisk };
  }
  if (allGatesCleared) {
    return { headline, toneWord: "Cleared", tone: "good", daysLeft, atRisk: false };
  }
  return { headline, toneWord: "On track", tone: "neutral", daysLeft, atRisk: false };
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
// this page is the ONE fact that would change a decision made today —
// which card is closest to a deadline or threshold. Priority: an actively
// at-risk card first (tie-broken by soonest deadline), else simply the
// soonest-ending active period. Cards with no numeric days_left (not yet
// issued, errored, no rules) never win the pick.
export function pickCardToWatch(cards: CardDashboardStatusRow[]): CardWatch | null {
  const candidates = cards
    .map((c) => ({ methodId: c.method_id, displayName: c.display_name, summary: summarizeCardStatus(c.status) }))
    .filter((c): c is CardWatch => c.summary.daysLeft !== null);

  if (candidates.length === 0) return null;

  const atRisk = candidates.filter((c) => c.summary.atRisk);
  const pool = atRisk.length > 0 ? atRisk : candidates;

  return pool.reduce((soonest, c) => ((c.summary.daysLeft as number) < (soonest.summary.daysLeft as number) ? c : soonest));
}
