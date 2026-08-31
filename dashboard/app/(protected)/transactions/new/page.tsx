import { createManualTransactionAction, deleteManualTransactionAction } from "@/lib/actions/transactions";
import { listManualTransactions } from "@/lib/data/transactions";
import { currentCalendarMonth } from "@/lib/date";
import { createClient } from "@/lib/supabase/server";
import { CATEGORIES } from "@/lib/supabase/types";
import { ConfirmSubmitButton } from "@/components/ui/ConfirmSubmitButton";
import { formatMoney } from "@/components/honest-data/MoneyFigure";

// Manual entry for non-card spend (Phase D5 restyle; docs/cardledger-build-spec.md
// §10 AMENDMENT, §14 "cash is invisible"). Always source='manual',
// method_id='manual'. This is the only write path for cash / bank
// transfer / non-DBS GIRO — the one thing the ingest pipeline structurally
// cannot see — so speed of entry matters more than anything else on this
// page: date defaults to today, currency defaults to SGD, category is the
// only required decision beyond amount and description.
export default async function NewTransactionPage() {
  const supabase = await createClient();
  const calendarMonth = currentCalendarMonth();
  const manualTxns = await listManualTransactions(supabase, calendarMonth);
  const today = new Date().toISOString().slice(0, 10);
  const monthTotal = manualTxns.reduce((sum, t) => sum + Number(t.amount), 0);

  return (
    <div className="manual-entry-page">
      <header className="page-header">
        <p className="page-header__eyebrow">Add manual entry</p>
        <h1>Non-card spend</h1>
        <p>
          Cash, bank transfer, GIRO from a non-DBS account: anything the ingest pipeline structurally cannot see.
          These rows are the only transactions this dashboard can edit or delete — bank-sourced history is immutable
          from the browser, enforced by RLS, not just this form.
        </p>
      </header>

      <section aria-labelledby="entry-form-heading" className="page-section">
        <h2 id="entry-form-heading" className="visually-hidden">
          New entry
        </h2>
        <form action={createManualTransactionAction} className="entry-form entry-form--grid">
          <label htmlFor="txn_date">Date</label>
          <input id="txn_date" name="txn_date" type="date" required defaultValue={today} max={today} />

          <label htmlFor="amount">Amount</label>
          <input id="amount" name="amount" type="number" step="0.01" min="0.01" required placeholder="0.00" inputMode="decimal" />

          <label htmlFor="merchant_raw" className="entry-form__full">
            Merchant / description
          </label>
          <input id="merchant_raw" name="merchant_raw" type="text" required placeholder="e.g. hawker centre lunch" className="entry-form__full" />

          <label htmlFor="category">Category</label>
          <select id="category" name="category" required defaultValue="">
            <option value="" disabled>
              Choose a category
            </option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>

          <label htmlFor="currency">Currency</label>
          <input id="currency" name="currency" type="text" defaultValue="SGD" maxLength={3} required style={{ textTransform: "uppercase" }} />

          <label className="entry-form__checkbox entry-form__full">
            <input type="checkbox" name="is_transfer" /> Transfer, not spend (e.g. moving money between own accounts)
          </label>

          <button type="submit" className="entry-form__submit entry-form__full">
            Add entry
          </button>
        </form>
      </section>

      <section aria-labelledby="manual-list-heading" className="page-section">
        <h2 id="manual-list-heading">This month&rsquo;s manual entries</h2>
        <p>
          {manualTxns.length} entr{manualTxns.length === 1 ? "y" : "ies"} · <span className="money-figure">{formatMoney(monthTotal)}</span>{" "}
          total this month
        </p>

        {manualTxns.length > 0 ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Merchant</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Category</th>
                  <th scope="col">Transfer</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {manualTxns.map((t) => (
                  <tr key={t.id}>
                    <td>{t.txn_date}</td>
                    <td>{t.merchant_raw}</td>
                    <td className="money-figure">{formatMoney(Number(t.amount), t.currency)}</td>
                    <td>{t.category}</td>
                    <td>{t.is_transfer ? "yes" : "no"}</td>
                    <td>
                      <form action={deleteManualTransactionAction}>
                        <input type="hidden" name="id" value={t.id} />
                        <ConfirmSubmitButton label="Delete" confirmLabel="Confirm delete?" />
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <p>No manual entries this month yet.</p>
          </div>
        )}
      </section>
    </div>
  );
}
