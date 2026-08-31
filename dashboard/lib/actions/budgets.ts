"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "../supabase/server";
import { deleteBudget, upsertBudget } from "../data/budgets";
import { isCategory } from "../supabase/types";

// These admin actions throw on invalid input or a Postgres/RLS rejection
// rather than returning a typed error object: this is an operator-only
// tool, not a public form, and Task 5's curl-based verification is the
// real test of the RLS boundary — an uncaught error surfacing Next.js's
// error UI with the underlying Postgres message is an acceptable (if not
// polished) failure mode here. Polished error UX is explicitly out of
// scope for this pass.
export async function saveBudgetAction(formData: FormData) {
  const category = String(formData.get("category") ?? "");
  const period = String(formData.get("period") ?? "").trim();
  const monthlyCap = Number(formData.get("monthly_cap"));
  const alertAtRaw = formData.get("alert_at");
  const alertAt = alertAtRaw ? Number(alertAtRaw) : undefined;

  if (!isCategory(category)) throw new Error(`Invalid category: ${category}`);
  if (!period) throw new Error("Period is required (YYYY-MM or 'default').");
  if (!Number.isFinite(monthlyCap) || monthlyCap <= 0) {
    throw new Error("Monthly cap must be a positive number.");
  }
  if (alertAt !== undefined && (!Number.isFinite(alertAt) || alertAt <= 0 || alertAt > 1)) {
    throw new Error("Alert threshold must be between 0 and 1.");
  }

  const supabase = await createClient();
  await upsertBudget(supabase, { category, period, monthly_cap: monthlyCap, alert_at: alertAt });
  revalidatePath("/budgets");
}

export async function deleteBudgetAction(formData: FormData) {
  const id = Number(formData.get("id"));
  if (!Number.isFinite(id)) throw new Error("Invalid budget id.");

  const supabase = await createClient();
  await deleteBudget(supabase, id);
  revalidatePath("/budgets");
}
