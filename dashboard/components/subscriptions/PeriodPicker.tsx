"use client";

import { useState } from "react";

const YEARLY_MONTHS = 12;
const QUARTERLY_MONTHS = 3;
const DEFAULT_MULTIYEAR_YEARS = 2;

type PeriodType = "yearly" | "quarterly" | "multiyear";

function periodTypeForMonths(months: number): { periodType: PeriodType; years: number } {
  if (months === YEARLY_MONTHS) return { periodType: "yearly", years: DEFAULT_MULTIYEAR_YEARS };
  if (months === QUARTERLY_MONTHS) return { periodType: "quarterly", years: DEFAULT_MULTIYEAR_YEARS };
  // An existing schedule outside the three named buckets (only possible
  // if it was created before this picker existed) still needs a sane
  // starting point — nearest whole year, at least 2.
  return { periodType: "multiyear", years: Math.max(2, Math.round(months / 12)) };
}

// Renders as plain label/control pairs (no wrapping element) so it slots
// directly into the parent <form className="entry-form entry-form--grid">
// alongside the label/manual-entry.tsx-input pairs — same 2-column grid
// convention as every other form in this app. Only the Multi-year branch
// needs client interactivity at all (showing/hiding the years field); the
// two fixed periods and the final `months` value are still just a hidden
// input on submit, so the server action's shape (a plain integer months
// field, 0022's own column) never has to know these three named periods
// exist.
export function PeriodPicker({ defaultMonths = YEARLY_MONTHS }: { defaultMonths?: number }) {
  const initial = periodTypeForMonths(defaultMonths);
  const [periodType, setPeriodType] = useState<PeriodType>(initial.periodType);
  const [years, setYears] = useState(initial.years);

  const months = periodType === "yearly" ? YEARLY_MONTHS : periodType === "quarterly" ? QUARTERLY_MONTHS : years * 12;

  return (
    <>
      <label htmlFor="period_type">Period</label>
      <select id="period_type" value={periodType} onChange={(e) => setPeriodType(e.target.value as PeriodType)}>
        <option value="yearly">Yearly (12 months)</option>
        <option value="quarterly">Quarterly (3 months)</option>
        <option value="multiyear">Multi-year</option>
      </select>

      {periodType === "multiyear" && (
        <>
          <label htmlFor="years">Years</label>
          <input
            id="years"
            type="number"
            min={2}
            max={10}
            step={1}
            value={years}
            onChange={(e) => setYears(Math.max(2, Math.min(10, Number(e.target.value) || DEFAULT_MULTIYEAR_YEARS)))}
          />
        </>
      )}

      <input type="hidden" name="months" value={months} />
    </>
  );
}
