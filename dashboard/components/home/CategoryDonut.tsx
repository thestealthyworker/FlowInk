"use client";

import { useId, useState, type KeyboardEvent } from "react";
import { AmountWithProvisionalSplit } from "@/components/honest-data/ProvisionalAmount";
import { GuessedCategoryLabel } from "@/components/honest-data/GuessedCategoryLabel";
import { formatMoney } from "@/components/honest-data/MoneyFigure";
import type { CompositionRow } from "@/lib/derive/spendComposition";
import type { DonutSegment } from "@/lib/derive/donut";

// The one client-side interactive chart on the home view (operator: "a
// donut chart with total spending which groups by categories, when
// clicked in it says the % and Amount"). Hand-rolled SVG arc math — no
// charting library — to keep this the dashboard's only meaningful client
// JS addition, per the app-page bundle budget.
//
// The dataviz skill is explicit that a donut only earns its place "at a
// glance, <= 6 segments" (references/anti-patterns.md) — buildDonutSegments
// (lib/derive/donut.ts) already folds the long tail before this component
// ever sees it. It's equally explicit that a tooltip/click reveal must
// never be the ONLY way to read a value: every segment's amount and share
// is already printed in the legend below the chart (server-rendered, no
// JS required), and the full unfolded breakdown is one <details> away in
// the table view. Clicking a wedge is a pure enhancement — a bigger,
// centred read of one segment — never the only path to the number.

const SIZE = 220;
const CENTER = SIZE / 2;
const R_OUTER = 100;
const R_INNER = 62;
const GAP_DEG = 1.75;

interface Wedge {
  segment: DonutSegment;
  startAngle: number;
  endAngle: number;
}

function buildWedges(segments: DonutSegment[]): Wedge[] {
  let angle = 0;
  return segments.map((segment) => {
    const sweep = segment.share * 360;
    const wedge: Wedge = { segment, startAngle: angle, endAngle: angle + sweep };
    angle += sweep;
    return wedge;
  });
}

/** Node's and the browser's V8 builds can round `Math.cos`/`Math.sin`'s
 * last bit differently, which turns an invisible sub-pixel difference into
 * a server/client hydration mismatch on the path string. Rounding to 3
 * decimal places (thousandths of a viewBox unit — far below anything
 * visible) makes the two renders byte-identical. */
function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function polar(radius: number, angleDeg: number): { x: number; y: number } {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: round(CENTER + radius * Math.cos(rad)), y: round(CENTER + radius * Math.sin(rad)) };
}

/** A single donut wedge as an SVG path, with a real angular gap (negative
 * space, per the mark spec — never a stroke drawn to fake separation)
 * between it and its neighbours. Segments too thin to carry a gap render
 * full-width rather than vanishing. */
