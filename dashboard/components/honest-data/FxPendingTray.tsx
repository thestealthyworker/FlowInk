import type { FxPendingTransaction } from "@/lib/data/spend";
import { formatMoney } from "./MoneyFigure";

// FX-pending state (§4): foreign-currency rows never enter a total — the
// data layer already excludes them (`.eq("currency", "SGD")` throughout
// lib/data/spend.ts); this tray is the rendering decision layered on that
// existing exclusion, surfacing what was left out instead of guessing an
// SGD figure for it.
export function FxPendingTray({ transactions }: { transactions: FxPendingTransaction[] }) {
  if (transactions.length === 0) return null;

  return (
    <aside className="fx-tray" aria-labelledby="fx-tray-heading">
      <p id="fx-tray-heading" className="fx-tray__heading">
        <span aria-hidden="true">⇄</span> Pending conversion ({transactions.length})
      </p>
      <p>Excluded from every total above until reconciled to SGD — never shown as a guessed figure.</p>
      <ul>
        {transactions.map((t) => (
          <li key={t.id}>
            <span>
              {t.merchant_raw} · {t.txn_date}
            </span>
            <span className="money-figure">{formatMoney(t.amount, t.currency)}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}
