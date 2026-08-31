import type { SupabaseClient } from "@supabase/supabase-js";
import type { Transaction } from "../supabase/types";

// Additive read-only query for the Command Center's daily heatmap
// (redesign/visuals) — same spend_transactions + is_transfer/currency
// filtering convention every other lib/data/spend.ts query already uses.

export interface DailySpend {
  txn_date: string;
  total: number;
}

export async function getDailySpend(supabase: SupabaseClient, dateFrom: string, dateTo: string): Promise<DailySpend[]> {
  const { data, error } = await supabase
    .from("spend_transactions")
    .select("txn_date, amount, is_transfer, currency")
    .eq("is_transfer", false)
    .eq("currency", "SGD")
    .gte("txn_date", dateFrom)
    .lte("txn_date", dateTo);

  if (error) throw error;

  const byDay = new Map<string, number>();
  for (const row of (data ?? []) as Array<Pick<Transaction, "txn_date" | "amount">>) {
    byDay.set(row.txn_date, (byDay.get(row.txn_date) ?? 0) + Number(row.amount));
  }

  return [...byDay.entries()].map(([txn_date, total]) => ({ txn_date, total })).sort((a, b) => a.txn_date.localeCompare(b.txn_date));
}
