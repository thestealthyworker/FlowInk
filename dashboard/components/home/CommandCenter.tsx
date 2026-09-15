import { formatMoney } from "@/components/honest-data/MoneyFigure";
import { CcAreaTrend, type CcTrendPoint } from "@/components/home/command-center/CcAreaTrend";
import { CcComparisonBars, type CcComparisonRow } from "@/components/home/command-center/CcComparisonBars";
import { CcDonut, type CcDonutSegment } from "@/components/home/command-center/CcDonut";
import { CommandCenterKpiRow, type CommandCenterKpi } from "@/components/home/command-center/CommandCenterKpiRow";
import { DailyHeatmap } from "@/components/home/DailyHeatmap";
import { MonthSelector, type MonthOption } from "@/components/home/MonthSelector";
import type { DailySpend } from "@/lib/data/dailySpend";
import type { CategoryBarStatus } from "@/lib/derive/budgetSummary";

export interface CommandCenterRing {
  label: string;
  percent: number;
  detail: string;
}

export interface CommandCenterLeaderRow {
  name: string;
  amount: number;
  colorVar: string;
  meta: string;
}

export interface CommandCenterBudgetCard {
  category: string;
  spend: number;
  cap: number;
  status: CategoryBarStatus;
}

export interface CommandCenterCardTile {
  name: string;
  last4: string | null;
  toneWord: string;
  tone: "good" | "warning" | "critical" | "neutral" | "ghost";
  headline: string;
  // 0–1 progress toward the card's own cap or first gate (cardProgress,
  // lib/derive/cardStatus.ts); null when the card has nothing to measure
  // against, in which case the tile shows the tone dot alone.
  fraction: number | null;
  progressLabel: string | null;
}

export interface CommandCenterProps {
  monthLabel: string;
  monthOptions: MonthOption[];
  selectedMonth: string;
  isCurrentMonth: boolean;
  topCategoryAside: string;
  kpis: CommandCenterKpi[];
  donutSegments: CcDonutSegment[];
  budgetRing: CommandCenterRing | null;
  // Was two hardcoded named slots (uobRing/hsbcRing) — generalised (WP4)
  // to however many cards have something ring-worthy to show, computed
  // generically off the contract rather than two method_id-pinned props.
  cardRings: CommandCenterRing[];
  comparisonRows: CcComparisonRow[];
  comparisonCurrentLabel: string;
  comparisonPreviousLabel: string;
  trendPoints: CcTrendPoint[];
  heatmapDays: DailySpend[];
  miniLeaderboard: CommandCenterLeaderRow[];
  budgetAside: string;
  budgetCards: CommandCenterBudgetCard[];
  cardAside: string;
  cardTiles: CommandCenterCardTile[];
  hasBudgets: boolean;
}

const TALLY_SEGMENTS = 10;

