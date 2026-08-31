"use client";

import { useState } from "react";
import { formatMoney } from "@/components/honest-data/MoneyFigure";

export interface CcTrendPoint {
  label: string; // e.g. "Mar", "Aug (MTD)"
  total: number;
}

const VIEW_W = 300;
const VIEW_H = 88;

// Ported from the artifact's cc-area widget — a gradient area/line trend
// with a hover/focus-reveal readout per point, real trailing months.
export function CcAreaTrend({ points, currentLabel }: { points: CcTrendPoint[]; currentLabel: string }) {
  const [readout, setReadout] = useState<string | null>(null);

  if (points.length === 0) {
    return (
      <div className="cc-card cc-area">
        <div className="cc-title">Trend</div>
        <p>Not enough months yet to chart a trend.</p>
      </div>
    );
  }

  const max = Math.max(...points.map((p) => p.total), 1);
  const min = Math.min(...points.map((p) => p.total));
  const span = Math.max(1, max - min);
  const stepX = points.length > 1 ? VIEW_W / (points.length - 1) : VIEW_W;
  const coords = points.map((p, i) => ({
    ...p,
    x: i * stepX,
    y: VIEW_H - 12 - ((p.total - min) / span) * (VIEW_H - 24),
  }));

  const linePoints = coords.map((c) => `${c.x},${c.y}`).join(" ");
  const areaPoints = `${linePoints} ${VIEW_W},${VIEW_H} 0,${VIEW_H}`;
  const latest = points[points.length - 1]!;

  return (
    <div className="cc-card cc-area">
      <div className="cc-title">Six-month trend</div>
      <div className="cc-area-figs">
        <span className="val money-figure">{formatMoney(latest.total)}</span>
        <span style={{ fontSize: "0.78rem", color: "var(--color-ink-muted)" }}>{currentLabel}, not yet final</span>
      </div>
      <svg className="cc-area-svg" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} preserveAspectRatio="none" role="img" aria-label={`Monthly spend trend over ${points.length} months`}>
        <defs>
          <linearGradient id="ccAreaFade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={areaPoints} fill="url(#ccAreaFade)" />
        <polyline points={linePoints} fill="none" stroke="var(--color-accent)" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" />
        {coords.map((c, i) => (
          <circle
            key={c.label}
            className="pt"
            tabIndex={0}
            cx={c.x}
            cy={c.y}
            r={i === coords.length - 1 ? 5 : 4}
            fill="var(--color-accent)"
            onMouseEnter={() => setReadout(`${c.label} — ${formatMoney(c.total)}`)}
            onFocus={() => setReadout(`${c.label} — ${formatMoney(c.total)}`)}
            onMouseLeave={() => setReadout(null)}
            onBlur={() => setReadout(null)}
            aria-label={`${c.label}, ${formatMoney(c.total)}`}
          />
        ))}
        <g fontFamily="var(--font-money)" fontSize="9" fill="var(--color-ink-muted)">
          {coords.map((c) => (
            <text key={c.label} x={c.x} y={VIEW_H - 4} textAnchor="middle">
              {c.label.toUpperCase()}
            </text>
          ))}
        </g>
      </svg>
      <p className="cc-readout" aria-live="polite">
        {readout ?? "Rest on a point for that month's total."}
      </p>
    </div>
  );
}
