export type LedgerQueryParams = Record<string, string | undefined>;

/** Builds a home-page href (with a #ledger anchor) from the current query
 * params with the given overrides applied — the mechanism behind every
 * sort/pagination link, so a filtered, sorted, paged view is always a real
 * shareable URL, never client-only state. The ledger lives on the single
 * Command Center page now, not its own route. */
export function buildLedgerHref(current: LedgerQueryParams, overrides: LedgerQueryParams): string {
  const merged = { ...current, ...overrides };
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(merged)) {
    if (value) search.set(key, value);
  }

  const qs = search.toString();
  return qs ? `/?${qs}#ledger` : "/#ledger";
}
