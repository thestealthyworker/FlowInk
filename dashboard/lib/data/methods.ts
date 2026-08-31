import type { SupabaseClient } from "@supabase/supabase-js";
import type { PaymentMethod } from "../supabase/types";

// The one genuinely new read this phase adds (docs/DASHBOARD_PLAN.md §3
// View 3, "payment method split"). getPaymentMethodSplit (lib/data/spend.ts)
// returns only method_id + totals; the split mark additionally needs each
// method's display name and active flag so the retired dbs_posb_platinum
// segment can render dashed/reduced-opacity rather than looking like an
// ordinary active method. Read access already granted —
// 0008_dashboard_rls.sql: "operator reads payment_methods".
export async function listPaymentMethods(supabase: SupabaseClient): Promise<PaymentMethod[]> {
  const { data, error } = await supabase.from("payment_methods").select("*").order("id");
  if (error) throw error;
  return data as PaymentMethod[];
}
