import Link from "next/link";
import { LedgerFilterBar, type LedgerFilterValues } from "@/components/transactions/LedgerFilterBar";
import { LedgerTable } from "@/components/transactions/LedgerTable";
import type { LedgerFacets, LedgerRow } from "@/lib/data/ledger";
import { buildLedgerHref, type LedgerQueryParams } from "@/lib/ledgerQuery";

export interface LedgerSectionProps {
  rows: LedgerRow[];
  total: number;
  facets: LedgerFacets;
  guessedIds: Set<number>;
  currentParams: LedgerQueryParams;
  filterValues: LedgerFilterValues;
  pageNum: number;
  totalPages: number;
  pageSize: number;
}

// The artifact's Ledger section, rendered as an in-page anchor (#ledger)
// on the single Command Center page rather than its own route, per the
// operator's "same page as the artifact" ask. Filters/pagination still
// live entirely in the URL (?q=&category=&...#ledger) — no visible sort
// control, matching the artifact exactly (default sort stays date-desc).
export function LedgerSection({
  rows,
  total,
  facets,
  guessedIds,
  currentParams,
  filterValues,
  pageNum,
  totalPages,
  pageSize,
}: LedgerSectionProps) {
  const rangeStart = total === 0 ? 0 : (pageNum - 1) * pageSize + 1;
  const rangeEnd = Math.min(pageNum * pageSize, total);

  return (
    <section id="ledger">
      <div className="section-label">Transaction ledger</div>
      <p className="aside voice" style={{ marginBottom: "1.5rem", maxWidth: "60ch" }}>
        Every card and manual transaction, filtered, sorted, and paged through the URL — a filtered view here is a link you can send
        yourself.
      </p>

      <LedgerFilterBar facets={facets} values={filterValues} currentParams={currentParams} />

      <p className="ledger-summary">
        Showing {rangeStart}–{rangeEnd} of {total} transaction{total === 1 ? "" : "s"}
      </p>

      <LedgerTable rows={rows} guessedIds={guessedIds} />

      {totalPages > 1 && (
        <nav className="li-ledger-pagination" aria-label="Ledger pages">
          {pageNum > 1 && <Link href={buildLedgerHref(currentParams, { page: String(pageNum - 1) })}>&larr; Newer</Link>}
          <span>
            Page {pageNum} of {totalPages}
          </span>
          {pageNum < totalPages && <Link href={buildLedgerHref(currentParams, { page: String(pageNum + 1) })}>Older &rarr;</Link>}
        </nav>
      )}
    </section>
  );
}
