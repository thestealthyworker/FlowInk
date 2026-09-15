import { formatMoney } from "@/components/honest-data/MoneyFigure";
import { categoryColorVar } from "@/lib/derive/seriesColor";
import type { LedgerQueryParams } from "@/lib/ledgerQuery";
import type { Category } from "@/lib/supabase/types";

const VIEW_W = 560;
const VIEW_H = 120;
const TICK_COUNT = 8;

export interface TrendsSectionRow {
  merchantId: number | null;
  name: string;
  total: number;
  count: number;
  category: Category | "uncategorised";
}

export interface TrendsSectionProps {
  monthCount: number;
  isCurrentMonthPartial: boolean;
  points: Array<{ label: string; total: number }>;
  smoothedPoints: Array<{ label: string; total: number }>;
  hasEverSmoothed: boolean;
  showSmoothed: boolean;
  currentParams: LedgerQueryParams;
  leaderboard: TrendsSectionRow[];
}

// Same params-preserving shape as buildLedgerHref (lib/ledgerQuery.ts),
// but targeting #trends instead of #ledger — that helper hardcodes its own
// anchor, so a small local twin rather than a shared one for a
// one-property difference.
function buildTrendHref(current: LedgerQueryParams, trend: "actual" | "smoothed"): string {
  const merged = { ...current, trend: trend === "smoothed" ? "smoothed" : undefined };
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(merged)) {
    if (value) search.set(key, value);
  }
  const qs = search.toString();
  return qs ? `/?${qs}#trends` : "/#trends";
}

