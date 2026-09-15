"use client";

import { useRouter } from "next/navigation";

export interface MonthOption {
  value: string; // 'YYYY-MM'
  label: string; // e.g. "August 2026"
}

// The one client-side navigation control on an otherwise link-driven page
// (LedgerFilterBar's own comment explains why filters there are plain
// <Link> chips, not a <select> — free text aside, everything is a real
// URL). A month picker is different: the artifact/plan calls for a
// dropdown specifically, and 12+ months as a chip row would be unusable
// where a handful of filter chips isn't. Still a real URL underneath —
// this only ever navigates to /?month=YYYY-MM(&...other params), never
// holds state client-side that a reload would lose.
export function MonthSelector({ months, selected }: { months: MonthOption[]; selected: string }) {
  const router = useRouter();

  return (
    <label className="month-selector">
      <span className="visually-hidden">Select month</span>
      <select
        value={selected}
        onChange={(e) => {
          const params = new URLSearchParams(window.location.search);
          params.set("month", e.target.value);
          router.push(`/?${params.toString()}#command-center`);
        }}
      >
        {months.map((m) => (
          <option key={m.value} value={m.value}>
            {m.label}
          </option>
        ))}
      </select>
    </label>
  );
}
