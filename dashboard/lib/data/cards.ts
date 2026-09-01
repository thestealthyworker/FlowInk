import type { SupabaseClient } from "@supabase/supabase-js";
import type { CardDashboardStatusRow } from "../supabase/types";

// The rules-engine bulk view (0007_rules_engine.sql: card_dashboard_status,
// unchanged by WP4's cutover), reachable only because 0008_dashboard_rls.sql
// granted EXECUTE on this function and every function it transitively calls
// to `authenticated` — see that migration's comment for the full call
// graph. As of 0017_repoint_card_period_status.sql, card_period_status()
// (which this loops per method) dispatches to the generic evaluator
// (evaluate_period()/evaluate_period_group(), 0015) instead of the old
// per-card functions — the row shape returned here changed accordingly
// (lib/supabase/types.ts's CardPeriodStatus), but this file's own contract
// (method_id, display_name, status) is unaffected. Deterministic SQL under
// the hood, per docs/architecture.md §6: "the model may parse and
// classify; it must never decide whether a threshold was met." Nothing
// here recomputes anything.
export async function getCardDashboardStatus(
  supabase: SupabaseClient
): Promise<CardDashboardStatusRow[]> {
  const { data, error } = await supabase.rpc("card_dashboard_status");
  if (error) throw error;
  return data as CardDashboardStatusRow[];
}
