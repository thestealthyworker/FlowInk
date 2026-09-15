import type { SupabaseClient } from "@supabase/supabase-js";
import { addCalendarMonths, calendarMonthWithinRange, calendarMonthsBetween } from "../date";
import type { SpendSmoothing, SpendSmoothingInput, SpendSmoothingWithTransaction } from "../supabase/types";

// Spend smoothing (0022_spend_smoothing.sql): an overlay that spreads a
// lump-sum transaction across N months for reporting, without ever
// touching the transaction itself. See that migration's own comment for
// the full rationale. Aggregated in TypeScript after fetching, same
// reasoning as lib/data/spend.ts's own header comment — this table stays
// small (one row per tagged transaction), so a Postgres function buys
// nothing a plain fetch + reduce doesn't already do correctly, and it
// avoids adding another function that would need its own PUBLIC-execute
// hardening (0007, 0008).
//
// Callers fetch the schedule list once with listSpendSmoothing() and pass
// it to the pure/derived helpers below, rather than each helper re-reading
// the table.

const SMOOTHING_WITH_TXN_SELECT =
  "id, transaction_id, label, start_month, months, is_subscription, created_at, transaction:transactions(id, amount, currency, txn_date, merchant_raw, category, calendar_month)";

// transactions.id is a uuid (0001). A ?transaction= query value or form
// field that isn't one can never match a row, and passing it through
// would surface as a Postgres cast error (22P02) instead of "not found".
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isTransactionId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export async function listSpendSmoothing(supabase: SupabaseClient): Promise<SpendSmoothingWithTransaction[]> {
  const { data, error } = await supabase
    .from("spend_smoothing")
    .select(SMOOTHING_WITH_TXN_SELECT)
    .order("start_month", { ascending: false });

  if (error) throw error;
  return data as unknown as SpendSmoothingWithTransaction[];
}

/** Every transaction_id that already has a smoothing schedule — the
 * Ledger's per-row icon reads this to render filled (already tracked,
 * click to view/edit) vs outlined (not yet flagged, click to add). */
export function smoothedTransactionIds(schedules: SpendSmoothingWithTransaction[]): Set<string> {
  return new Set(schedules.map((s) => s.transaction_id));
}

/** The existing schedule for one transaction, if any — lets the "set
 * smoothing period" panel pre-fill from what's already saved instead of
 * always starting blank, so clicking an already-flagged transaction's
 * icon opens it in edit mode rather than silently offering to overwrite
 * it with defaults. */
export async function getSpendSmoothingForTransaction(supabase: SupabaseClient, transactionId: string): Promise<SpendSmoothing | null> {
  if (!isTransactionId(transactionId)) return null;

  const { data, error } = await supabase.from("spend_smoothing").select("*").eq("transaction_id", transactionId).maybeSingle();
  if (error) throw error;
  return data as SpendSmoothing | null;
}

/** The transaction fields a new-schedule form needs to show as read-only
 * context (amount, merchant, date) and to default label/start_month from
 * — not a generic "fetch any transaction" helper, scoped to exactly this
 * call site. */
export interface SmoothableTransaction {
  id: string;
  amount: string;
  currency: string;
  txn_date: string;
  merchant_raw: string;
  calendar_month: string;
}

export async function getSmoothableTransaction(supabase: SupabaseClient, id: string): Promise<SmoothableTransaction | null> {
  if (!isTransactionId(id)) return null;

  const { data, error } = await supabase
    .from("transactions")
    .select("id, amount, currency, txn_date, merchant_raw, calendar_month")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  return data as SmoothableTransaction | null;
}

/** Create or replace the schedule for a transaction — upsert on the
 * table's own unique(transaction_id), so re-flagging an already-tracked
 * transaction (the Ledger icon's "view/edit" path) updates it in place
 * instead of erroring on the unique constraint. */
export async function upsertSpendSmoothing(supabase: SupabaseClient, input: SpendSmoothingInput): Promise<SpendSmoothing> {
  const { data, error } = await supabase
    .from("spend_smoothing")
    .upsert(input, { onConflict: "transaction_id" })
    .select()
    .single();
  if (error) throw error;
  return data as SpendSmoothing;
}

export async function deleteSpendSmoothing(supabase: SupabaseClient, id: number): Promise<void> {
  const { error } = await supabase.from("spend_smoothing").delete().eq("id", id);
  if (error) throw error;
}

export interface SmoothedMonthlySummary {
  rawTotal: number; // this month's real spend, with any smoothed transaction's own lump excluded entirely
  smoothedPortion: number; // sum of active schedules' 1/N slices this month
  total: number; // rawTotal + smoothedPortion — the "smoothed" KPI figure
  activeCount: number; // how many schedules contributed a slice this month
}

