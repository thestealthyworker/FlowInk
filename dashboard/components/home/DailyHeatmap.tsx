"use client";

import { useState } from "react";
import { formatMoney } from "@/components/honest-data/MoneyFigure";
import type { DailySpend } from "@/lib/data/dailySpend";

export interface DailyHeatmapProps {
  days: DailySpend[]; // consecutive dates, oldest first, zero-filled by the caller
}

const DAY_LABEL = new Intl.DateTimeFormat("en-SG", { day: "numeric", month: "short" });

// Ported to the artifact's cc-heat widget classes — same cc-card shell as
// every other Command Center widget, real daily spend data.
export function DailyHeatmap({ days }: DailyHeatmapProps) {
  const [readout, setReadout] = useState<string | null>(null);
  const max = Math.max(1, ...days.map((d) => d.total));
  const peak = days.reduce((best, d) => (d.total > best.total ? d : best), days[0] ?? { txn_date: "", total: 0 });

  return (
    <div className="cc-card cc-heat">
      <div className="cc-title">Daily spend, last {days.length} days</div>
      <div className="cc-heat-grid" role="img" aria-label={`Daily spend heatmap for the last ${days.length} days`}>
        {days.map((day) => {
          const label = `${DAY_LABEL.format(new Date(`${day.txn_date}T00:00:00`))} — ${formatMoney(day.total)}`;
          return (
            <div
              key={day.txn_date}
              className="cc-heat-cell"
              tabIndex={0}
              style={{ opacity: Math.max(0.12, day.total / max) }}
              onMouseEnter={() => setReadout(label)}
              onMouseLeave={() => setReadout(null)}
              onFocus={() => setReadout(label)}
              onBlur={() => setReadout(null)}
              aria-label={label}
            />
          );
        })}
      </div>
      <p className="cc-readout" aria-live="polite">
        {readout ?? (peak.total > 0 ? `Rest on a day for its total. Peak: ${DAY_LABEL.format(new Date(`${peak.txn_date}T00:00:00`))}.` : "Rest on a day for its total.")}
      </p>
    </div>
  );
}
