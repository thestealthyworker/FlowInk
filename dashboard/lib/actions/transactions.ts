"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "../supabase/server";
import { deleteManualTransaction, insertManualTransaction } from "../data/transactions";
import { isCategory } from "../supabase/types";

export async function createManualTransactionAction(formData: FormData) {
  const txn_date = String(formData.get("txn_date") ?? "");
  const merchant_raw = String(formData.get("merchant_raw") ?? "").trim();
  const amount = Number(formData.get("amount"));
  const currency = String(formData.get("currency") ?? "SGD").trim().toUpperCase();
  const category = String(formData.get("category") ?? "");
  const is_transfer = formData.get("is_transfer") === "on";

  if (!txn_date) throw new Error("Date is required.");
  if (!merchant_raw) throw new Error("Merchant / description is required.");
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Amount must be a positive number.");
  if (!isCategory(category)) throw new Error(`Invalid category: ${category}`);
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Currency must be a 3-letter ISO code.");

  const supabase = await createClient();
  await insertManualTransaction(supabase, {
    method_id: "manual",
    txn_date,
    merchant_raw,
    amount,
    currency,
    category,
    is_transfer,
  });

  revalidatePath("/transactions/new");
  revalidatePath("/");
}

export async function deleteManualTransactionAction(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) throw new Error("Invalid transaction id.");

  const supabase = await createClient();
  // RLS (0008_dashboard_rls.sql) restricts this delete to source='manual'
  // rows regardless of what id is passed here — attempting to delete a
  // bank-sourced row affects zero rows rather than erroring, which
  // .delete() without .select() does not distinguish from success. That
  // is acceptable for this action specifically because the UI only ever
  // renders delete buttons next to manual rows in the first place
  // (lib/data/transactions.ts's listManualTransactions filters
  // source='manual'); Task 5's verification tests the RLS boundary
  // directly via curl, not through this code path.
  await deleteManualTransaction(supabase, id);
  revalidatePath("/transactions/new");
}
