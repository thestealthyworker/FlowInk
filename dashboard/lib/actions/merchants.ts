"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "../supabase/server";
import { bulkAssignCategory, updateMerchantTriage } from "../data/merchants";
import { isCategory } from "../supabase/types";

export async function updateMerchantTriageAction(formData: FormData) {
  const merchantId = Number(formData.get("merchant_id"));
  const category = String(formData.get("category") ?? "");
  const isTransfer = formData.get("is_transfer") === "on";
  const confirm = formData.get("confirm") === "on";

  if (!Number.isFinite(merchantId)) throw new Error("Invalid merchant id.");
  if (!isCategory(category)) throw new Error(`Invalid category: ${category}`);

  const supabase = await createClient();
  await updateMerchantTriage(supabase, merchantId, {
    category,
    is_transfer: isTransfer,
    confidence: confirm ? "confirmed" : "guessed",
  });

  revalidatePath("/triage");
}

export async function bulkAssignCategoryAction(formData: FormData) {
  const ids = formData
    .getAll("merchant_ids")
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n));
  const category = String(formData.get("bulk_category") ?? "");

  if (ids.length === 0) throw new Error("No merchants selected.");
  if (!isCategory(category)) throw new Error(`Invalid category: ${category}`);

  const supabase = await createClient();
  await bulkAssignCategory(supabase, ids, { category, confidence: "confirmed" });
  revalidatePath("/triage");
}
