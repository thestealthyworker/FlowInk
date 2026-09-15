import {
  CommandCenter,
  type CommandCenterBudgetCard,
  type CommandCenterCardTile,
  type CommandCenterLeaderRow,
  type CommandCenterRing,
} from "@/components/home/CommandCenter";
import type { CommandCenterKpi } from "@/components/home/command-center/CommandCenterKpiRow";
import { LedgerSection } from "@/components/home/LedgerSection";
import type { MonthOption } from "@/components/home/MonthSelector";
import { TrendsSection } from "@/components/home/TrendsSection";
import { formatMoney } from "@/components/honest-data/MoneyFigure";
import {
  GmailNotConfiguredNotice,
  HealthchecksNotConfiguredNotice,
  StatementIngestionCalmNotice,
} from "@/components/honest-data/IntegrationNotice";
import { getIntegrationStatus, isConfigured } from "@/lib/data/integration-status";
import { getCardDashboardStatus } from "@/lib/data/cards";
import { getDailySpend } from "@/lib/data/dailySpend";
import { getLedgerFacets, listTransactions, type LedgerSortField } from "@/lib/data/ledger";
import { listGuessedMerchantIds } from "@/lib/data/merchants";
import { listPaymentMethods } from "@/lib/data/methods";
import { listSpendSmoothing, smoothedTransactionIds, summarizeSmoothedMonths, type SmoothedMonthlySummary } from "@/lib/data/smoothing";
import {
  getAvailableCalendarMonths,
  getMerchantLeaderboard,
  getMonthlySpendByCategory,
  getMonthlySpendSummary,
  getSpendThroughDay,
  getTwelveMonthTrend,
} from "@/lib/data/spend";
import { listBudgets } from "@/lib/data/budgets";
import { fillDailySeries } from "@/lib/derive/dailySeries";
import { calendarMonthAbbr, calendarMonthLabel, currentCalendarMonth, daysElapsedInCalendarMonth, daysInCalendarMonth, daysRemainingInCalendarMonth, previousCalendarMonth as previousCalendarMonthOf } from "@/lib/date";
import { categoryBarStatus, deriveTotalCap, resolveCategoryBudgets, sortByProximityToCap, type CategoryBarRow } from "@/lib/derive/budgetSummary";
import { cardProgress, summarizeCardStatus } from "@/lib/derive/cardStatus";
import { buildMonthComparison, topCategories } from "@/lib/derive/kpis";
import { categoryColorVar } from "@/lib/derive/seriesColor";
import type { LedgerQueryParams } from "@/lib/ledgerQuery";
import { createClient } from "@/lib/supabase/server";
import type { Category, CardPeriodStatus, Merchant } from "@/lib/supabase/types";
import { isCategory } from "@/lib/supabase/types";

const HEATMAP_DAYS = 28;
const LEDGER_PAGE_SIZE = 50;
const TREND_LEADER_COUNT = 8;
const TREND_MONTHS_SHOWN = 6;
const MONTH_PARAM_PATTERN = /^\d{4}-\d{2}$/;

