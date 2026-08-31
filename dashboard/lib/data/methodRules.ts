import type { SupabaseClient } from "@supabase/supabase-js";
import type { MethodRule, RulePreview } from "../supabase/types";

// Read access granted by 0008_dashboard_rls.sql ("operator reads
// method_rules") — unchanged by 0018_config_review.sql, which only added
// the write surface. Every row (any status) is visible to the operator;
// the review queue filters client-side rather than needing a second RLS
// policy for a status subset.

export async function listMethodRules(supabase: SupabaseClient, methodId?: string): Promise<MethodRule[]> {
  let query = supabase.from("method_rules").select("*").order("priority", { ascending: false });
  if (methodId) query = query.eq("method_id", methodId);
  const { data, error } = await query;
  if (error) throw error;
  return data as MethodRule[];
}

export async function listPendingRules(supabase: SupabaseClient): Promise<MethodRule[]> {
  const { data, error } = await supabase
    .from("method_rules")
    .select("*")
    .eq("status", "pending_review")
    .order("id", { ascending: true });
  if (error) throw error;
  return data as MethodRule[];
}

export async function countPendingRules(supabase: SupabaseClient): Promise<number> {
  const { count, error } = await supabase
    .from("method_rules")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending_review");
  if (error) throw error;
  return count ?? 0;
}

// preview_method_rule() (0018): runs the real evaluate_period() twice —
// once as today's live config, once with exactly this pending row
// hypothetically active — and never commits the hypothetical flip. This
// is what makes the review queue's "approve" button a real decision
// rather than raw JSON plus a button (WP5's hard requirement). p_period_key
// omitted defaults to the card's current real period server-side.
export async function previewMethodRule(
  supabase: SupabaseClient,
  ruleId: number,
  periodKey?: string
): Promise<RulePreview> {
  const { data, error } = await supabase.rpc("preview_method_rule", {
    p_rule_id: ruleId,
    p_period_key: periodKey ?? null,
  });
  if (error) throw error;
  return data as RulePreview;
}