// The artifact's "Trends & Breakdown" section, rendered as an in-page
// anchor (#trends) on the single Command Center page rather than a
// separate route, per the operator's "same page as the artifact" ask.
// The actual/smoothed toggle (?trend=smoothed) only appears once
// something has been smoothed — before that the second line would just
// retrace the first.
export function TrendsSection({
  monthCount,
  isCurrentMonthPartial,
  points,
  smoothedPoints,
  hasEverSmoothed,
  showSmoothed,
  currentParams,
  leaderboard,
}: TrendsSectionProps) {
  const average = points.length > 0 ? points.reduce((sum, m) => sum + m.total, 0) / points.length : 0;
  const latest = points.at(-1);
  const latestSmoothed = smoothedPoints.at(-1);
  const overlayActive = hasEverSmoothed && showSmoothed;

  // Shared y-scale across both series when the overlay is on, so the
  // smoothed line's flattening is actually visible against the real one
  // rather than each being scaled to its own range.
  const scaleValues = overlayActive ? [...points, ...smoothedPoints].map((m) => m.total) : points.map((m) => m.total);
  const max = Math.max(...scaleValues, 1);
  const min = Math.min(...scaleValues, 0);
  const span = Math.max(1, max - min);
  const stepX = points.length > 1 ? VIEW_W / (points.length - 1) : VIEW_W;
  const toY = (total: number) => VIEW_H - 20 - ((total - min) / span) * (VIEW_H - 40);
  const coords = points.map((m, i) => ({
    label: m.label,
    x: i * stepX,
    y: toY(m.total),
    isLast: i === points.length - 1,
  }));
  const smoothedCoords = smoothedPoints.map((m, i) => ({ x: i * stepX, y: toY(m.total), isLast: i === smoothedPoints.length - 1 }));
  const linePoints = coords.map((c) => `${c.x},${c.y}`).join(" ");
  const smoothedLinePoints = smoothedCoords.map((c) => `${c.x},${c.y}`).join(" ");
  const maxLeaderTotal = Math.max(...leaderboard.map((r) => r.total), 1);

  return (
    <section id="trends">
      <div className="section-label">
        Trends &amp; Breakdown — last {monthCount} month{monthCount === 1 ? "" : "s"}
      </div>

      {hasEverSmoothed && (
        <div className="trend-toggle" role="group" aria-label="Actual vs. smoothed spend">
          <a href={buildTrendHref(currentParams, "actual")} data-active={!overlayActive || undefined} aria-current={!overlayActive || undefined}>
            Actual
          </a>
          <a href={buildTrendHref(currentParams, "smoothed")} data-active={overlayActive || undefined} aria-current={overlayActive || undefined}>
            + Smoothed
          </a>
        </div>
      )}

      <div className="li-trend-wrap">
        <svg
          className="li-sparkline"
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={
            overlayActive
              ? `Monthly spend trend over the last ${monthCount} months, actual and smoothed`
              : `Monthly spend trend over the last ${monthCount} months`
          }
        >
          <line x1={0} y1={VIEW_H - 20} x2={VIEW_W} y2={VIEW_H - 20} stroke="var(--color-hairline)" strokeWidth={1} />
          <polyline points={linePoints} fill="none" stroke="var(--color-accent)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          {coords.map((c) => (
            <circle key={c.label + c.x} cx={c.x} cy={c.y} r={c.isLast ? 5 : 3.5} fill="var(--color-accent)" />
          ))}
          {overlayActive && (
            <>
              <polyline
                points={smoothedLinePoints}
                fill="none"
                stroke="var(--color-accent)"
                strokeWidth={2}
                strokeDasharray="5 4"
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity={0.85}
              />
              {smoothedCoords.map((c) => (
                <circle key={`smoothed-${c.x}`} cx={c.x} cy={c.y} r={c.isLast ? 5 : 3.5} fill="var(--color-page)" stroke="var(--color-accent)" strokeWidth={2} />
              ))}
            </>
          )}
          <g fontFamily="var(--font-money)" fontSize="10" fill="var(--color-ink-muted)">
            {coords.map((c) => (
              <text key={`label-${c.label}-${c.x}`} x={c.x} y={VIEW_H - 6} textAnchor="middle">
                {c.label.toUpperCase()}
              </text>
            ))}
          </g>
        </svg>
        {overlayActive && (
          <div className="li-trend-legend">
            <span>
              <i className="swatch" />
              Actual
            </span>
            <span>
              <i className="swatch dashed" />
              Smoothed
            </span>
          </div>
        )}
        <div className="li-trend-note">
          <span className="num money-figure">{formatMoney(latest?.total ?? 0)}</span>
          {overlayActive && latestSmoothed ? (
            <>
              {" "}
              (<span className="num money-figure" style={{ display: "inline" }}>{formatMoney(latestSmoothed.total)}</span> smoothed){" "}
            </>
          ) : null}
          {isCurrentMonthPartial ? "This month, in progress — not yet final. " : ""}
          {monthCount}-month average is <span className="num money-figure">{formatMoney(average)}</span>.
        </div>
      </div>

      <div className="ledger-row" style={{ marginTop: "2.5rem" }}>
        <p className="aside voice">
          The cast of characters behind your spend — {leaderboard.length} merchant{leaderboard.length === 1 ? "" : "s"} doing most of the
          work.
        </p>
        {leaderboard.length === 0 ? (
          <div className="empty-state">
            <p>No merchant spend recorded yet.</p>
          </div>
        ) : (
          <div className="li-cast-list">
            {leaderboard.map((row, index) => {
              const filledTicks = Math.max(1, Math.round((row.total / maxLeaderTotal) * TICK_COUNT));
              return (
                <div key={row.merchantId ?? `raw:${row.name}`} className="li-cast-row">
                  <span className="li-cast-rank">{toRoman(index + 1)}</span>
                  <span>
                    <span className="li-cast-name">{row.name}</span>
                    <span className="li-cast-meta">
                      {row.count} transaction{row.count === 1 ? "" : "s"}
                    </span>
                  </span>
                  <span className="li-ticks">
                    {Array.from({ length: TICK_COUNT }, (_, i) => (
                      <i key={i} className={i < filledTicks ? "on" : undefined} style={i < filledTicks ? { background: `var(${categoryColorVar(row.category)})` } : undefined} />
                    ))}
                  </span>
                  <span className="li-cast-amount money-figure">{formatMoney(row.total)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

function toRoman(n: number): string {
  const numerals: Array<[number, string]> = [
    [10, "x"],
    [9, "ix"],
    [5, "v"],
    [4, "iv"],
    [1, "i"],
  ];
  let remaining = n;
  let result = "";
  for (const [value, symbol] of numerals) {
    while (remaining >= value) {
      result += symbol;
      remaining -= value;
    }
  }
  return result;
}
