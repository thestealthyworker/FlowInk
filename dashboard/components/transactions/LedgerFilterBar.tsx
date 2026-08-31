import Link from "next/link";
import type { LedgerFacets } from "@/lib/data/ledger";
import { buildLedgerHref, type LedgerQueryParams } from "@/lib/ledgerQuery";

export interface LedgerFilterValues {
  q: string;
  category: string;
  method: string;
  from: string;
  to: string;
}

// Ported to the artifact's exact li-ledger-controls shape: a plain search
// input plus a row of clickable category/card/date-range chips — real
// links (buildLedgerHref), not a form with native <select>/<input type=date>
// controls (those rendered as bulky OS-styled boxes the artifact never
// had). Only the search field is a form, since free text can't be a chip.
export function LedgerFilterBar({ facets, values, currentParams }: { facets: LedgerFacets; values: LedgerFilterValues; currentParams: LedgerQueryParams }) {
  const today = new Date();
  const last7From = new Date(today);
  last7From.setDate(today.getDate() - 6);
  const last7FromStr = last7From.toISOString().slice(0, 10);
  const last7ToStr = today.toISOString().slice(0, 10);
  const isLast7Active = values.from === last7FromStr && values.to === last7ToStr;

  return (
    <div className="li-ledger-controls">
      <form action="/" method="get">
        <label htmlFor="ledger-q" className="visually-hidden">
          Search merchant
        </label>
        <div className="li-search-catalog">
          <span className="idx" aria-hidden="true">
            §
          </span>
          <input id="ledger-q" name="q" type="search" defaultValue={values.q} placeholder="Search the ledger — merchant, card, note…" />
        </div>
      </form>

      <Link href={buildLedgerHref(currentParams, { category: undefined, page: undefined })} className={`li-chip${!values.category ? " active" : ""}`}>
        All categories
      </Link>
      {facets.categories.map((c) => (
        <Link key={c} href={buildLedgerHref(currentParams, { category: c, page: undefined })} className={`li-chip${values.category === c ? " active" : ""}`}>
          {c.charAt(0).toUpperCase() + c.slice(1)}
        </Link>
      ))}

      {facets.methods.map((m) => (
        <Link key={m.id} href={buildLedgerHref(currentParams, { method: m.id, page: undefined })} className={`li-chip${values.method === m.id ? " active" : ""}`}>
          {m.display_name}
        </Link>
      ))}

      <Link
        href={buildLedgerHref(currentParams, { from: isLast7Active ? undefined : last7FromStr, to: isLast7Active ? undefined : last7ToStr, page: undefined })}
        className={`li-chip${isLast7Active ? " active" : ""}`}
      >
        Last 7 days
      </Link>

      {(values.q || values.category || values.method || values.from || values.to) && (
        <a href="/#ledger" className="li-chip">
          Clear
        </a>
      )}
    </div>
  );
}
