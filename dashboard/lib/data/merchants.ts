import type { SupabaseClient } from "@supabase/supabase-js";
import type { Merchant, MerchantTriageUpdate, Transaction } from "../supabase/types";

// Task 4: merchant triage. 251 merchants sit at confidence = 'guessed'
// (loaded 2026-08-25, see docs/SETUP_STATUS.md); ~51 seen 2+ times are
// the real burden this absorbed from the deleted Telegram job (§10
// AMENDMENT). This module only ever touches category / is_transfer /
// confidence — 0008_dashboard_rls.sql's column-level grant on merchants
// enforces that server-side even if a caller here tried to send more.

export interface MerchantTriageRow {
  merchant: Merchant;
  txn_count: number;
  total_amount: number;
}

export async function listGuessedMerchants(supabase: SupabaseClient): Promise<MerchantTriageRow[]> {
  const { data: merchants, error: merchantsError } = await supabase
    .from("merchants")
    .select("*")
    .eq("confidence", "guessed")
    .order("display_name");

  if (merchantsError) throw merchantsError;

  const { data: txns, error: txnsError } = await supabase
    .from("transactions")
    .select("merchant_id, amount")
    .not("merchant_id", "is", null);

  if (txnsError) throw txnsError;

  const statsByMerchant = new Map<number, { count: number; total: number }>();
  for (const row of (txns ?? []) as Array<Pick<Transaction, "merchant_id" | "amount">>) {
    if (row.merchant_id === null) continue;
    const existing = statsByMerchant.get(row.merchant_id) ?? { count: 0, total: 0 };
    existing.count += 1;
    existing.total += Number(row.amount);
    statsByMerchant.set(row.merchant_id, existing);
  }

  return ((merchants ?? []) as Merchant[])
    .map((merchant) => {
      const stats = statsByMerchant.get(merchant.id) ?? { count: 0, total: 0 };
      return { merchant, txn_count: stats.count, total_amount: stats.total };
    })
    .sort((a, b) => b.txn_count - a.txn_count);
}

/** Lightweight id-only read, distinct from `listGuessedMerchants` above
 * (which also joins transaction stats for the triage page's full list).
 * Two call sites need only "which ids are guessed": the nav rail's badge
 * count, and the home view's category bars cross-referencing merchant_id
 * to decide whether a category carries the dotted "guessed" mark (§4). */
export async function listGuessedMerchantIds(supabase: SupabaseClient): Promise<Set<number>> {
  const { data, error } = await supabase.from("merchants").select("id").eq("confidence", "guessed");
  if (error) throw error;
  return new Set(((data ?? []) as Array<Pick<Merchant, "id">>).map((m) => m.id));
}

/** Confirmed merchants, for triage's "re-classify" mode (Phase D3): with
 * 0 of 251 merchants still 'guessed', re-pointing an already-confirmed
 * merchant to a different category is now the page's main job, not a
 * hypothetical follow-up. Optional `search` filters by display name or
 * match pattern (case-insensitive `ilike`) — 251+ confirmed rows is too
 * many to browse unfiltered on a page meant for occasional correction. */
export async function listConfirmedMerchants(
  supabase: SupabaseClient,
  search?: string
): Promise<MerchantTriageRow[]> {
  let query = supabase.from("merchants").select("*").eq("confidence", "confirmed").order("display_name");
  if (search && search.trim()) {
    const term = `%${search.trim()}%`;
    query = query.or(`display_name.ilike.${term},match_pattern.ilike.${term}`);
  }

  const { data: merchants, error: merchantsError } = await query;
  if (merchantsError) throw merchantsError;

  const { data: txns, error: txnsError } = await supabase
    .from("transactions")
    .select("merchant_id, amount")
    .not("merchant_id", "is", null);

  if (txnsError) throw txnsError;

  const statsByMerchant = new Map<number, { count: number; total: number }>();
  for (const row of (txns ?? []) as Array<Pick<Transaction, "merchant_id" | "amount">>) {
    if (row.merchant_id === null) continue;
    const existing = statsByMerchant.get(row.merchant_id) ?? { count: 0, total: 0 };
    existing.count += 1;
    existing.total += Number(row.amount);
    statsByMerchant.set(row.merchant_id, existing);
  }

  return ((merchants ?? []) as Merchant[])
    .map((merchant) => {
      const stats = statsByMerchant.get(merchant.id) ?? { count: 0, total: 0 };
      return { merchant, txn_count: stats.count, total_amount: stats.total };
    })
    .sort((a, b) => b.txn_count - a.txn_count);
}

export async function updateMerchantTriage(
  supabase: SupabaseClient,
  merchantId: number,
  patch: MerchantTriageUpdate
): Promise<Merchant> {
  const { data, error } = await supabase
    .from("merchants")
    .update(patch)
    .eq("id", merchantId)
    .select()
    .single();

  if (error) throw error;
  return data as Merchant;
}

// Bulk-assign: same category (or transfer flag) to several merchants at
// once, since ~51 recurring merchants is the real burden and one-at-a-
// time confirmation does not scale. Runs as N updates rather than a
// single statement — supabase-js has no bulk-update-by-id-list primitive
// over PostgREST without an `in()` filter plus a single shared patch,
// which is exactly what distinguishes "bulk assign one category to many
// merchants" from "each merchant gets its own values" (the general triage
// case above). Provided as a convenience for the common "assign this
// category to these N merchants" action.
export async function bulkAssignCategory(
  supabase: SupabaseClient,
  merchantIds: number[],
  patch: MerchantTriageUpdate
): Promise<void> {
  if (merchantIds.length === 0) return;
  const { error } = await supabase.from("merchants").update(patch).in("id", merchantIds);
  if (error) throw error;
}