// The single Command Center page (redesign/visuals) — a literal port of
// the "Ledger & Ink" artifact:
// one page, three anchor-linked sections (Command Center / Trends /
// Ledger), real Supabase data throughout. The only intentional deviation
// from the artifact is the "Add" nav item, which links to real separate
// pages (budgets, manual entry, triage, subscriptions) rather than being
// part of this page — everything else here matches the artifact's
// structure.
export default async function HomePage({ searchParams }: { searchParams: Promise<LedgerQueryParams> }) {
  const params = await searchParams;
  const supabase = await createClient();

  // ---- month selector: which calendar month the Command Center reflects,
  // from ?month=YYYY-MM. Defaults to the current month, and falls back to
  // it for a malformed value or a month with no transactions — the query
  // string is never trusted enough to query a month that can't have data.
  const thisMonth = currentCalendarMonth();
  const availableMonths = await getAvailableCalendarMonths(supabase);
  const calendarMonth = resolveSelectedMonth(params.month, thisMonth, availableMonths);
  const isCurrentMonth = calendarMonth === thisMonth;
  const monthOptions: MonthOption[] = [...new Set([thisMonth, ...availableMonths])]
    .sort((a, b) => b.localeCompare(a))
    .map((m) => ({ value: m, label: calendarMonthLabel(m) }));

  const previousCalendarMonth = previousCalendarMonthOf(calendarMonth);
  const daysElapsed = daysElapsedInCalendarMonth(calendarMonth);
  const daysRemaining = daysRemainingInCalendarMonth(calendarMonth);
  const monthLabel = calendarMonthLabel(calendarMonth);

  // Trailing 28 real days for the current month (a "recent pace" view) —
  // but a closed past month has its own fixed date range, not "the last
  // 28 days before today" (which wouldn't overlap it at all once the month
  // is more than 28 days gone), so the heatmap anchors to that month's own
  // days instead.
  let heatmapFromStr: string;
  let heatmapToStr: string;
  if (isCurrentMonth) {
    const today = new Date();
    const heatmapFrom = new Date(today);
    heatmapFrom.setDate(today.getDate() - (HEATMAP_DAYS - 1));
    heatmapFromStr = heatmapFrom.toISOString().slice(0, 10);
    heatmapToStr = today.toISOString().slice(0, 10);
  } else {
    heatmapFromStr = `${calendarMonth}-01`;
    heatmapToStr = `${calendarMonth}-${String(daysInCalendarMonth(calendarMonth)).padStart(2, "0")}`;
  }

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
    integrationStatus,
    smoothingSchedules,
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
    getIntegrationStatus(supabase),
    listSpendSmoothing(supabase),
  ]);

  const gmailConfigured = isConfigured(integrationStatus.gmail);
  const healthchecksConfigured = isConfigured(integrationStatus.healthchecks);
  // Only worth mentioning once there's live ingestion to reconcile —
  // if Gmail itself is off, the Gmail notice already covers the bigger
  // gap and a second banner about reconciliation would be noise.
  const showStatementCalmNotice = gmailConfigured && !isConfigured(integrationStatus.statementIngestion);

  // ---- spend smoothing (0022): a second, separately labelled figure,
  // never blended into the raw totals. The per-month smoothed queries only
  // run once something has actually been smoothed — before that they could
  // only ever reproduce the raw numbers.
  const smoothedIds = smoothedTransactionIds(smoothingSchedules);
  const hasEverSmoothed = smoothingSchedules.length > 0;
  const trendMonthsShown = trend.slice(-TREND_MONTHS_SHOWN);
  const smoothedByMonth: Map<string, SmoothedMonthlySummary> = hasEverSmoothed
    ? await summarizeSmoothedMonths(supabase, smoothingSchedules, [...new Set([...trendMonthsShown.map((m) => m.calendar_month), calendarMonth])])
    : new Map();
  const smoothedSummary = smoothedByMonth.get(calendarMonth) ?? null;

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
  const periodPhrase = isCurrentMonth ? "this month" : `in ${monthLabel}`;

  const kpis: CommandCenterKpi[] = [
    {
      label: isCurrentMonth ? "Spent, MTD" : "Total spent",
      value: formatMoney(summary.total),
      delta:
        comparison.deltaPct === null
          ? "No prior-month data yet"
          : `${deltaGlyph} ${Math.abs(Math.round(comparison.deltaPct * 100))}% vs ${calendarMonthAbbr(previousCalendarMonth)}${isCurrentMonth ? " same day" : ""}`,
      deltaTone,
      detail: `Averaging ${formatMoney(daysElapsed > 0 ? summary.total / daysElapsed : 0)}/day ${periodPhrase}`,
      ariaLabel: `${isCurrentMonth ? "Spent month to date" : `Total spent in ${monthLabel}`}, ${formatMoney(summary.total)}`,
    },
    hasBudgets
      ? {
          label: isCurrentMonth ? "Budget remaining" : "Budget left unspent",
          value: formatMoney(Math.max(0, totalCap - summary.total)),
          delta:
            totalCap > 0 && summary.total >= totalCap
              ? "Over budget"
              : isCurrentMonth
                ? `On pace, ${daysRemaining} day${daysRemaining === 1 ? "" : "s"} left`
                : "Month closed",
          deltaTone: totalCap > 0 && summary.total >= totalCap ? "critical" : "good",
          detail: `${formatMoney(summary.total)} of ${formatMoney(totalCap)} used`,
          ariaLabel: `Budget remaining, ${formatMoney(Math.max(0, totalCap - summary.total))}`,
        }
      : {
          label: isCurrentMonth ? "Days remaining" : "Days in month",
          value: String(isCurrentMonth ? daysRemaining : daysInCalendarMonth(calendarMonth)),
          delta: `of ${daysInCalendarMonth(calendarMonth)} in ${monthLabel}`,
          detail: "No budgets set yet — set one from the Add menu",
          ariaLabel: isCurrentMonth ? `${daysRemaining} days remaining in ${monthLabel}` : `${daysInCalendarMonth(calendarMonth)} days in ${monthLabel}`,
        },
    {
      label: "Largest single spend",
      value: largestTxn ? formatMoney(largestTxn.amount, largestTxn.currency) : "—",
      delta: largestTxn ? `${largestTxn.merchant_display}, ${formatShortDate(largestTxn.txn_date)}` : "No transactions yet",
      detail:
        monthTransactions.rows.length > 1
          ? `#1 for ${monthLabel} — next was ${formatMoney(monthTransactions.rows[1]!.amount, monthTransactions.rows[1]!.currency)}`
          : isCurrentMonth
            ? "Only transaction so far this month"
            : `Only transaction in ${monthLabel}`,
      ariaLabel: `Largest single spend ${periodPhrase}, ${largestTxn ? formatMoney(largestTxn.amount) : "none yet"}`,
    },
    {
      label: "Transactions logged",
      value: String(monthTransactions.total),
      delta: `across ${methodCounts.size} account${methodCounts.size === 1 ? "" : "s"}`,
      detail: [...methodCounts.entries()].map(([name, count]) => `${name} ${count}`).join(" · ") || "No accounts active yet",
      ariaLabel: `${monthTransactions.total} transactions logged ${periodPhrase}`,
    },
    // Only shown once at least one lump sum is smoothed into this month —
    // otherwise it's a fifth card saying "$0, 0 payments" for everyone who
    // hasn't used the feature.
    ...(smoothedSummary && smoothedSummary.activeCount > 0
      ? [
          {
            label: "Smoothed spend",
            value: formatMoney(smoothedSummary.total),
            delta: `${formatMoney(smoothedSummary.rawTotal)} real + ${formatMoney(smoothedSummary.smoothedPortion)} smoothed`,
            detail: `${smoothedSummary.activeCount} lump-sum payment${smoothedSummary.activeCount === 1 ? "" : "s"} spread across months — see Subscriptions`,
            ariaLabel: `Smoothed spend ${periodPhrase}, ${formatMoney(smoothedSummary.total)}`,
          },
        ]
      : []),
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

  // Card status is always the LIVE period (card_dashboard_status() takes
  // no month, and a card's own statement period doesn't align with an
  // arbitrary calendar month anyway), so card rings are suppressed for any
  // month other than the current one — the Command Center never shows
  // today's card status under a past month's heading.
  const cardRings = isCurrentMonth
    ? cardStatus.map((c) => buildCardRing(c.display_name, c.status)).filter((r): r is CommandCenterRing => r !== null)
    : [];

  const previousByCategory = new Map(previousMonthByCategory.map((c) => [c.category, c.total]));
  const comparisonRows = summary.byCategory
    .filter((c) => c.total > 0)
    .slice(0, 5)
    .map((c) => ({ category: c.category, label: displayCategory(c.category), previousTotal: previousByCategory.get(c.category) ?? 0, currentTotal: c.total }));

  const trendPoints = trendMonthsShown.map((m) => ({
    label: isCurrentMonth && m.calendar_month === calendarMonth ? `${calendarMonthAbbr(m.calendar_month)} (MTD)` : calendarMonthAbbr(m.calendar_month),
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
    const progress = cardProgress(card.status);
    return {
      name: card.display_name,
      last4: last4ByMethod.get(card.method_id) ?? null,
      toneWord: s.toneWord,
      tone: s.tone,
      headline: s.headline,
      fraction: progress?.fraction ?? null,
      progressLabel: progress?.label ?? null,
    };
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
  const trendPointsFull = trendMonthsShown.map((m) => ({ label: calendarMonthAbbr(m.calendar_month), total: m.total }));
  const smoothedTrendPoints = trendMonthsShown.map((m) => ({
    label: calendarMonthAbbr(m.calendar_month),
    total: smoothedByMonth.get(m.calendar_month)?.total ?? m.total,
  }));
  const isCurrentMonthPartial = isCurrentMonth && trend.at(-1)?.calendar_month === calendarMonth;

  // ==================== Ledger ====================

  const ledgerTotalPages = Math.max(1, Math.ceil(ledgerTotal / LEDGER_PAGE_SIZE));

  return (
    <div className="home">
      {(!gmailConfigured || !healthchecksConfigured || showStatementCalmNotice) && (
        <div className="integration-notice-stack">
          {!gmailConfigured && <GmailNotConfiguredNotice context="home" />}
          {!healthchecksConfigured && <HealthchecksNotConfiguredNotice />}
          {showStatementCalmNotice && <StatementIngestionCalmNotice />}
        </div>
      )}

      <CommandCenter
        monthLabel={monthLabel}
        monthOptions={monthOptions}
        selectedMonth={calendarMonth}
        isCurrentMonth={isCurrentMonth}
        topCategoryAside={
          topCategoryRows[0]
            ? `${monthLabel} has leaned into ${displayCategory(topCategoryRows[0].category)} — ${formatMoney(topCategoryRows[0].total)} across ${summary.byCategory.find((c) => c.category === topCategoryRows[0]!.category)?.count ?? 0} transactions, your biggest slice ${periodPhrase}.`
            : `${monthLabel} ${isCurrentMonth ? "is just getting started — no categorised spend yet." : "has no categorised spend."}`
        }
        kpis={kpis}
        donutSegments={donutSegments}
        budgetRing={budgetRing}
        cardRings={cardRings}
        comparisonRows={comparisonRows}
        comparisonCurrentLabel={calendarMonthAbbr(calendarMonth)}
        comparisonPreviousLabel={calendarMonthAbbr(previousCalendarMonth)}
        trendPoints={trendPoints}
        heatmapDays={heatmapDays}
        miniLeaderboard={miniLeaderboard}
        budgetAside={
          budgetCards.some((c) => c.status === "critical")
            ? `${budgetCards.filter((c) => c.status !== "good").length} budgets are running hot ${periodPhrase} — ${budgetCards.find((c) => c.status === "critical")?.category} is already past its line.`
            : `Budgets, tracked against ${isCurrentMonth ? "this month's" : `${monthLabel}'s`} actual spend.`
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
        smoothedPoints={smoothedTrendPoints}
        hasEverSmoothed={hasEverSmoothed}
        showSmoothed={params.trend === "smoothed"}
        currentParams={params}
        leaderboard={trendsLeaderboardRows}
      />

      <LedgerSection
        rows={ledgerRows}
        total={ledgerTotal}
        facets={ledgerFacets}
        guessedIds={guessedIds}
        smoothedIds={smoothedIds}
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

function resolveSelectedMonth(requested: string | undefined, thisMonth: string, availableMonths: string[]): string {
  if (!requested || !MONTH_PARAM_PATTERN.test(requested)) return thisMonth;
  return requested === thisMonth || availableMonths.includes(requested) ? requested : thisMonth;
}

function displayCategory(category: Category | "uncategorised"): string {
  if (category === "uncategorised") return "Uncategorised";
  return category.charAt(0).toUpperCase() + category.slice(1);
}

function formatShortDate(txnDate: string): string {
  return new Date(`${txnDate}T00:00:00`).toLocaleDateString("en-SG", { day: "numeric", month: "short" });
}

/** One ring per card, generic — built from cardProgress()
 * (lib/derive/cardStatus.ts), which reads only fields the contract itself
 * names, never a method_id. The same reading drives the card tiles'
 * compact gauge, so a ring and its tile can never disagree. A txn_count
 * gate is labelled in transactions, not money. */
function buildCardRing(displayName: string, status: CardPeriodStatus): CommandCenterRing | null {
  const progress = cardProgress(status);
  if (!progress) return null;

  const format = (amount: number) => (progress.gateKind === "txn_count" ? `${amount} transactions` : formatMoney(amount, progress.currency));

  if (progress.kind === "cap") {
    return {
      label: `${displayName} ${progress.label}`,
      percent: progress.fraction * 100,
      detail: `${format(progress.numerator)} of ${format(progress.denominator)}`,
    };
  }

  return {
    label: `${displayName} gate`,
    percent: progress.fraction * 100,
    detail: progress.cleared
      ? `Cleared · ${format(progress.numerator)}`
      : `${format(progress.numerator)} of ${format(progress.denominator)} needed`,
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
