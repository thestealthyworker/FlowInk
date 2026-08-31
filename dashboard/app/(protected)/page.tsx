import {
  CommandCenter,
  type CommandCenterBudgetCard,
  type CommandCenterCardTile,
  type CommandCenterLeaderRow,
  type CommandCenterRing,
} from "@/components/home/CommandCenter";
import type { CommandCenterKpi } from "@/components/home/command-center/CommandCenterKpiRow";
import { LedgerSection } from "@/components/home/LedgerSection";
import { TrendsSection } from "@/components/home/TrendsSection";
import { formatMoney } from "@/components/honest-data/MoneyFigure";
import { getCardDashboardStatus } from "@/lib/data/cards";
import { getDailySpend } from "@/lib/data/dailySpend";
import { getLedgerFacets, listTransactions, type LedgerSortField } from "@/lib/data/ledger";
import { listGuessedMerchantIds } from "@/lib/data/merchants";
import { listPaymentMethods } from "@/lib/data/methods";
import { getMerchantLeaderboard, getMonthlySpendByCategory, getMonthlySpendSummary, getSpendThroughDay, getTwelveMonthTrend } from "@/lib/data/spend";
import { listBudgets } from "@/lib/data/budgets";
import { fillDailySeries } from "@/lib/derive/dailySeries";
import { calendarMonthAbbr, calendarMonthLabel, currentCalendarMonth, daysElapsedInCalendarMonth, daysInCalendarMonth, daysRemainingInCalendarMonth, previousCalendarMonth as previousCalendarMonthOf } from "@/lib/date";
import { categoryBarStatus, deriveTotalCap, resolveCategoryBudgets, sortByProximityToCap, type CategoryBarRow } from "@/lib/derive/budgetSummary";
import { summarizeCardStatus } from "@/lib/derive/cardStatus";
import { buildMonthComparison, topCategories } from "@/lib/derive/kpis";
import { categoryColorVar } from "@/lib/derive/seriesColor";
import type { LedgerQueryParams } from "@/lib/ledgerQuery";
import { createClient } from "@/lib/supabase/server";
import type { Category, CardPeriodStatus, Merchant } from "@/lib/supabase/types";
import { isCategory } from "@/lib/supabase/types";

const HEATMAP_DAYS = 28;
const LEDGER_PAGE_SIZE = 50;
const TREND_LEADER_COUNT = 8;

