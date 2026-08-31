import type { Category } from "../supabase/types";

// Fixed categorical slot assignment (docs/DASHBOARD_PLAN.md §3). Slot
// order is the CVD-safety mechanism itself — categories are assigned to
// *existing validated slots*, never reordered to "look nicer" per
// category name. Categories outside the 8-slot cap (plus the synthetic
// 'uncategorised' bucket used when a transaction has no category at all)
// fold into the shared neutral, same as the plan's chart-display rule.
const CATEGORY_SLOT: Partial<Record<Category, string>> = {
  bills: "--series-1",
  dining: "--series-2",
  groceries: "--series-3",
  petrol: "--series-4",
  retail: "--series-5",
  commute: "--series-6",
  online: "--series-7",
  transport: "--series-8",
};

export function categoryColorVar(category: Category | "uncategorised"): string {
  if (category === "uncategorised") return "--series-other";
  return CATEGORY_SLOT[category] ?? "--series-other";
}

// Payment-method identity for the split chart (§3 View 3: "Uses
// categorical slots for the active methods"). A separate fixed mapping
// from the category one above — different entity, same fixed-order
// mechanism (color follows the entity, never its rank). Retired or
// not-yet-issued methods deliberately fall to the shared neutral rather
// than claiming an identity slot they no longer (or don't yet) earn.
const METHOD_SLOT: Record<string, string> = {
  uob_one: "--series-1",
  hsbc_revo: "--series-2",
  paylah: "--series-3",
  manual: "--series-4",
};

export function methodColorVar(methodId: string): string {
  return METHOD_SLOT[methodId] ?? "--series-other";
}
