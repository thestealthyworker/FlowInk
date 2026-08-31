import type { SupabaseClient } from "@supabase/supabase-js";
import { trailingCalendarMonths } from "../date";
import { CATEGORIES, type Category, type Transaction } from "../supabase/types";

// All spend aggregation reads from spend_transactions (0001_schema.sql),
// never straight from transactions: that view already excludes a
// reconciled statement row that restates spend an alert row already
// counted (§9/§14 double-counting rule). Every query here additionally
// filters `is_transfer = false` on top of it, per that view's own
// comment — PayLah P2P sends and top-ups are not spend.
//
// Aggregation happens here in TypeScript after fetching rows, not via a
// Postgres RPC: at this data volume (508 transactions total, growing by
// ~100/month) a GROUP BY round-trip buys nothing PostgREST's own row
// fetch + in-memory reduce doesn't already do just as correctly, and it
// avoids adding database functions beyond what Task 1 already grants.

const SPEND_COLUMNS =
  "id, method_id, txn_date, amount, currency, category, calendar_month, is_transfer, status";

type SpendRow = Pick<
  Transaction,
  "id" | "method_id" | "txn_date" | "amount" | "currency" | "category" | "calendar_month" | "is_transfer" | "status"
>;

export interface CategorySpend {
  category: Category | "uncategorised";
  total: number;
  count: number;
}

export async function getMonthlySpendByCategory(
  supabase: SupabaseClient,
  calendarMonth: string
): Promise<CategorySpend[]> {
  const { data, error } = await supabase
    .from("spend_transactions")
    .select(SPEND_COLUMNS)
    .eq("calendar_month", calendarMonth)
    .eq("is_transfer", false)
    .eq("currency", "SGD"); // foreign-currency rows sit uncosted until reconciliation, §4/§14

  if (error) throw error;

  const byCategory = new Map<string, CategorySpend>();
  for (const row of (data ?? []) as SpendRow[]) {
    const key = row.category ?? "uncategorised";
    const existing = byCategory.get(key) ?? { category: key as Category | "uncategorised", total: 0, count: 0 };
    existing.total += Number(row.amount);
    existing.count += 1;
    byCategory.set(key, existing);
  }

  return [...byCategory.values()].sort((a, b) => b.total - a.total);
}

export interface MonthlyTotal {
  calendar_month: string;
  total: number;
}

export async function getTwelveMonthTrend(
  supabase: SupabaseClient,
  throughCalendarMonth: string
): Promise<MonthlyTotal[]> {
  // 'YYYY-MM' compares lexically the same as chronologically.
  const [y, m] = throughCalendarMonth.split("-").map(Number);
  const startDate = new Date(Date.UTC(y!, (m ?? 1) - 1 - 11, 1));
  const earliestMonth = `${startDate.getUTCFullYear()}-${String(startDate.getUTCMonth() + 1).padStart(2, "0")}`;

  const { data, error } = await supabase
    .from("spend_transactions")
    .select(SPEND_COLUMNS)
    .eq("is_transfer", false)
    .eq("currency", "SGD")
    .gte("calendar_month", earliestMonth)
    .lte("calendar_month", throughCalendarMonth);

  if (error) throw error;

  const byMonth = new Map<string, number>();
  for (const row of (data ?? []) as SpendRow[]) {
    byMonth.set(row.calendar_month, (byMonth.get(row.calendar_month) ?? 0) + Number(row.amount));
  }

  return [...byMonth.entries()]
    .map(([calendar_month, total]) => ({ calendar_month, total }))
    .sort((a, b) => a.calendar_month.localeCompare(b.calendar_month));
}

export interface MethodSplit {
  method_id: string;
  total: number;
  count: number;
}

export async function getPaymentMethodSplit(
  supabase: SupabaseClient,
  calendarMonth: string
): Promise<MethodSplit[]> {
  const { data, error } = await supabase
    .from("spend_transactions")
    .select(SPEND_COLUMNS)
    .eq("calendar_month", calendarMonth)
    .eq("is_transfer", false)
    .eq("currency", "SGD");

  if (error) throw error;

  const byMethod = new Map<string, MethodSplit>();
  for (const row of (data ?? []) as SpendRow[]) {
    const existing = byMethod.get(row.method_id) ?? { method_id: row.method_id, total: 0, count: 0 };
    existing.total += Number(row.amount);
    existing.count += 1;
    byMethod.set(row.method_id, existing);
  }

  return [...byMethod.values()].sort((a, b) => b.total - a.total);
}