// A literal structural port of the "Ledger & Ink" artifact's Command
// Center section — same section-label/ledger-row/cc-grid/budget-grid/card-strip shape,
// wired to real Supabase-backed data instead of the artifact's
// illustrative numbers.
export function CommandCenter(props: CommandCenterProps) {
  return (
    <section id="command-center">
      <div className="section-label section-label--with-control">
        <span>
          Command Center — {props.monthLabel}
          {props.isCurrentMonth ? ", month to date" : " (closed month)"}
        </span>
        <MonthSelector months={props.monthOptions} selected={props.selectedMonth} />
      </div>

      <div className="ledger-row">
        <p className="aside voice">{props.topCategoryAside}</p>
        <CommandCenterKpiRow kpis={props.kpis} />
      </div>

      <p className="aside voice" style={{ margin: "2rem 0 1rem", maxWidth: "52ch" }}>
        Nine live readings of the same month — rest a cursor or tab a stop, and each one says a little more.
      </p>

      <div className="cc-grid">
        <CcDonut segments={props.donutSegments} defaultLabel={props.monthLabel} />

        <div className="cc-rings">
          {props.budgetRing && (
            <RingCard label="Budget used" percent={props.budgetRing.percent} detail={props.budgetRing.detail} />
          )}
          {props.cardRings.map((ring) => (
            <RingCard key={ring.label} label={ring.label} percent={ring.percent} detail={ring.detail} />
          ))}
        </div>

        <CcComparisonBars
          rows={props.comparisonRows}
          currentLabel={props.comparisonCurrentLabel}
          previousLabel={props.comparisonPreviousLabel}
        />

        <CcAreaTrend points={props.trendPoints} currentLabel={props.comparisonCurrentLabel} />

        <DailyHeatmap days={props.heatmapDays} />

        <div className="cc-card cc-leader">
          <div className="cc-title">Top merchants — {props.monthLabel}</div>
          {props.miniLeaderboard.length === 0 ? (
            <p>No merchant spend {props.isCurrentMonth ? "yet this month" : `in ${props.monthLabel}`}.</p>
          ) : (
            props.miniLeaderboard.map((row) => (
              <div key={row.name} className="cc-leader-row" tabIndex={0}>
                <span className="cc-leader-name">
                  <span className="cc-legend-dot" style={{ background: `var(${row.colorVar})` }} />
                  {row.name}
                </span>
                <span className="cc-leader-track">
                  <span className="cc-leader-fill" style={{ width: `${Math.min(100, (row.amount / (props.miniLeaderboard[0]?.amount || 1)) * 100)}%`, background: `var(${row.colorVar})` }} />
                </span>
                <span className="cc-leader-amt money-figure">{formatMoney(row.amount)}</span>
                <span className="cc-leader-meta">{row.meta}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {props.hasBudgets && (
        <div className="ledger-row" style={{ marginTop: "2.5rem" }}>
          <p className="aside voice">{props.budgetAside}</p>
          <div className="li-budget-grid">
            {props.budgetCards.map((card) => (
              <BudgetTallyCard key={card.category} card={card} />
            ))}
          </div>
        </div>
      )}

      {props.isCurrentMonth ? (
        <div className="ledger-row">
          <p className="aside voice">{props.cardAside}</p>
          <div className="li-card-strip">
            {props.cardTiles.map((tile) => (
              <CardTile key={tile.name} tile={tile} />
            ))}
          </div>
          <a href="/cards" className="li-card-tile__more" style={{ gridColumn: "1 / -1" }}>
            View full card gauges →
          </a>
        </div>
      ) : (
        // Card status tracks each card's own live statement/billing period,
        // not a calendar month — showing it under a past month here would
        // silently conflate the two period models this system keeps apart.
        <div className="ledger-row">
          <p className="aside voice">
            Card gauges track live statement cycles, not calendar months, so they don&rsquo;t apply to a past month
            view. <a href="/cards">See current card status →</a>
          </p>
        </div>
      )}
    </section>
  );
}

function CardTile({ tile }: { tile: CommandCenterCardTile }) {
  return (
    <div className="li-card-tile">
      <div className="name">{tile.name}</div>
      {tile.last4 && <div className="num-badge">••{tile.last4}</div>}
      {tile.fraction !== null && (
        <span
          className="li-card-tile__track"
          role="img"
          aria-label={`${Math.round(tile.fraction * 100)}% of this period's ${tile.progressLabel ?? "ceiling"}`}
        >
          <span className="li-card-tile__fill" style={{ transform: `scaleX(${tile.fraction})` }} />
        </span>
      )}
      <div className="note">
        <span className="status-dot" style={{ background: tile.tone === "ghost" || tile.tone === "neutral" ? "var(--color-ink-muted)" : `var(--color-${tile.tone})` }} />
        {tile.headline}
      </div>
    </div>
  );
}

function RingCard({ label, percent, detail }: CommandCenterRing) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className="cc-card cc-ring-wrap" tabIndex={0} role="group" aria-label={`${label}: ${Math.round(clamped)} percent. ${detail}`}>
      <div className="cc-ring" style={{ background: `conic-gradient(var(--color-accent) 0% ${clamped}%, var(--color-surface-sunk) ${clamped}% 100%)` }}>
        <div className="cc-ring-center">{Math.round(clamped)}%</div>
      </div>
      <div className="cc-ring-label">{label}</div>
      <div className="li-reveal">{detail}</div>
    </div>
  );
}

function BudgetTallyCard({ card }: { card: CommandCenterBudgetCard }) {
  const pct = card.cap > 0 ? card.spend / card.cap : 0;
  const filled = Math.min(TALLY_SEGMENTS, Math.round(pct * TALLY_SEGMENTS));
  const over = card.status === "critical" ? Math.min(TALLY_SEGMENTS, Math.round((pct - 1) * TALLY_SEGMENTS)) : 0;
  const pillLabel = card.status === "critical" ? "Over" : card.status === "warning" ? "Near limit" : "On track";

  return (
    <div className="li-budget-card">
      <div className="top">
        <span className="cat">{card.category}</span>
        <span className={`pill ${card.status === "critical" ? "critical" : card.status === "warning" ? "warn" : "good"}`}>{pillLabel}</span>
      </div>
      <div className="li-tally">
        {Array.from({ length: TALLY_SEGMENTS }, (_, i) => (
          <span key={i} className={i < filled - over ? "filled" : i < filled ? "over" : ""} />
        ))}
      </div>
      <div className="figures">
        <span className="money-figure">
          {formatMoney(card.spend)} of {formatMoney(card.cap)}
        </span>
        <span>{card.status === "critical" ? `+${formatMoney(card.spend - card.cap)}` : `${formatMoney(Math.max(0, card.cap - card.spend))} left`}</span>
      </div>
    </div>
  );
}