// The single Command Center page (redesign/visuals) — a literal port of
// the "Ledger & Ink" artifact (https://claude.ai/code/artifact/c13a7ac1-9379-4391-8dd4-5266690d101d):
// one page, three anchor-linked sections (Command Center / Trends /
// Ledger), real Supabase data throughout. The only intentional deviation
// from the artifact is the "Add" nav item, which links to real separate
// pages (budgets, manual entry, triage) rather than being part of this
// page — everything else here matches the artifact's structure.
export default async function HomePage({ searchParams }: { searchParams: Promise<LedgerQueryParams> }) {
  const params = await searchParams;
  const supabase = await createClient();
  const calendarMonth = currentCalendarMonth();
  const previousCalendarMonth = previousCalendarMonthOf(calendarMonth);
  const daysElapsed = daysElapsedInCalendarMonth(calendarMonth);
  const daysRemaining = daysRemainingInCalendarMonth(calendarMonth);
  const monthLabel = calendarMonthLabel(calendarMonth);

  const today = new Date();
  const heatmapFrom = new Date(today);
  heatmapFrom.setDate(today.getDate() - (HEATMAP_DAYS - 1));
  const heatmapFromStr = heatmapFrom.toISOString().slice(0, 10);
  const heatmapToStr = today.toISOString().slice(0, 10);

  // ---- ledger section's own filter/sort/page state, from the URL ----
  const ledgerCategory = isCategory(params.category) ? params.category : undefined;
  const ledgerSortField: LedgerSortField = params.sort === "amount" ? "amount" : "txn_date";
  const ledgerSortDirection: "asc" | "desc" = params.dir === "asc" ? "asc" : "desc";
  const ledgerPageNum = Math.max(1, Number(params.page) || 1);
  const ledgerFilters = {
    dateFrom: params.from || undefined,
    dateTo: params.to || undefined,
    category: ledgerCategory,
    methodId: params.method || undefined,
    search: params.q || undefined,
  };

  const [
    summary,
    previousMonthByCategory,
    allBudgets,
    cardStatus,
    guessedIds,
    trend,
    paymentMethods,
    previousThroughSameDay,
    rawDailySpend,
    merchantLeaderboard,
    monthTransactions,
    trendLeaderboard,
    { rows: ledgerRows, total: ledgerTotal },
    ledgerFacets,
  ] = await Promise.all([
    getMonthlySpendSummary(supabase, calendarMonth),
    getMonthlySpendByCategory(supabase, previousCalendarMonth),
    listBudgets(supabase),
    getCardDashboardStatus(supabase),
    listGuessedMerchantIds(supabase),
    getTwelveMonthTrend(supabase, calendarMonth),
    listPaymentMethods(supabase),
    getSpendThroughDay(supabase, previousCalendarMonth, Math.min(daysElapsed, daysInCalendarMonth(previousCalendarMonth))),
    getDailySpend(supabase, heatmapFromStr, heatmapToStr),
    getMerchantLeaderboard(supabase, calendarMonth, 8),
    listTransactions(supabase, { calendarMonth }, { field: "amount", direction: "desc" }, { limit: Number.MAX_SAFE_INTEGER, offset: 0 }),
    getMerchantLeaderboard(supabase, calendarMonth, TREND_LEADER_COUNT),
    listTransactions(supabase, ledgerFilters, { field: ledgerSortField, direction: ledgerSortDirection }, {
      limit: LEDGER_PAGE_SIZE,
      offset: (ledgerPageNum - 1) * LEDGER_PAGE_SIZE,
    }),
    getLedgerFacets(supabase, { dateFrom: ledgerFilters.dateFrom, dateTo: ledgerFilters.dateTo }),
  ]);

  const resolvedBudgets = resolveCategoryBudgets(allBudgets, calendarMonth);
  const hasBudgets = resolvedBudgets.length > 0;
  const totalCap = deriveTotalCap(resolvedBudgets);
  const heatmapDays = fillDailySeries(rawDailySpend, heatmapFromStr, heatmapToStr);
  const topCategoryRows = topCategories(summary.byCategory, guessedIds);

  const comparison = buildMonthComparison({
    currentCalendarMonth: calendarMonth,
    currentThroughDay: daysElapsed,
    currentDaysInMonth: daysInCalendarMonth(calendarMonth),
    currentTotal: summary.total,
    previousCalendarMonth,
    previousThroughSameDay,
    previousFullMonth: trend.find((m) => m.calendar_month === previousCalendarMonth)?.total ?? null,
  });

  // ==================== Command Center ====================

  const largestTxn = monthTransactions.rows[0] ?? null;
  const methodCounts = new Map<string, number>();
  for (const row of monthTransactions.rows) {
    methodCounts.set(row.method_display_name, (methodCounts.get(row.method_display_name) ?? 0) + 1);
  }
  const deltaTone: "good" | "warn" | "critical" = comparison.direction === "up" ? "warn" : "good";
  const deltaGlyph = comparison.direction === "up" ? "▲" : comparison.direction === "down" ? "▼" : "—";

  const kpis: CommandCenterKpi[] = [
    {
      label: "Spent, MTD",
      value: formatMoney(summary.total),
      delta:
        comparison.deltaPct === null
          ? "No prior-month data yet"
          : `${deltaGlyph} ${Math.abs(Math.round(comparison.deltaPct * 100))}% vs ${calendarMonthAbbr(previousCalendarMonth)} same day`,
      deltaTone,
      detail: `Averaging ${formatMoney(daysElapsed > 0 ? summary.total / daysElapsed : 0)}/day this month`,
      ariaLabel: `Spent month to date, ${formatMoney(summary.total)}`,
    },
    hasBudgets
      ? {
          label: "Budget remaining",
          value: formatMoney(Math.max(0, totalCap - summary.total)),
          delta: totalCap > 0 && summary.total >= totalCap ? "Over budget" : `On pace, ${daysRemaining} day${daysRemaining === 1 ? "" : "s"} left`,
          deltaTone: totalCap > 0 && summary.total >= totalCap ? "critical" : "good",
          detail: `${formatMoney(summary.total)} of ${formatMoney(totalCap)} used`,
          ariaLabel: `Budget remaining, ${formatMoney(Math.max(0, totalCap - summary.total))}`,
        }
      : {
          label: "Days remaining",
          value: String(daysRemaining),
          delta: `of ${daysInCalendarMonth(calendarMonth)} in ${monthLabel}`,
          detail: "No budgets set yet — set one from the Add menu",
          ariaLabel: `${daysRemaining} days remaining in ${monthLabel}`,
        },
    {
      label: "Largest single spend",
      value: largestTxn ? formatMoney(largestTxn.amount, largestTxn.currency) : "—",
      delta: largestTxn ? `${largestTxn.merchant_display}, ${formatShortDate(largestTxn.txn_date)}` : "No transactions yet",
      detail:
        monthTransactions.rows.length > 1
          ? `#1 for ${monthLabel} — next was ${formatMoney(monthTransactions.rows[1]!.amount, monthTransactions.rows[1]!.currency)}`
          : "Only transaction so far this month",
      ariaLabel: `Largest single spend this month, ${largestTxn ? formatMoney(largestTxn.amount) : "none yet"}`,
    },
    {
      label: "Transactions logged",
      value: String(monthTransactions.total),
      delta: `across ${methodCounts.size} account${methodCounts.size === 1 ? "" : "s"}`,
      detail: [...methodCounts.entries()].map(([name, count]) => `${name} ${count}`).join(" · ") || "No accounts active yet",
      ariaLabel: `${monthTransactions.total} transactions logged this month`,
    },
  ];

  const donutSegments = summary.byCategory
    .filter((c) => c.total > 0)
    .map((c) => ({ category: c.category, label: displayCategory(c.category), total: c.total, share: summary.total > 0 ? c.total / summary.total : 0 }));

  const budgetRing: CommandCenterRing | null =
    totalCap > 0
      ? {
          label: "Budget used",
          percent: (summary.total / totalCap) * 100,
          detail: `${formatMoney(summary.total)} of ${formatMoney(totalCap)} · ${formatMoney(Math.max(0, totalCap - summary.total))} left`,
        }
      : null;

  const uobRing = buildUobRing(cardStatus.find((c) => c.method_id === "uob_one")?.status);
  const hsbcRing = buildHsbcRing(cardStatus.find((c) => c.method_id === "hsbc_revo")?.status);

  const previousByCategory = new Map(previousMonthByCategory.map((c) => [c.category, c.total]));
  const comparisonRows = summary.byCategory
    .filter((c) => c.total > 0)
    .slice(0, 5)
    .map((c) => ({ category: c.category, label: displayCategory(c.category), previousTotal: previousByCategory.get(c.category) ?? 0, currentTotal: c.total }));

  const trendPoints = trend.slice(-6).map((m) => ({
    label: m.calendar_month === calendarMonth ? `${calendarMonthAbbr(m.calendar_month)} (MTD)` : calendarMonthAbbr(m.calendar_month),
    total: m.total,
  }));

  const categoryByMerchant = new Map<string, Category | "uncategorised">();
  for (const row of monthTransactions.rows) {
    if (!categoryByMerchant.has(row.merchant_display)) categoryByMerchant.set(row.merchant_display, row.category);
  }
  const miniLeaderboard: CommandCenterLeaderRow[] = merchantLeaderboard.slice(0, 3).map((row) => {
    const category = categoryByMerchant.get(row.merchant_raw_sample) ?? "uncategorised";
    return {
      name: row.merchant_raw_sample,
      amount: row.total,
      colorVar: categoryColorVar(category),
      meta: `${row.count} transaction${row.count === 1 ? "" : "s"} · ${displayCategory(category)}`,
    };
  });

  const budgetCards: CommandCenterBudgetCard[] = sortByProximityToCap(buildCategoryBarRows(resolvedBudgets, summary.byCategory, guessedIds))
    .slice(0, 4)
    .map((r) => ({ category: displayCategory(r.category), spend: r.spend, cap: r.cap, status: r.status }));

  const last4ByMethod = new Map(paymentMethods.map((m) => [m.id, m.last4]));
  const cardTiles: CommandCenterCardTile[] = cardStatus.map((card) => {
    const s = summarizeCardStatus(card.status);
    return { name: card.display_name, last4: last4ByMethod.get(card.method_id) ?? null, toneWord: s.toneWord, tone: s.tone, headline: s.headline };
  });

  // ==================== Trends & Breakdown ====================

  const trendMerchantIds = trendLeaderboard.map((r) => r.merchant_id).filter((id): id is number => id !== null);
  const categoryByMerchantId = new Map<number, Category>();
  if (trendMerchantIds.length > 0) {
    const { data: merchants } = await supabase.from("merchants").select("id, category").in("id", trendMerchantIds);
    for (const m of (merchants ?? []) as Array<Pick<Merchant, "id" | "category">>) {
      categoryByMerchantId.set(m.id, m.category);
    }
  }
  const trendsLeaderboardRows = trendLeaderboard.map((row) => ({
    merchantId: row.merchant_id,
    name: row.merchant_raw_sample,
    total: row.total,
    count: row.count,
    category: row.merchant_id !== null ? categoryByMerchantId.get(row.merchant_id) ?? ("uncategorised" as const) : ("uncategorised" as const),
  }));
  const trendPointsFull = trend.slice(-6).map((m) => ({ label: calendarMonthAbbr(m.calendar_month), total: m.total }));
  const isCurrentMonthPartial = trend.at(-1)?.calendar_month === calendarMonth;

  // ==================== Ledger ====================

  const ledgerTotalPages = Math.max(1, Math.ceil(ledgerTotal / LEDGER_PAGE_SIZE));

  return (
    <div className="home">
      <CommandCenter
        monthLabel={monthLabel}
        topCategoryAside={
          topCategoryRows[0]
            ? `${monthLabel} has leaned into ${displayCategory(topCategoryRows[0].category)} — ${formatMoney(topCategoryRows[0].total)} across ${summary.byCategory.find((c) => c.category === topCategoryRows[0]!.category)?.count ?? 0} transactions, your biggest slice this month.`
            : `${monthLabel} is just getting started — no categorised spend yet.`
        }
        kpis={kpis}
        donutSegments={donutSegments}
        budgetRing={budgetRing}
        uobRing={uobRing}
        hsbcRing={hsbcRing}
        comparisonRows={comparisonRows}
        comparisonCurrentLabel={calendarMonthAbbr(calendarMonth)}
        comparisonPreviousLabel={calendarMonthAbbr(previousCalendarMonth)}
        trendPoints={trendPoints}
        heatmapDays={heatmapDays}
        miniLeaderboard={miniLeaderboard}
        budgetAside={
          budgetCards.some((c) => c.status === "critical")
            ? `${budgetCards.filter((c) => c.status !== "good").length} budgets are running hot this month — ${budgetCards.find((c) => c.status === "critical")?.category} is already past its line.`
            : "Budgets, tracked against this month's actual spend."
        }
        budgetCards={budgetCards}
        cardAside={`${cardStatus.length} account${cardStatus.length === 1 ? "" : "s"}, one story — here's where each stands.`}
        cardTiles={cardTiles}
        hasBudgets={hasBudgets}
      />

      <TrendsSection
        monthCount={trendPointsFull.length}
        isCurrentMonthPartial={isCurrentMonthPartial}
        points={trendPointsFull}
        leaderboard={trendsLeaderboardRows}
      />

      <LedgerSection
        rows={ledgerRows}
        total={ledgerTotal}
        facets={ledgerFacets}
        guessedIds={guessedIds}
        currentParams={params}
        filterValues={{
          q: params.q ?? "",
          category: params.category ?? "",
          method: params.method ?? "",
          from: params.from ?? "",
          to: params.to ?? "",
        }}
        pageNum={ledgerPageNum}
        totalPages={ledgerTotalPages}
        pageSize={LEDGER_PAGE_SIZE}
      />
    </div>
  );
}