// ---- home view additions (Phase D1) ----
// The functions above already serve /trends and /breakdown-shaped needs.
// The home view additionally needs the confirmed/provisional split (§4:
// "never pre-summed into one figure the reader can't take apart") and,
// per-category, which merchants contributed — cross-referenced against
// the guessed-merchant id set (lib/data/merchants.ts) so a category bar
// can carry the dotted "guessed" mark the View-1 mark spec calls for.
// A second query, not a rewrite of getMonthlySpendByCategory above: that
// function is presumably still useful as the plain-total shape /breakdown
// wants later, and this one is deliberately additive.

const DETAILED_SPEND_COLUMNS = `${SPEND_COLUMNS}, merchant_id`;

type DetailedSpendRow = SpendRow & { merchant_id: number | null };

export interface CategorySpendDetail {
  category: Category | "uncategorised";
  total: number;
  confirmedTotal: number;
  provisionalTotal: number;
  count: number;
  merchantIds: number[];
}

export interface MonthlySpendSummary {
  byCategory: CategorySpendDetail[];
  total: number;
  confirmedTotal: number;
  provisionalTotal: number;
}

async function fetchDetailedSpendRows(
  supabase: SupabaseClient,
  calendarMonth?: string
): Promise<DetailedSpendRow[]> {
  let query = supabase
    .from("spend_transactions")
    .select(DETAILED_SPEND_COLUMNS)
    .eq("is_transfer", false)
    .eq("currency", "SGD"); // foreign-currency rows sit uncosted until reconciliation, §4/§14

  if (calendarMonth) query = query.eq("calendar_month", calendarMonth);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as DetailedSpendRow[];
}

function summarizeDetailedRows(rows: DetailedSpendRow[]): MonthlySpendSummary {
  const byCategory = new Map<string, CategorySpendDetail & { merchantIdSet: Set<number> }>();
  let confirmedTotal = 0;
  let provisionalTotal = 0;

  for (const row of rows) {
    const key = row.category ?? "uncategorised";
    const existing =
      byCategory.get(key) ??
      {
        category: key as Category | "uncategorised",
        total: 0,
        confirmedTotal: 0,
        provisionalTotal: 0,
        count: 0,
        merchantIds: [],
        merchantIdSet: new Set<number>(),
      };

    const amount = Number(row.amount);
    existing.total += amount;
    existing.count += 1;
    if (row.status === "provisional") {
      existing.provisionalTotal += amount;
      provisionalTotal += amount;
    } else {
      // confirmed, disputed, reversed all read as "settled" for this
      // split's purposes — only 'provisional' carries the dashed-italic
      // treatment (§4); the others are edge cases outside D1's scope.
      existing.confirmedTotal += amount;
      confirmedTotal += amount;
    }
    if (row.merchant_id !== null) existing.merchantIdSet.add(row.merchant_id);

    byCategory.set(key, existing);
  }

  return {
    total: confirmedTotal + provisionalTotal,
    confirmedTotal,
    provisionalTotal,
    byCategory: [...byCategory.values()]
      .map(({ merchantIdSet, ...rest }) => ({ ...rest, merchantIds: [...merchantIdSet] }))
      .sort((a, b) => b.total - a.total),
  };
}

export async function getMonthlySpendSummary(
  supabase: SupabaseClient,
  calendarMonth: string
): Promise<MonthlySpendSummary> {
  return summarizeDetailedRows(await fetchDetailedSpendRows(supabase, calendarMonth));
}

// The donut's data source (home view rebuild): "total spending grouped by
// category" reads most usefully as the whole ledger's shape, not just this
// month's slice — the KPI row already covers "this month" specifically, so
// the donut earns its keep by answering a different question ("where does
// the money go, overall"). Same aggregation as the monthly summary, just
// without the calendar_month filter — still honest-data-correct (transfers
// and FX-pending rows excluded identically).
export async function getAllTimeSpendSummary(supabase: SupabaseClient): Promise<MonthlySpendSummary> {
  return summarizeDetailedRows(await fetchDetailedSpendRows(supabase));
}

