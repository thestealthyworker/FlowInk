import { formatMoney } from "@/components/honest-data/MoneyFigure";
import { categoryColorVar } from "@/lib/derive/seriesColor";
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
  leaderboard: TrendsSectionRow[];
}

// The artifact's "Trends & Breakdown" section, rendered as an in-page
// anchor (#trends) on the single Command Center page rather than a
// separate route, per the operator's "same page as the artifact" ask.
export function TrendsSection({ monthCount, isCurrentMonthPartial, points, leaderboard }: TrendsSectionProps) {
  const average = points.length > 0 ? points.reduce((sum, m) => sum + m.total, 0) / points.length : 0;
  const latest = points.at(-1);

  const max = Math.max(...points.map((m) => m.total), 1);
  const min = Math.min(...points.map((m) => m.total), 0);
  const span = Math.max(1, max - min);
  const stepX = points.length > 1 ? VIEW_W / (points.length - 1) : VIEW_W;
  const coords = points.map((m, i) => ({
    label: m.label,
    x: i * stepX,
    y: VIEW_H - 20 - ((m.total - min) / span) * (VIEW_H - 40),
    isLast: i === points.length - 1,
  }));
  const linePoints = coords.map((c) => `${c.x},${c.y}`).join(" ");
  const maxLeaderTotal = Math.max(...leaderboard.map((r) => r.total), 1);

  return (
    <section id="trends">
      <div className="section-label">
        Trends &amp; Breakdown — last {monthCount} month{monthCount === 1 ? "" : "s"}
      </div>

      <div className="li-trend-wrap">
        <svg
          className="li-sparkline"
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Monthly spend trend over the last ${monthCount} months`}
        >
          <line x1={0} y1={VIEW_H - 20} x2={VIEW_W} y2={VIEW_H - 20} stroke="var(--color-hairline)" strokeWidth={1} />
          <polyline points={linePoints} fill="none" stroke="var(--color-accent)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          {coords.map((c) => (
            <circle key={c.label + c.x} cx={c.x} cy={c.y} r={c.isLast ? 5 : 3.5} fill="var(--color-accent)" />
          ))}
          <g fontFamily="var(--font-money)" fontSize="10" fill="var(--color-ink-muted)">
            {coords.map((c) => (
              <text key={`label-${c.label}-${c.x}`} x={c.x} y={VIEW_H - 6} textAnchor="middle">
                {c.label.toUpperCase()}
              </text>
            ))}
          </g>
        </svg>
        <div className="li-trend-note">
          <span className="num money-figure">{formatMoney(latest?.total ?? 0)}</span>
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