function wedgePath(startDeg: number, endDeg: number): string {
  const span = endDeg - startDeg;
  const gap = span > GAP_DEG * 2.5 ? GAP_DEG / 2 : 0;
  const start = startDeg + gap;
  const end = Math.min(startDeg + Math.min(span, 359.9), endDeg - gap);
  const largeArc = end - start > 180 ? 1 : 0;

  const outerStart = polar(R_OUTER, end);
  const outerEnd = polar(R_OUTER, start);
  const innerStart = polar(R_INNER, start);
  const innerEnd = polar(R_INNER, end);

  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${R_OUTER} ${R_OUTER} 0 ${largeArc} 0 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerStart.x} ${innerStart.y}`,
    `A ${R_INNER} ${R_INNER} 0 ${largeArc} 1 ${innerEnd.x} ${innerEnd.y}`,
    "Z",
  ].join(" ");
}

function segmentAriaLabel(segment: DonutSegment): string {
  return `${segment.label}, ${formatMoney(segment.total)}, ${Math.round(segment.share * 100)} percent`;
}

export function CategoryDonut({
  segments,
  rawRows,
  grandTotal,
  periodLabel,
}: {
  segments: DonutSegment[];
  rawRows: CompositionRow[];
  grandTotal: number;
  periodLabel: string;
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const headingId = useId();

  if (segments.length === 0) {
    return (
      <section aria-labelledby={headingId} className="donut-section">
        <h2 id={headingId}>Where the money&rsquo;s gone</h2>
        <p>No categorised spend recorded yet.</p>
      </section>
    );
  }

  const wedges = buildWedges(segments);
  // A hover/focus preview is a pure enhancement layered on the existing
  // click-to-pin state: a click always wins (selectedKey), a hover/focus
  // only previews when nothing is pinned. Leaving the click on either the
  // wedge or the legend clears the preview back to the pinned/default read.
  const previewKey = selectedKey ?? hoveredKey;
  const selected = segments.find((s) => s.key === previewKey) ?? null;

  function toggle(key: string) {
    setSelectedKey((current) => (current === key ? null : key));
  }

  function handleWedgeKeyDown(event: KeyboardEvent<SVGPathElement>, key: string) {
    if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      toggle(key);
    } else if (event.key === "Escape") {
      setSelectedKey(null);
    }
  }

  const summary = `Total spending by category, ${periodLabel}: ${segments
    .map((s) => `${s.label} ${formatMoney(s.total)} (${Math.round(s.share * 100)}%)`)
    .join(", ")}.`;

  return (
    <section aria-labelledby={headingId} className="donut-section">
      <h2 id={headingId}>Where the money&rsquo;s gone</h2>
      <p className="donut-section__period">{periodLabel}</p>
      <p className="visually-hidden">{summary}</p>

      <div className="donut-layout">
        <div className="donut-figure">
          <svg
            viewBox={`0 0 ${SIZE} ${SIZE}`}
            className="donut"
            aria-hidden="true"
            focusable="false"
          >
            {wedges.map(({ segment, startAngle, endAngle }) => (
              <path
                key={segment.key}
                d={wedgePath(startAngle, endAngle)}
                className="donut__wedge"
                style={{ fill: `var(${segment.colorVar})` }}
                data-fold={segment.isFold || undefined}
                data-selected={segment.key === previewKey || undefined}
                tabIndex={0}
                role="button"
                aria-pressed={segment.key === selectedKey}
                aria-label={segmentAriaLabel(segment)}
                onClick={() => toggle(segment.key)}
                onKeyDown={(e) => handleWedgeKeyDown(e, segment.key)}
                onMouseEnter={() => setHoveredKey(segment.key)}
                onMouseLeave={() => setHoveredKey(null)}
                onFocus={() => setHoveredKey(segment.key)}
                onBlur={() => setHoveredKey(null)}
              />
            ))}
          </svg>

          <div className="donut__center" aria-hidden="true">
            {selected ? (
              <>
                <span className="donut__center-label">{selected.label}</span>
                <span className="donut__center-amount">{formatMoney(selected.total)}</span>
                <span className="donut__center-share">{Math.round(selected.share * 100)}%</span>
              </>
            ) : (
              <>
                <span className="donut__center-label">Total</span>
                <span className="donut__center-amount">{formatMoney(grandTotal)}</span>
                <span className="donut__center-share">{segments.length} groups</span>
              </>
            )}
          </div>
        </div>

        <ul className="donut-legend">
          {segments.map((segment, index) => (
            <li key={segment.key}>
              <button
                type="button"
                className="donut-legend__row"
                data-dominant={index === 0 ? "true" : undefined}
                data-preview={segment.key === previewKey || undefined}
                aria-pressed={segment.key === selectedKey}
                onClick={() => toggle(segment.key)}
                onMouseEnter={() => setHoveredKey(segment.key)}
                onMouseLeave={() => setHoveredKey(null)}
                onFocus={() => setHoveredKey(segment.key)}
                onBlur={() => setHoveredKey(null)}
              >
                <span
                  className="donut-legend__swatch"
                  data-fold={segment.isFold || undefined}
                  style={{ background: `var(${segment.colorVar})` }}
                  aria-hidden="true"
                />
                <span className="donut-legend__name">
                  {segment.isFold ? (
                    "Everything else"
                  ) : (
                    <GuessedCategoryLabel
                      category={segment.key as CompositionRow["category"]}
                      isGuessed={segment.hasGuessedMerchant}
                    />
                  )}
                </span>
                <span className="donut-legend__figures">
                  <AmountWithProvisionalSplit
                    confirmedTotal={segment.confirmedTotal}
                    provisionalTotal={segment.provisionalTotal}
                  />
                  <span className="donut-legend__share">{Math.round(segment.share * 100)}%</span>
                </span>
              </button>
              {segment.isFold && segment.folded && (
                <p className="donut-legend__fold-note">
                  {segment.folded.map((r) => r.category).join(", ")}
                </p>
              )}
            </li>
          ))}
        </ul>
      </div>

      <details className="donut-table">
        <summary>View as table</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">Category</th>
              <th scope="col">Amount</th>
              <th scope="col">Share</th>
            </tr>
          </thead>
          <tbody>
            {[...rawRows]
              .sort((a, b) => b.total - a.total)
              .map((row) => (
                <tr key={row.category}>
                  <th scope="row">
                    <GuessedCategoryLabel category={row.category} isGuessed={row.hasGuessedMerchant} />
                  </th>
                  <td>
                    <AmountWithProvisionalSplit
                      confirmedTotal={row.confirmedTotal}
                      provisionalTotal={row.provisionalTotal}
                    />
                  </td>
                  <td>{Math.round(row.share * 100)}%</td>
                </tr>
              ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}
