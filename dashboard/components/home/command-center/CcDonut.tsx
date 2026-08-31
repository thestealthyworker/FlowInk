"use client";

import { useState } from "react";
import { formatMoney } from "@/components/honest-data/MoneyFigure";
import { categoryColorVar } from "@/lib/derive/seriesColor";
import type { Category } from "@/lib/supabase/types";

export interface CcDonutSegment {
  category: Category | "uncategorised";
  label: string;
  total: number;
  share: number; // 0-1
}

const R = 52;
const CIRCUMFERENCE = 2 * Math.PI * R;

// Ported 1:1 from the "Ledger & Ink" artifact's cc-donut widget — a
// stroke-dasharray ring (not the home page's old arc-path donut), with
// hover/focus on a segment or its legend row cross-highlighting the other
// and swapping the center label — real category data, this month.
export function CcDonut({ segments, defaultLabel }: { segments: CcDonutSegment[]; defaultLabel: string }) {
  const [active, setActive] = useState<string | null>(null);

  if (segments.length === 0) {
    return (
      <div className="cc-card cc-donut">
        <div className="cc-title">Where it went — {defaultLabel}</div>
        <p>No categorised spend yet this month.</p>
      </div>
    );
  }

  const activeSegment = segments.find((s) => s.category === active) ?? segments[0]!;
  let cumulative = 0;
  const arcs = segments.map((s) => {
    const dash = s.share * CIRCUMFERENCE;
    const offset = -cumulative * CIRCUMFERENCE;
    cumulative += s.share;
    return { ...s, dash, offset };
  });

  return (
    <div className="cc-card cc-donut">
      <div className="cc-title">Where it went — {defaultLabel}</div>
      <div className="cc-donut-wrap">
        <div className="cc-donut-figure">
          <svg width="140" height="140" viewBox="0 0 140 140" role="img" aria-label={`Spend by category donut chart, ${defaultLabel}`}>
            <g transform="rotate(-90 70 70)">
              {arcs.map((arc) => (
                <g
                  key={arc.category}
                  className="cc-seg"
                  tabIndex={0}
                  onMouseEnter={() => setActive(arc.category)}
                  onMouseLeave={() => setActive(null)}
                  onFocus={() => setActive(arc.category)}
                  onBlur={() => setActive(null)}
                  aria-label={`${arc.label}, ${Math.round(arc.share * 100)} percent, ${formatMoney(arc.total)}`}
                >
                  <circle
                    cx={70}
                    cy={70}
                    r={R}
                    fill="none"
                    stroke={`var(${categoryColorVar(arc.category)})`}
                    strokeWidth={16}
                    strokeDasharray={`${arc.dash} ${CIRCUMFERENCE - arc.dash}`}
                    strokeDashoffset={arc.offset}
                  />
                </g>
              ))}
            </g>
          </svg>
          <div className="cc-donut-center">
            <span className="pct">{Math.round((active ? activeSegment.share : segments[0]!.share) * 100)}%</span>
            <span className="lbl">{active ? activeSegment.label : segments[0]!.label}</span>
          </div>
        </div>

        <div className="cc-legend">
          {segments.slice(0, 6).map((s) => (
            <div
              key={s.category}
              className={`cc-legend-row${active === s.category ? " is-active" : ""}`}
              onMouseEnter={() => setActive(s.category)}
              onMouseLeave={() => setActive(null)}
            >
              <span className="cc-legend-dot" style={{ background: `var(${categoryColorVar(s.category)})` }} />
              <span className="cc-legend-name">{s.label}</span>
              <span className="cc-legend-pct">{Math.round(s.share * 100)}%</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