/** The smoothed-view total for one calendar month: real (non-smoothed)
 * spend for the month, plus each active schedule's 1/N slice — never the
 * schedule's own lump transaction counted in its own real month AND
 * smoothed in (that would double-count it). A second, separately labelled
 * figure from getMonthlySpendSummary's raw total (lib/data/spend.ts) —
 * callers must show both, never merge them into one number. */
async function summarizeMonth(
  supabase: SupabaseClient,
  schedules: SpendSmoothingWithTransaction[],
  calendarMonth: string
): Promise<SmoothedMonthlySummary> {
  const smoothedTxnIds = smoothedTransactionIds(schedules);

  const { data, error } = await supabase
    .from("spend_transactions")
    .select("id, amount")
    .eq("calendar_month", calendarMonth)
    .eq("is_transfer", false)
    .eq("currency", "SGD"); // same uncosted-FX rule as every total in lib/data/spend.ts
  if (error) throw error;

  const rawTotal = ((data ?? []) as Array<{ id: string; amount: string }>)
    .filter((row) => !smoothedTxnIds.has(row.id))
    .reduce((sum, row) => sum + Number(row.amount), 0);

  let smoothedPortion = 0;
  let activeCount = 0;
  for (const s of schedules) {
    if (!s.transaction) continue; // source transaction gone — skip, never guess an amount
    if (!calendarMonthWithinRange(calendarMonth, s.start_month, s.months)) continue;
    smoothedPortion += Number(s.transaction.amount) / s.months;
    activeCount += 1;
  }

  return { rawTotal, smoothedPortion, total: rawTotal + smoothedPortion, activeCount };
}

/** Smoothed summaries for each of `calendarMonths`, keyed by month — the
 * smoothed KPI (one month) and the Trends overlay's second series (the
 * trend's own months) in one pass. One small per-month query each, in
 * parallel, so no single response can hit PostgREST's max-rows cap. */
export async function summarizeSmoothedMonths(
  supabase: SupabaseClient,
  schedules: SpendSmoothingWithTransaction[],
  calendarMonths: string[]
): Promise<Map<string, SmoothedMonthlySummary>> {
  const summaries = await Promise.all(calendarMonths.map((m) => summarizeMonth(supabase, schedules, m)));
  return new Map(calendarMonths.map((m, i) => [m, summaries[i]!]));
}

export type SmoothedScheduleStatus = "active" | "ending_soon" | "ended";

export interface SmoothedScheduleRow {
  id: number;
  transactionId: string;
  label: string;
  monthlyAmount: number;
  currency: string;
  startMonth: string;
  endMonth: string;
  monthsRemaining: number; // negative once ended
  status: SmoothedScheduleStatus;
  isSubscription: boolean;
}

// Within this many months of its end month (monthsRemaining 0 or 1), a
// schedule is called out as "ending soon" rather than plain "active" — a
// subscription about to lapse is the thing worth noticing before it
// silently renews or stops. Applies uniformly to subscriptions and one-off
// smoothed payments alike; isSubscription only changes whether a row is
// treated as something that renews, not whether it has an end date.
const ENDING_SOON_THRESHOLD_MONTHS = 2;

/** Every smoothing schedule (subscriptions and one-off lump sums alike),
 * with a uniform active/ending-soon/ended status — the Subscriptions
 * page's one list, filterable by status. Sorted soonest-ending first, so
 * what needs attention leads. */
export function buildSmoothedScheduleRows(schedules: SpendSmoothingWithTransaction[], referenceMonth: string): SmoothedScheduleRow[] {
  return schedules
    .flatMap((s) => (s.transaction ? [{ schedule: s, transaction: s.transaction }] : []))
    .map(({ schedule, transaction }) => {
      const endMonth = addCalendarMonths(schedule.start_month, schedule.months - 1);
      const monthsRemaining = calendarMonthsBetween(referenceMonth, endMonth);
      const status: SmoothedScheduleStatus =
        monthsRemaining < 0 ? "ended" : monthsRemaining < ENDING_SOON_THRESHOLD_MONTHS ? "ending_soon" : "active";
      return {
        id: schedule.id,
        transactionId: schedule.transaction_id,
        label: schedule.label,
        monthlyAmount: Number(transaction.amount) / schedule.months,
        currency: transaction.currency,
        startMonth: schedule.start_month,
        endMonth,
        monthsRemaining,
        status,
        isSubscription: schedule.is_subscription,
      };
    })
    .sort((a, b) => a.monthsRemaining - b.monthsRemaining);
}
