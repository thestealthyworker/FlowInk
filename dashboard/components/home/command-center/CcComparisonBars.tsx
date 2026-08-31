"use client";

import { useState } from "react";
import { formatMoney } from "@/components/honest-data/MoneyFigure";
import { categoryColorVar } from "@/lib/derive/seriesColor";
import type { Category } from "@/lib/supabase/types";

export interface CcComparisonRow {
  category: Category | "uncategorised";
  label: string;
  previousTotal: number;
  currentTotal: number;
}

// Ported from the artifact's cc-bars widget — this month vs. last, top 5
// categories by current spend. Bar heights are relative to the larger of
// the two periods across all rows so bars are comparable at a glance.
export function CcComparisonBars({ rows, currentLabel, previousLabel }: { rows: CcComparisonRow[]; currentLabel: string; previousLabel: string }) {
  const [readout, setReadout] = useState<string | null>(null);
  const max = Math.max(1, ...rows.flatMap((r) => [r.previousTotal, r.currentTotal]));

  if (rows.length === 0) {
    return (
      <div className="cc-card cc-bars">
        <div className="cc-title">This month vs. last</div>
        <p>Not enough data yet to compare months.</p>
      </div>
    );
  }

  return (
    <div className="cc-card cc-bars">
      <div className="cc-title">This month vs. last, top {rows.length} categories</div>
      <div className="cc-bars-chart">
        {rows.map((row) => (
          <div key={row.category} className="cc-bar-group">
            <div
              className="cc-bar prev"
              tabIndex={0}
              style={{ height: `${Math.max(2, (row.previousTotal / max) * 100)}%`, background: `var(${categoryColorVar(row.category)})` }}
              onMouseEnter={() => setReadout(`${row.label} — ${previousLabel} ${formatMoney(row.previousTotal)}`)}
              onFocus={() => setReadout(`${row.label} — ${previousLabel} ${formatMoney(row.previousTotal)}`)}
              onMouseLeave={() => setReadout(null)}
              onBlur={() => setReadout(null)}
              aria-label={`${row.label}, ${previousLabel}, ${formatMoney(row.previousTotal)}`}
            />
            <div
              className="cc-bar"
              tabIndex={0}
              style={{ height: `${Math.max(2, (row.currentTotal / max) * 100)}%`, background: `var(${categoryColorVar(row.category)})` }}
              onMouseEnter={() => setReadout(`${row.label} — ${currentLabel} ${formatMoney(row.currentTotal)}`)}
              onFocus={() => setReadout(`${row.label} — ${currentLabel} ${formatMoney(row.currentTotal)}`)}
              onMouseLeave={() => setReadout(null)}
              onBlur={() => setReadout(null)}
              aria-label={`${row.label}, ${currentLabel}, ${formatMoney(row.currentTotal)}`}
            />
          </div>
        ))}
      </div>
      <div className="cc-bar-labels">
        {rows.map((row) => (
          <span key={row.category}>{row.label}</span>
        ))}
      </div>
      <p className="cc-readout" aria-live="polite">
        {readout ?? "Rest on a bar for the exact figure."}
      </p>
    </div>
  );
}
