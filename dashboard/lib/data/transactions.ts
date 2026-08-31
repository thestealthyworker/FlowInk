import type { SupabaseClient } from "@supabase/supabase-js";
import type { ManualTransactionInput, Transaction } from "../supabase/types";

// The manual-entry write path (§10 AMENDMENT, §14 "cash is invisible").
// method_id is always 'manual' (0009_manual_payment_method.sql) —
// non-card spend has no other bucket to point at. source_ref is
// deliberately omitted: the schema's own CHECK constraint
// (source = 'manual' or source_ref is not null) allows a null
// source_ref ONLY for manual rows, precisely so hand-entered spend needs
// no synthetic reference value.
//
// RLS (0008_dashboard_rls.sql, "operator inserts manual transactions")
// enforces source = 'manual' server-side via WITH CHECK regardless of
// what this function sends — it is set explicitly here anyway so the
// insert payload is self-documenting and a mismatch fails loudly as a
// Postgres permission error rather than silently relying on the policy
// alone to catch a typo.
export async function insertManualTransaction(
  supabase: SupabaseClient,
  input: ManualTransactionInput
): Promise<Transaction> {
  const calendarMonth = input.txn_date.slice(0, 7); // 'YYYY-MM-DD' -> 'YYYY-MM'

  const { data, error } = await supabase
    .from("transactions")
    .insert({
      method_id: "manual",
      txn_date: input.txn_date,
      merchant_raw: input.merchant_raw,
      amount: input.amount,
      currency: input.currency,
      category: input.category,
      is_transfer: input.is_transfer,
      status: "confirmed", // a manual entry has no provisional/alert stage to pass through
      source: "manual",
      source_ref: null,
      period_key: `manual:${calendarMonth}`, // 'manual' has_rules = false; no card engine ever reads this key
      calendar_month: calendarMonth,
    })
    .select()
    .single();

  if (error) throw error;
  return data as Transaction;
}

export async function listManualTransactions(
  supabase: SupabaseClient,
  calendarMonth: string
): Promise<Transaction[]> {
  const { data, error } = await supabase
    .from("transactions")
    .select("*")
    .eq("source", "manual")
    .eq("calendar_month", calendarMonth)
    .order("txn_date", { ascending: false });

  if (error) throw error;
  return data as Transaction[];
}

export async function updateManualTransaction(
  supabase: SupabaseClient,
  id: string,
  patch: Partial<ManualTransactionInput>
): Promise<Transaction> {
  const { data, error } = await supabase
    .from("transactions")
    .update(patch)
    .eq("id", id)
    .select()
    .single();

  // RLS silently returns zero rows (not an error) if `id` is not a
  // source='manual' row — PostgREST then reports "no rows" from
  // .single(), which surfaces as an error here. That is the intended
  // behaviour: attempting to edit a bank-sourced row must fail visibly,
  // not silently no-op.
  if (error) throw error;
  return data as Transaction;
}

export async function deleteManualTransaction(supabase: SupabaseClient, id: string): Promise<void> {
  const { error } = await supabase.from("transactions").delete().eq("id", id);
  if (error) throw error;
}