/** Sum of spend in `calendarMonth` from day 1 through `throughDay`
 * (inclusive) — the like-for-like half of a month-to-date comparison
 * (docs/DASHBOARD_PLAN.md-adjacent home rebuild: a partial current month
 * must never be compared against a prior FULL month, so this gives the
 * prior month's spend through the same day-of-month instead). `txn_date`
 * is a 'YYYY-MM-DD' string, so a lexical `.lte()` cutoff is exact. */
export async function getSpendThroughDay(
  supabase: SupabaseClient,
  calendarMonth: string,
  throughDay: number
): Promise<number> {
  const cutoff = `${calendarMonth}-${String(throughDay).padStart(2, "0")}`;

  const { data, error } = await supabase
    .from("spend_transactions")
    .select("amount")
    .eq("calendar_month", calendarMonth)
    .eq("is_transfer", false)
    .eq("currency", "SGD")
    .lte("txn_date", cutoff);

  if (error) throw error;

  return ((data ?? []) as Array<Pick<SpendRow, "amount">>).reduce((sum, r) => sum + Number(r.amount), 0);
}

export interface FxPendingTransaction {
  id: string;
  txn_date: string;
  merchant_raw: string;
  currency: string;
  amount: number;
  fx_amount: number | null;
}

/** Foreign-currency rows for the period — excluded from every total above
 * by the `.eq("currency", "SGD")` filter (§4/§14: never a guessed SGD
 * figure). Surfaced separately so they're visible, not silently dropped. */
export async function getFxPendingTransactions(
  supabase: SupabaseClient,
  calendarMonth: string
): Promise<FxPendingTransaction[]> {
  const { data, error } = await supabase
    .from("spend_transactions")
    .select("id, txn_date, merchant_raw, currency, amount, fx_amount")
    .eq("calendar_month", calendarMonth)
    .eq("is_transfer", false)
    .neq("currency", "SGD");

  if (error) throw error;

  return ((data ?? []) as Array<Pick<Transaction, "id" | "txn_date" | "merchant_raw" | "currency" | "amount" | "fx_amount">>)
    .map((row) => ({
      id: row.id,
      txn_date: row.txn_date,
      merchant_raw: row.merchant_raw,
      currency: row.currency,
      amount: Number(row.amount),
      fx_amount: row.fx_amount === null ? null : Number(row.fx_amount),
    }))
    .sort((a, b) => a.txn_date.localeCompare(b.txn_date));
}

export interface MerchantLeaderboardRow {
  merchant_id: number | null;
  merchant_raw_sample: string;
  total: number;
  count: number;
}

export async function getMerchantLeaderboard(
  supabase: SupabaseClient,
  calendarMonth: string,
  limit = 20
): Promise<MerchantLeaderboardRow[]> {
  const { data, error } = await supabase
    .from("spend_transactions")
    .select("merchant_id, merchant_raw, amount, calendar_month, is_transfer, currency")
    .eq("calendar_month", calendarMonth)
    .eq("is_transfer", false)
    .eq("currency", "SGD");

  if (error) throw error;

  const byMerchant = new Map<string, MerchantLeaderboardRow>();
  for (const row of (data ?? []) as Array<Pick<Transaction, "merchant_id" | "merchant_raw" | "amount">>) {
    const key = row.merchant_id !== null ? String(row.merchant_id) : `raw:${row.merchant_raw}`;
    const existing =
      byMerchant.get(key) ?? { merchant_id: row.merchant_id, merchant_raw_sample: row.merchant_raw, total: 0, count: 0 };
    existing.total += Number(row.amount);
    existing.count += 1;
    byMerchant.set(key, existing);
  }

  return [...byMerchant.values()].sort((a, b) => b.total - a.total).slice(0, limit);
}

