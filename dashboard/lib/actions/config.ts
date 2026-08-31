"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "../supabase/server";
import { isCategory, type Category } from "../supabase/types";

// The config review/edit surface's server actions (WP5). Every write here
// goes through one of the RPCs 0018_config_review.sql defines —
// approve_method_rule / reject_method_rule / edit_method_rule /
// load_example_data_singapore / clear_example_data — or a column-scoped
// .update() (payment_methods.active) that migration's own RLS policy
// restricts to exactly that column. Nothing here recomputes a rule's
// effect or re-implements the validation those RPCs (and the trigger
// behind edit_method_rule) already own — same "the database decides,
// this layer only calls it" posture as every other actions file in this
// app (lib/actions/budgets.ts, lib/actions/merchants.ts). Throws on
// error rather than returning a typed error object, matching those
// files' own documented rationale: this is an operator-only tool.

function requireRuleId(formData: FormData): number {
  const id = Number(formData.get("rule_id"));
  if (!Number.isFinite(id)) throw new Error("Invalid rule id.");
  return id;
}

/** Optional numeric field: empty string -> null, otherwise a finite
 * number or a thrown error — never silently coerced to 0 or NaN. */
function optionalNumber(formData: FormData, field: string): number | null {
  const raw = formData.get(field);
  if (raw === null || String(raw).trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${field} must be a number.`);
  return n;
}

function optionalInt(formData: FormData, field: string): number | null {
  const n = optionalNumber(formData, field);
  if (n === null) return null;
  if (!Number.isInteger(n)) throw new Error(`${field} must be a whole number.`);
  return n;
}

function optionalCategories(formData: FormData, field: string): Category[] | null {
  const values = formData.getAll(field).map(String).filter(Boolean);
  if (values.length === 0) return null;
  for (const v of values) {
    if (!isCategory(v)) throw new Error(`Invalid category: ${v}`);
  }
  return values as Category[];
}

export async function approveRuleAction(formData: FormData) {
  const ruleId = requireRuleId(formData);
  const note = String(formData.get("review_note") ?? "").trim() || null;

  const supabase = await createClient();
  const { error } = await supabase.rpc("approve_method_rule", { p_rule_id: ruleId, p_review_note: note });
  if (error) throw error;

  revalidatePath("/config");
}

export async function rejectRuleAction(formData: FormData) {
  const ruleId = requireRuleId(formData);
  // Deliberately not required client-side either: reject_method_rule()
  // (0018) itself fills in a generic placeholder note when this is empty
  // — "rejecting must be as easy as approving" (WP5's hard requirement),
  // never blocked on typing a reason, but a trace is always left.
  const note = String(formData.get("review_note") ?? "").trim() || null;

  const supabase = await createClient();
  const { error } = await supabase.rpc("reject_method_rule", { p_rule_id: ruleId, p_review_note: note });
  if (error) throw error;

  revalidatePath("/config");
}

/** Edits an existing row's proposal/rule fields (rate/threshold/cap/
 * payout/txn_min/categories/notes/valid_to) via edit_method_rule() (0018)
 * — the SAME BEFORE INSERT OR UPDATE trigger validates this as a new
 * AI-authored proposal. Does not touch status: correcting a still-pending
 * row before approving it leaves it pending; correcting an already-active
 * row does not silently re-trigger a review. */
export async function editRuleAction(formData: FormData) {
  const ruleId = requireRuleId(formData);
  const rate = optionalNumber(formData, "rate");
  const threshold = optionalNumber(formData, "threshold");
  const capAmount = optionalNumber(formData, "cap_amount");
  const payout = optionalNumber(formData, "payout");
  const txnMin = optionalInt(formData, "txn_min");
  const categories = optionalCategories(formData, "categories");
  const notes = String(formData.get("notes") ?? "").trim() || null;
  const validTo = String(formData.get("valid_to") ?? "").trim() || null;

  const supabase = await createClient();
  const { error } = await supabase.rpc("edit_method_rule", {
    p_rule_id: ruleId,
    p_rate: rate,
    p_threshold: threshold,
    p_cap_amount: capAmount,
    p_payout: payout,
    p_txn_min: txnMin,
    p_categories: categories,
    p_notes: notes,
    p_valid_to: validTo,
  });
  if (error) throw error;

  revalidatePath("/config");
}

/** Column-scoped: 0018's RLS grant on payment_methods is restricted to
 * the `active` column alone (matching merchants' triage-column grant,
 * 0008), so this can never reach issuer/last4/cycle_day/etc. even though
 * the row itself is selectable for update. */
export async function toggleCardActiveAction(formData: FormData) {
  const methodId = String(formData.get("method_id") ?? "");
  const nextActive = formData.get("next_active") === "true";
  if (!methodId) throw new Error("Invalid payment method id.");

  const supabase = await createClient();
  const { error } = await supabase.from("payment_methods").update({ active: nextActive }).eq("id", methodId);
  if (error) throw error;

  revalidatePath("/config");
}

export async function loadExampleDataAction() {
  const supabase = await createClient();
  const { error } = await supabase.rpc("load_example_data_singapore");
  if (error) throw error;

  revalidatePath("/config");
  revalidatePath("/");
  revalidatePath("/cards");
}

export async function clearExampleDataAction() {
  const supabase = await createClient();
  const { error } = await supabase.rpc("clear_example_data");
  if (error) throw error;

  revalidatePath("/config");
  revalidatePath("/");
  revalidatePath("/cards");
}