function displayCategory(category: Category | "uncategorised"): string {
  if (category === "uncategorised") return "Uncategorised";
  return category.charAt(0).toUpperCase() + category.slice(1);
}

function formatShortDate(txnDate: string): string {
  return new Date(`${txnDate}T00:00:00`).toLocaleDateString("en-SG", { day: "numeric", month: "short" });
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/** HSBC's bonus_spend/cap_amount are the exact same fields
 * summarizeCardStatus() already reads to build its headline text — this
 * ring visualizes the identical, already-displayed figures, not new math. */
function buildHsbcRing(status: CardPeriodStatus | undefined): CommandCenterRing | null {
  if (!status) return null;
  const spend = numOrNull(status.bonus_spend);
  const cap = numOrNull(status.cap_amount);
  if (spend === null || cap === null || cap <= 0) return null;
  return { label: "HSBC online cap", percent: (spend / cap) * 100, detail: `${formatMoney(spend)} of ${formatMoney(cap)}` };
}

/** UOB has no smooth percent in the raw status (gate_cleared is boolean) —
 * spend / (spend + spend_needed_for_gate) is the same two numbers
 * summarizeCardStatus() already displays as text, just visualized. */
function buildUobRing(status: CardPeriodStatus | undefined): CommandCenterRing | null {
  if (!status) return null;
  if (status.gate_cleared === true) {
    const spend = numOrNull(status.spend);
    return { label: "UOB gate", percent: 100, detail: spend !== null ? `Cleared · ${formatMoney(spend)} this period` : "Gate cleared" };
  }
  const spend = numOrNull(status.spend) ?? 0;
  const needed = numOrNull(status.spend_needed_for_gate);
  if (needed === null || spend + needed <= 0) return null;
  return {
    label: "UOB gate progress",
    percent: (spend / (spend + needed)) * 100,
    detail: `${formatMoney(spend)} so far · ${formatMoney(needed)} to clear the gate`,
  };
}

function buildCategoryBarRows(
  resolved: ReturnType<typeof resolveCategoryBudgets>,
  byCategory: Awaited<ReturnType<typeof getMonthlySpendSummary>>["byCategory"],
  guessedIds: Set<number>
): CategoryBarRow[] {
  const spendByCategory = new Map(byCategory.map((c) => [c.category, c]));

  const rows: CategoryBarRow[] = resolved.map((r) => {
    const spend = spendByCategory.get(r.category);
    const hasGuessedMerchant = spend ? spend.merchantIds.some((id) => guessedIds.has(id)) : false;

    return {
      category: r.category,
      spend: spend?.total ?? 0,
      confirmedSpend: spend?.confirmedTotal ?? 0,
      provisionalSpend: spend?.provisionalTotal ?? 0,
      cap: r.monthlyCap,
      alertAt: r.alertAt,
      status: categoryBarStatus(spend?.total ?? 0, r.monthlyCap, r.alertAt),
      hasGuessedMerchant,
    };
  });

  return sortByProximityToCap(rows);
}
