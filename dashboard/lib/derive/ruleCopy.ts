import { formatMoney } from "@/components/honest-data/MoneyFigure";
import type { Category, MethodRule } from "@/lib/supabase/types";

// Pure copy-generation for the config review surface (WP5) — same rule
// cardCopy.ts (WP4) already follows: turn fields the schema/contract
// already has into a sentence, never invent or recompute a number. A
// reviewer judging a proposed rule needs to read its rate/threshold/
// cap/categories/period in plain terms, not method_rules' raw column
// names — this is what makes that possible without reading JSON.

function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export function formatCategories(categories: Category[] | null): string {
  if (!categories || categories.length === 0) return "everything";
  return categories.map(titleCase).join(" & ");
}

/** rate is stored as a fraction (0.0467 = 4.67% cashback) or, for a
 * miles card, as miles-per-dollar directly (4.0 = 4 mpd) — the same
 * distinction payment_methods.reward_type already carries everywhere
 * else in this app (lib/derive/cardCopy.ts's prettifyUnit). */
export function formatRate(rate: string | number | null, rewardType: "cashback" | "miles" | null): string {
  if (rate === null) return "—";
  const n = typeof rate === "string" ? Number(rate) : rate;
  if (rewardType === "miles") {
    return `${n} mpd`;
  }
  const pct = n * 100;
  const rounded = Math.round(pct * 100) / 100;
  return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(2)}%`;
}

export function formatPeriod(validFrom: string, validTo: string | null): string {
  return validTo ? `${validFrom} to ${validTo}` : `from ${validFrom}, ongoing`;
}

/**
 * One plain-language sentence describing what a method_rules row
 * actually claims — the thing a reviewer has to judge is right or wrong,
 * independent of its status. Every branch reads only fields the schema
 * already carries (0001, 0015, 0018); nothing here is a per-card special
 * case — the same function renders every rule_type for every card.
 */
export function describeRuleClaim(
  rule: MethodRule,
  card: { reward_type: "cashback" | "miles" | null; currency: string }
): string {
  const money = (amount: string | number | null) => (amount === null ? "—" : formatMoney(Number(amount), card.currency));
  const cats = formatCategories(rule.categories);

  switch (rule.rule_type) {
    case "category_rate": {
      const rate = formatRate(rule.rate, card.reward_type);
      const gate = rule.threshold !== null ? `, once spend reaches ${money(rule.threshold)} this period` : "";
      return `${rate} on ${cats}${gate}.`;
    }
    case "tier": {
      const form = rule.reward_form ?? "fixed_payout";
      const reward = form === "fixed_payout" ? `a flat ${money(rule.payout)}` : `${formatRate(rule.rate, card.reward_type)}`;
      const txn = rule.txn_min ? ` and at least ${rule.txn_min} transaction${rule.txn_min === 1 ? "" : "s"}` : "";
      return `Pays ${reward} once spend reaches ${money(rule.threshold)}${txn} this period.`;
    }
    case "cap": {
      const basis = rule.cap_basis === "spend" ? "eligible spend" : "total reward";
      const crediting =
        rule.credit_block_size !== null
          ? ` Credits in ${money(rule.credit_block_size)} blocks, only once accrual reaches ${money(rule.credit_floor ?? 0)}.`
          : "";
      return `Caps ${basis} at ${money(rule.cap_amount)} per period.${crediting}`;
    }
    case "min_spend": {
      const effect =
        rule.gate_scope === "all_rewards"
          ? "every category drops to the base rate for the whole period"
          : "shown as a gate status only — does not change what any other rule pays";
      return `Requires at least ${money(rule.threshold)} spend this period; below it, ${effect}.`;
    }
    case "txn_count": {
      const effect =
        rule.gate_scope === "all_rewards"
          ? "every category drops to the base rate for the whole period"
          : "shown as a gate status only — does not change what any other rule pays";
      return `Requires at least ${rule.txn_min ?? 0} transaction${(rule.txn_min ?? 0) === 1 ? "" : "s"} this period; below it, ${effect}.`;
    }
    case "quarterly_gate":
      return "Legacy rule type — not read by the current evaluator (superseded by the card's own aggregation window). Safe to reject or leave as-is; it has no live effect.";
    default:
      return "Unrecognised rule type.";
  }
}

export function confidenceLabel(confidence: number | null): string {
  if (confidence === null) return "not given";
  if (confidence >= 0.75) return "high";
  if (confidence >= 0.4) return "medium";
  return "low";
}
