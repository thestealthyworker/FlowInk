import { bulkAssignCategoryAction, updateMerchantTriageAction } from "@/lib/actions/merchants";
import { listConfirmedMerchants, listGuessedMerchants } from "@/lib/data/merchants";
import { createClient } from "@/lib/supabase/server";
import { CATEGORIES } from "@/lib/supabase/types";

// Merchant triage (Phase D3 restyle). Triage is COMPLETE as of 2026-08-26
// — 0 of 251 merchants remain at confidence='guessed', down from 251 — so
// the guessed-queue section's empty state is what actually renders today,
// not a hypothetical. Per the task brief, the page's real job now is
// re-classifying already-confirmed merchants (a merchant assigned the
// wrong category, or one whose spending pattern changed), so a searchable
// confirmed-merchant list is the primary content below the (empty) queue.
export default async function TriagePage({
  searchParams,
}: {
  searchParams: Promise<{ merchant?: string; q?: string }>;
}) {
  const params = await searchParams;
  const supabase = await createClient();
  const search = params.q ?? params.merchant ?? "";

  const [guessedRows, confirmedRows] = await Promise.all([
    listGuessedMerchants(supabase),
    listConfirmedMerchants(supabase, search),
  ]);

  const recurring = guessedRows.filter((r) => r.txn_count >= 2);

  return (
    <div className="triage-page">
      <header className="page-header">
        <p className="page-header__eyebrow">Merchant triage</p>
        <h1>Triage</h1>
        <p>Keep the category vocabulary honest — confirm a guess, or re-point a merchant that&rsquo;s in the wrong bucket.</p>
      </header>

      <section aria-labelledby="queue-heading" className="page-section">
        <h2 id="queue-heading">Guessed-category queue</h2>

        {guessedRows.length === 0 ? (
          <div className="empty-state empty-state--good">
            <span className="empty-state__glyph" aria-hidden="true">
              ✓
            </span>
            <p>
              Nothing awaiting triage — every merchant has a confirmed category. If a new merchant shows up
              guessed, it will appear here.
            </p>
          </div>
        ) : (
          <>
            <p>
              {guessedRows.length} merchants at confidence = &ldquo;guessed&rdquo;, {recurring.length} seen 2+ times.
            </p>

            <section aria-labelledby="bulk-heading" className="triage-bulk">
              <h3 id="bulk-heading">Bulk-assign category</h3>
              <p>Select merchants below, choose a category, and apply — marks them confidence = &ldquo;confirmed&rdquo;.</p>
              <form action={bulkAssignCategoryAction}>
                <ul className="triage-checklist">
                  {guessedRows.map((r) => (
                    <li key={r.merchant.id}>
                      <label className="entry-form__checkbox">
                        <input type="checkbox" name="merchant_ids" value={r.merchant.id} />
                        {r.merchant.display_name} — {r.txn_count} txns, S${r.total_amount.toFixed(2)} (currently{" "}
                        {r.merchant.category})
                      </label>
                    </li>
                  ))}
                </ul>

                <label htmlFor="bulk_category">Assign category to selected</label>
                <select id="bulk_category" name="bulk_category" required defaultValue="">
                  <option value="" disabled>
                    Choose a category
                  </option>
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>

                <button type="submit" className="entry-form__submit">
                  Apply to selected
                </button>
              </form>
            </section>

            <ul className="triage-list">
              {guessedRows.map((r) => (
                <MerchantTriageCard key={r.merchant.id} merchant={r.merchant} txnCount={r.txn_count} totalAmount={r.total_amount} />
              ))}
            </ul>
          </>
        )}
      </section>

      <section aria-labelledby="reclassify-heading" className="page-section">
        <h2 id="reclassify-heading">Re-classify a confirmed merchant</h2>
        <p>
          {confirmedRows.length} confirmed merchant{confirmedRows.length === 1 ? "" : "s"}
          {search && ` matching “${search}”`}. This is triage&rsquo;s main job now that the guessed queue is empty —
          fixing a category assigned before a merchant&rsquo;s pattern was clear.
        </p>

        <form className="triage-search" action="/triage" method="get">
          <label htmlFor="q">Search merchant</label>
          <input id="q" name="q" type="search" defaultValue={search} placeholder="e.g. GRAB, NTUC, SHOPEE" />
          <button type="submit">Search</button>
        </form>

        {confirmedRows.length === 0 ? (
          <div className="empty-state">
            <p>No confirmed merchants match that search.</p>
          </div>
        ) : (
          <ul className="triage-list">
            {confirmedRows.slice(0, 60).map((r) => (
              <MerchantTriageCard key={r.merchant.id} merchant={r.merchant} txnCount={r.txn_count} totalAmount={r.total_amount} />
            ))}
          </ul>
        )}
        {confirmedRows.length > 60 && (
          <p className="form-hint">Showing the first 60 of {confirmedRows.length} matches — narrow your search to see more.</p>
        )}
      </section>
    </div>
  );
}

function MerchantTriageCard({
  merchant,
  txnCount,
  totalAmount,
}: {
  merchant: { id: number; display_name: string; match_pattern: string; category: string; is_transfer: boolean; confidence: string };
  txnCount: number;
  totalAmount: number;
}) {
  return (
    <li className="triage-card" id={`merchant-${merchant.id}`}>
      <div className="triage-card__meta">
        <h4>{merchant.display_name}</h4>
        <p>
          Pattern: <code>{merchant.match_pattern}</code> — {txnCount} transaction{txnCount === 1 ? "" : "s"}, S$
          {totalAmount.toFixed(2)} total
          {merchant.confidence === "confirmed" && <span className="tag-default triage-card__tag">confirmed</span>}
        </p>
      </div>
      <form action={updateMerchantTriageAction} className="triage-card__form">
        <input type="hidden" name="merchant_id" value={merchant.id} />

        <label htmlFor={`category-${merchant.id}`}>Category</label>
        <select id={`category-${merchant.id}`} name="category" defaultValue={merchant.category} required>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>

        <label className="entry-form__checkbox">
          <input type="checkbox" name="is_transfer" defaultChecked={merchant.is_transfer} /> Transfer, not spend
        </label>

        <label className="entry-form__checkbox">
          <input type="checkbox" name="confirm" defaultChecked /> Mark confirmed
        </label>

        <button type="submit">Save</button>
      </form>
    </li>
  );
}
