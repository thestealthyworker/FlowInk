import type { LedgerRow } from "../data/ledger";

export interface LedgerDateGroup {
  dateHeading: string;
  rows: LedgerRow[];
}

const HEADING_FORMATTER = new Intl.DateTimeFormat("en-SG", {
  weekday: "long",
  day: "numeric",
  month: "long",
});

/** Groups already-sorted ledger rows into consecutive same-date runs,
 * preserving row order — grouping breaks if rows aren't date-sorted first. */
export function groupByDate(rows: LedgerRow[]): LedgerDateGroup[] {
  const groups: LedgerDateGroup[] = [];

  for (const row of rows) {
    const heading = HEADING_FORMATTER.format(new Date(`${row.txn_date}T00:00:00`));
    const current = groups.at(-1);
    if (current && current.dateHeading === heading) {
      current.rows.push(row);
    } else {
      groups.push({ dateHeading: heading, rows: [row] });
    }
  }

  return groups;
}
