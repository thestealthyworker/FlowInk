import type { SupabaseClient } from "@supabase/supabase-js";
import type { CardDashboardStatusRow } from "../supabase/types";

// The rules-engine bulk view (0007_rules_engine.sql), reachable only
// because 0008_dashboard_rls.sql granted EXECUTE on this function and
// every function it transitively calls to `authenticated` — see that
// migration's comment for the full call graph. Deterministic SQL under
// the hood, per §9: "the model may parse and classify; it must never
// decide whether a threshold was met." Nothing here recomputes anything.
export async function getCardDashboardStatus(
  supabase: SupabaseClient
): Promise<CardDashboardStatusRow[]> {
  const { data, error } = await supabase.rpc("card_dashboard_status");
  if (error) throw error;
  return data as CardDashboardStatusRow[];
}
