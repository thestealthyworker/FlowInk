import Link from "next/link";
import { formatMoney } from "@/components/honest-data/MoneyFigure";
import type { Transaction } from "@/lib/supabase/types";

// §2 point 4: below the fold — this period's manual entries, a link into
// /triage showing the outstanding count, and a link into /breakdown for
// today's context. /breakdown shipped in Phase D3 — this is a real link
// now, not the ghost placeholder it used to be.
export function BelowFold({
  manualTxns,
  guessedCount,
}: {
  manualTxns: Pick<Transaction, "id" | "txn_date" | "merchant_raw" | "amount" | "currency">[];
  guessedCount: number;
}) {
  return (
    <section className="below-fold" aria-label="This month, continued">
      <div className="manual-preview">
        <h2>Manual entries this month</h2>
        {manualTxns.length > 0 ? (
          <ul>
            {manualTxns.map((t) => (
              <li key={t.id}>
                <span>
                  {t.merchant_raw} · {t.txn_date}
                </span>
                <span className="money-figure">{formatMoney(Number(t.amount), t.currency)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p>No manual entries this month yet.</p>
        )}
      </div>

      <div className="below-fold__links">
        <Link href="/triage" className="below-fold__link">
          Merchant triage
          {guessedCount > 0 && <span className="rail__badge">{guessedCount}</span>}
        </Link>
        <Link href="/breakdown" className="below-fold__link">
          Where it went
        </Link>
      </div>
    </section>
  );
}
