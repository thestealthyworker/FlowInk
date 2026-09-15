"use server";

import { revalidatePath } from "next/cache";
import { deleteSpendSmoothing, getSmoothableTransaction, isTransactionId, upsertSpendSmoothing } from "../data/smoothing";
import { createClient } from "../supabase/server";

const MIN_SMOOTHING_MONTHS = 2;
const MAX_SMOOTHING_MONTHS = 60; // matches 0022's check (months between 2 and 60)

// Operator-only tool, same posture as lib/actions/budgets.ts's own
// comment: throws on invalid input or an RLS rejection rather than
// returning a typed error object.
//
// Upsert, not insert: the Ledger's per-row icon reaches this same form
// whether a transaction is already flagged or not (0022's
// unique(transaction_id) means there's only ever one schedule per
// transaction), so re-submitting for an already-tracked transaction must
// update it in place, not throw a duplicate-key error.
export async function saveSpendSmoothingAction(formData: FormData) {
  const transactionId = String(formData.get("transaction_id") ?? "").trim();
  const label = String(formData.get("label") ?? "").trim();
  const startMonth = String(formData.get("start_month") ?? "").trim();
  const months = Number(formData.get("months"));
  const isSubscription = formData.get("is_subscription") === "on";

  if (!isTransactionId(transactionId)) throw new Error("Missing or invalid transaction.");
  if (!label) throw new Error("A label is required.");
  if (!/^\d{4}-\d{2}$/.test(startMonth)) throw new Error("Start month must be YYYY-MM.");
  if (!Number.isInteger(months) || months < MIN_SMOOTHING_MONTHS || months > MAX_SMOOTHING_MONTHS) {
    throw new Error(`Months must be a whole number between ${MIN_SMOOTHING_MONTHS} and ${MAX_SMOOTHING_MONTHS}.`);
  }

  const supabase = await createClient();

  // Same currency rule as every spend total in this app (lib/data/spend.ts:
  // "foreign-currency rows sit uncosted until reconciliation") — smoothing
  // a non-SGD amount would either silently smooth the wrong figure or
  // require mixing currencies into one monthly total, which nothing else
  // in this dashboard does either.
  const txn = await getSmoothableTransaction(supabase, transactionId);
  if (!txn) throw new Error("Transaction not found.");
  if (txn.currency !== "SGD") {
    throw new Error("Only SGD transactions can be smoothed — this one is still uncosted pending FX reconciliation.");
  }

  await upsertSpendSmoothing(supabase, {
    transaction_id: transactionId,
    label,
    start_month: startMonth,
    months,
    is_subscription: isSubscription,
  });

  revalidatePath("/");
  revalidatePath("/subscriptions");
}

export async function deleteSpendSmoothingAction(formData: FormData) {
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id) || id <= 0) throw new Error("Invalid schedule id.");

  const supabase = await createClient();
  await deleteSpendSmoothing(supabase, id);

  revalidatePath("/");
  revalidatePath("/subscriptions");
}
