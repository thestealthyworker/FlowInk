import type { MethodSplit } from "../data/spend";
import type { PaymentMethod } from "../supabase/types";
import { methodColorVar } from "./seriesColor";

export interface MethodSplitRow {
  method_id: string;
  displayName: string;
  total: number;
  count: number;
  share: number;
  colorVar: string;
  tone: "active" | "retired";
}

/** Cross-references getPaymentMethodSplit's totals (method_id only) with
 * listPaymentMethods' display names and active flag — the retired
 * dbs_posb_platinum method (§3 View 3) renders dashed/reduced-opacity
 * rather than being indistinguishable from an active method. Zero-spend
 * methods (Citi, not yet issued) are dropped rather than rendered as an
 * empty ghost segment — the ghost treatment belongs to the card strip,
 * which already carries that state explicitly. */
export function buildMethodSplitRows(splits: MethodSplit[], methods: PaymentMethod[]): MethodSplitRow[] {
  const byId = new Map(methods.map((m) => [m.id, m]));
  const grandTotal = splits.reduce((sum, r) => sum + r.total, 0);

  return splits
    .filter((r) => r.total > 0)
    .map((r) => {
      const method = byId.get(r.method_id);
      return {
        method_id: r.method_id,
        displayName: method?.display_name ?? r.method_id,
        total: r.total,
        count: r.count,
        share: grandTotal > 0 ? r.total / grandTotal : 0,
        colorVar: methodColorVar(r.method_id),
        tone: method?.active === false ? "retired" : "active",
      } satisfies MethodSplitRow;
    })
    .sort((a, b) => b.total - a.total);
}
