import Link from "next/link";
import { formatMoney } from "@/components/honest-data/MoneyFigure";
import type { MonthlyTotal } from "@/lib/data/spend";
import { categoryColorVar } from "@/lib/derive/seriesColor";
import type { Category } from "@/lib/supabase/types";

const W = 168;
const H = 56;
const PAD = 6;

// §3 View 2's per-category trend: explicitly NOT one chart with 8–11
// overlapping lines (the dataviz skill's own "spaghetti chart"
// anti-pattern) — a small-multiples grid instead, one sparkline per
// category, sharing a single y-axis scale across the whole grid so
// relative magnitude reads honestly. Sorted by slope (steepest-rising
// first) so "which categories are drifting up" is answered by the grid's
// own order, not by hunting for crossing lines. Horizontally scrollable
// on narrow screens (§5: each card sized so two are always partially
// visible as a scroll affordance), keyboard-navigable via native
// scroll + each card being a focusable link into /breakdown.
export interface CategorySpark {
  category: Category;
  months: MonthlyTotal[];
  slope: number;
  total: number;
}

export function buildCategorySparks(byCategory: Partial<Record<Category, MonthlyTotal[]>>): CategorySpark[] {
  const sparks: CategorySpark[] = [];
  for (const [category, months] of Object.entries(byCategory) as [Category, MonthlyTotal[]][]) {
    if (!months || months.every((m) => m.total === 0)) continue;
    const first = months[0]?.total ?? 0;
    const last = months[months.length - 1]?.total ?? 0;
    sparks.push({ category, months, slope: last - first, total: months.reduce((s, m) => s + m.total, 0) });
  }
  return sparks.sort((a, b) => b.slope - a.slope);
}

export function CategorySparkGrid({ sparks, guessedCategories }: { sparks: CategorySpark[]; guessedCategories: Set<Category> }) {
  if (sparks.length === 0) {
    return (
      <div className="empty-state">
        <p>No categorised spend in this window yet.</p>
      </div>
    );
  }

  const globalMax = Math.max(...sparks.flatMap((s) => s.months.map((m) => m.total)), 1);

  return (
    // tabIndex + overflow-x makes the strip keyboard-scrollable (arrow
    // keys) even before reaching any individual card's own focus stop —
    // §6 D3 acceptance: "keyboard-navigable and has visible focus states."
    <div className="spark-grid" role="list" tabIndex={0} aria-label="Category trends, scrollable">
      {sparks.map((spark) => {
        const isGuessed = guessedCategories.has(spark.category);
        return (
          <Link
            key={spark.category}
            href={isGuessed ? `/triage` : `/breakdown#cat-${spark.category}`}
            className="spark-card"
            role="listitem"
            data-drift={spark.slope > 0 ? "up" : spark.slope < 0 ? "down" : "flat"}
          >
            <header className="spark-card__header">
              <span className="spark-card__swatch" style={{ background: `var(${categoryColorVar(spark.category)})` }} aria-hidden="true" />
              <span className={`spark-card__name${isGuessed ? " guessed-label" : ""}`}>{spark.category}</span>
            </header>

            <SparkSvg months={spark.months} colorVar={categoryColorVar(spark.category)} globalMax={globalMax} />

            <p className="spark-card__figures">
              <span className="money-figure">{formatMoney(spark.total)}</span> total ·{" "}
              <span data-direction={spark.slope > 0 ? "up" : spark.slope < 0 ? "down" : "flat"}>
                {spark.slope > 0 ? "▲" : spark.slope < 0 ? "▼" : "—"} {formatMoney(Math.abs(spark.slope))}
              </span>{" "}
              since {spark.months[0]?.calendar_month.slice(5)}
            </p>
          </Link>
        );
      })}
    </div>
  );
}

function SparkSvg({ months, colorVar, globalMax }: { months: MonthlyTotal[]; colorVar: string; globalMax: number }) {
  const plotW = W - PAD * 2;
  const plotH = H - PAD * 2;
  const points = months.map((m, i) => ({
    x: PAD + (months.length === 1 ? plotW / 2 : (i / (months.length - 1)) * plotW),
    y: PAD + plotH - (m.total / globalMax) * plotH,
  }));
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="spark-card__svg" aria-hidden="true" focusable="false" preserveAspectRatio="none">
      <path d={path} fill="none" style={{ stroke: `var(${colorVar})` }} strokeWidth="1.75" />
      {points.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={i === points.length - 1 ? 2.5 : 1.4} style={{ fill: `var(${colorVar})` }} />
      ))}
    </svg>
  );
}
