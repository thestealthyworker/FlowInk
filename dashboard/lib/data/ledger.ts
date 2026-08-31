import type { SupabaseClient } from "@supabase/supabase-js";
import type { Category, Merchant, PaymentMethod, Transaction, TxnStatus } from "../supabase/types";

// Read-only transaction ledger for the /transactions view. Additive only —
// does not touch transactions.ts's manual-entry write path. Queries
// spend_transactions (not transactions directly) so the ledger inherits the
// same reconciled-row and reversed-status exclusions every other spend view
// already relies on (supabase/migrations/0001_schema.sql, 0006).
//
// Filtering/sorting/pagination all happen in TypeScript after one fetch,
// matching the existing convention in lib/data/spend.ts and merchants.ts
// (documented there as deliberate at this data volume, not an oversight) —
// merchant/method display names are resolved via separate lookups the same
// way merchants.ts already does, since this schema has no PostgREST embed
// convention in use anywhere else in the codebase.

const LEDGER_COLUMNS =
  "id, txn_date, merchant_raw, merchant_id, method_id, amount, currency, fx_amount, category, status, is_transfer";

type LedgerSourceRow = Pick<
  Transaction,
  | "id"
  | "txn_date"
  | "merchant_raw"
  | "merchant_id"
  | "method_id"
  | "amount"
  | "currency"
  | "fx_amount"
  | "category"
  | "status"
  | "is_transfer"
>;

export interface LedgerRow {
  id: string;
  txn_date: string;
  merchant_display: string;
  merchant_raw: string;
  merchant_id: number | null;
  category: Category | "uncategorised";
  method_id: string;
  method_display_name: string;
  method_last4: string | null;
  amount: number;
  currency: string;
  fx_amount: number | null;
  status: TxnStatus;
  is_transfer: boolean;
}

export interface LedgerFilters {
  calendarMonth?: string;
  dateFrom?: string;
  dateTo?: string;
  category?: Category;
  methodId?: string;
  search?: string;
  minAmount?: number;
  maxAmount?: number;
  includeTransfers?: boolean;
}

export type LedgerSortField = "txn_date" | "amount";

export interface LedgerSort {
  field: LedgerSortField;
  direction: "asc" | "desc";
}

export interface LedgerPage {
  rows: LedgerRow[];
  total: number;
}

const DEFAULT_SORT: LedgerSort = { field: "txn_date", direction: "desc" };

export async function listTransactions(
  supabase: SupabaseClient,
  filters: LedgerFilters = {},
  sort: LedgerSort = DEFAULT_SORT,
  page: { limit: number; offset: number } = { limit: 50, offset: 0 }
): Promise<LedgerPage> {
  let query = supabase.from("spend_transactions").select(LEDGER_COLUMNS);

  if (filters.calendarMonth) query = query.eq("calendar_month", filters.calendarMonth);
  if (filters.dateFrom) query = query.gte("txn_date", filters.dateFrom);
  if (filters.dateTo) query = query.lte("txn_date", filters.dateTo);
  if (filters.category) query = query.eq("category", filters.category);
  if (filters.methodId) query = query.eq("method_id", filters.methodId);
  if (typeof filters.minAmount === "number") query = query.gte("amount", filters.minAmount);
  if (typeof filters.maxAmount === "number") query = query.lte("amount", filters.maxAmount);
  if (!filters.includeTransfers) query = query.eq("is_transfer", false);

  const { data, error } = await query;
  if (error) throw error;

  const [{ data: merchants, error: merchantsError }, { data: methods, error: methodsError }] = await Promise.all([
    supabase.from("merchants").select("id, display_name"),
    supabase.from("payment_methods").select("id, display_name, last4"),
  ]);
  if (merchantsError) throw merchantsError;
  if (methodsError) throw methodsError;

  const merchantNameById = new Map(
    ((merchants ?? []) as Array<Pick<Merchant, "id" | "display_name">>).map((m) => [m.id, m.display_name])
  );
  const methodById = new Map(
    ((methods ?? []) as Array<Pick<PaymentMethod, "id" | "display_name" | "last4">>).map((m) => [m.id, m])
  );

  let rows: LedgerRow[] = ((data ?? []) as LedgerSourceRow[]).map((row) => {
    const method = methodById.get(row.method_id);
    return {
      id: row.id,
      txn_date: row.txn_date,
      merchant_display: (row.merchant_id !== null && merchantNameById.get(row.merchant_id)) || row.merchant_raw,
      merchant_raw: row.merchant_raw,
      merchant_id: row.merchant_id,
      category: row.category ?? "uncategorised",
      method_id: row.method_id,
      method_display_name: method?.display_name ?? row.method_id,
      method_last4: method?.last4 ?? null,
      amount: Number(row.amount),
      currency: row.currency,
      fx_amount: row.fx_amount === null ? null : Number(row.fx_amount),
      status: row.status,
      is_transfer: row.is_transfer,
    };
  });

  if (filters.search) {
    const needle = filters.search.trim().toLowerCase();
    if (needle) {
      rows = rows.filter(
        (r) => r.merchant_display.toLowerCase().includes(needle) || r.merchant_raw.toLowerCase().includes(needle)
      );
    }
  }

  const direction = sort.direction === "asc" ? 1 : -1;
  rows.sort((a, b) => {
    if (sort.field === "amount") return (a.amount - b.amount) * direction;
    return a.txn_date.localeCompare(b.txn_date) * direction;
  });

  const total = rows.length;
  const paged = rows.slice(page.offset, page.offset + page.limit);

  return { rows: paged, total };
}

export interface LedgerFacets {
  categories: Array<Category | "uncategorised">;
  methods: Array<{ id: string; display_name: string; last4: string | null }>;
}

/** Distinct filter-chip options for the ledger toolbar, scoped to whatever
 * calendarMonth/date-range the caller is already filtering by so the UI
 * never offers a chip with zero matching rows. */
export async function getLedgerFacets(
  supabase: SupabaseClient,
  filters: Pick<LedgerFilters, "calendarMonth" | "dateFrom" | "dateTo"> = {}
): Promise<LedgerFacets> {
  const { rows } = await listTransactions(supabase, filters, DEFAULT_SORT, { limit: Number.MAX_SAFE_INTEGER, offset: 0 });

  const categories = new Set<Category | "uncategorised">();
  const methods = new Map<string, { id: string; display_name: string; last4: string | null }>();
  for (const row of rows) {
    categories.add(row.category);
    if (!methods.has(row.method_id)) {
      methods.set(row.method_id, { id: row.method_id, display_name: row.method_display_name, last4: row.method_last4 });
    }
  }

  return {
    categories: [...categories].sort(),
    methods: [...methods.values()].sort((a, b) => a.display_name.localeCompare(b.display_name)),
  };
}