// ---- budget-planning additions (Phase D2) ----
// The amendment's specific ask: a candidate cap needs the same category's
// real trailing actuals in the same view as the input, not a separate
// report (docs/DASHBOARD_PLAN.md §6 D2). Reuses getMonthlySpendByCategory
// per trailing month rather than a new aggregation query shape — same
// pattern app/(protected)/page.tsx's FirstRunHero already established for
// the first-run panel, extracted here so both call sites share it instead
// of drifting.

export interface TrailingCategoryMonth {
  calendar_month: string;
  total: number;
}

export type TrailingActualsByCategory = Record<Category, TrailingCategoryMonth[]>;

export async function getTrailingActualsByCategory(
  supabase: SupabaseClient,
  throughCalendarMonth: string,
  monthsCount: number
): Promise<TrailingActualsByCategory> {
  const months = trailingCalendarMonths(throughCalendarMonth, monthsCount);
  const perMonth = await Promise.all(months.map((m) => getMonthlySpendByCategory(supabase, m)));

  const byCategory = {} as TrailingActualsByCategory;
  for (const cat of CATEGORIES) {
    byCategory[cat] = months.map((month) => ({ calendar_month: month, total: 0 }));
  }

  perMonth.forEach((rows, i) => {
    for (const row of rows) {
      if (row.category === "uncategorised") continue;
      const series = byCategory[row.category];
      const point = series[i];
      if (point) point.total = row.total;
    }
  });

  return byCategory;
}

// ---- trend-view additions (Phase D3) ----
// §3 View 2: a small-multiples grid, one sparkline per category, sharing a
// y-axis scale — explicitly not a spaghetti chart of 11 overlapping lines.
// One broad query over the 12-month window (same shape as
// getTwelveMonthTrend above), grouped by category+month client-side rather
// than 12 separate per-month round trips.

export type CategoryTrend = Partial<Record<Category, MonthlyTotal[]>>;

export async function getTwelveMonthTrendByCategory(
  supabase: SupabaseClient,
  throughCalendarMonth: string
): Promise<{ months: string[]; byCategory: CategoryTrend }> {
  const months = trailingCalendarMonths(throughCalendarMonth, 12);
  const earliestMonth = months[0]!;

  const { data, error } = await supabase
    .from("spend_transactions")
    .select(SPEND_COLUMNS)
    .eq("is_transfer", false)
    .eq("currency", "SGD")
    .gte("calendar_month", earliestMonth)
    .lte("calendar_month", throughCalendarMonth);

  if (error) throw error;

  const byCategoryMonth = new Map<string, Map<string, number>>();
  for (const row of (data ?? []) as SpendRow[]) {
    if (row.category === null) continue; // uncategorised has no series slot in the small-multiples grid
    if (!byCategoryMonth.has(row.category)) byCategoryMonth.set(row.category, new Map());
    const monthMap = byCategoryMonth.get(row.category)!;
    monthMap.set(row.calendar_month, (monthMap.get(row.calendar_month) ?? 0) + Number(row.amount));
  }

  const byCategory: CategoryTrend = {};
  for (const [cat, monthMap] of byCategoryMonth) {
    byCategory[cat as Category] = months.map((m) => ({ calendar_month: m, total: monthMap.get(m) ?? 0 }));
  }

  return { months, byCategory };
}

/** Which of the trailing `monthsCount` months contain at least one
 * FX-pending (uncosted, non-SGD) transaction — the trend view's dashed
 * "shadow line" marker (§3 View 2: "this figure is a floor, not the true
 * number"). A membership set, not amounts — the real FX amounts stay in
 * their own currency in the FX tray (§4), never summed into SGD here. */
export async function getFxPendingMonths(
  supabase: SupabaseClient,
  throughCalendarMonth: string,
  monthsCount = 12
): Promise<Set<string>> {
  const months = trailingCalendarMonths(throughCalendarMonth, monthsCount);
  const earliestMonth = months[0]!;

  const { data, error } = await supabase
    .from("spend_transactions")
    .select("calendar_month")
    .eq("is_transfer", false)
    .neq("currency", "SGD")
    .gte("calendar_month", earliestMonth)
    .lte("calendar_month", throughCalendarMonth);

  if (error) throw error;

  return new Set(((data ?? []) as Array<{ calendar_month: string }>).map((r) => r.calendar_month));
}
