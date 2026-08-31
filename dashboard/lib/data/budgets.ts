import type { SupabaseClient } from "@supabase/supabase-js";
import type { Budget, BudgetInput } from "../supabase/types";

// Full CRUD, matching the RLS grant in 0008_dashboard_rls.sql
// ("operator manages budgets" — for all, is_operator()). This table is
// currently empty and the dashboard is its only insertion path (§10
// AMENDMENT) — there is no migration or seed data to fall back on.

export async function listBudgets(supabase: SupabaseClient, period?: string): Promise<Budget[]> {
  let query = supabase.from("budgets").select("*").order("category");
  if (period) query = query.eq("period", period);

  const { data, error } = await query;
  if (error) throw error;
  return data as Budget[];
}

export async function upsertBudget(supabase: SupabaseClient, input: BudgetInput): Promise<Budget> {
  const { data, error } = await supabase
    .from("budgets")
    .upsert(
      {
        category: input.category,
        period: input.period,
        monthly_cap: input.monthly_cap,
        alert_at: input.alert_at ?? 0.8,
      },
      { onConflict: "category,period" }
    )
    .select()
    .single();

  if (error) throw error;
  return data as Budget;
}

export async function deleteBudget(supabase: SupabaseClient, id: number): Promise<void> {
  const { error } = await supabase.from("budgets").delete().eq("id", id);
  if (error) throw error;
}
