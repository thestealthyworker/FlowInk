import { GuessedCategoryLabel } from "@/components/honest-data/GuessedCategoryLabel";
import { formatMoney } from "@/components/honest-data/MoneyFigure";
import { ProvisionalAmount } from "@/components/honest-data/ProvisionalAmount";
import type { LedgerRow } from "@/lib/data/ledger";
import { groupByDate } from "@/lib/derive/ledgerGrouping";
import { categoryColorVar } from "@/lib/derive/seriesColor";

export interface LedgerTableProps {
  rows: LedgerRow[];
  guessedIds: Set<number>;
}

// Ported to the artifact's date-grouped .li-date-group/.li-tx-row markup
// exactly — real transaction data, real honest-data states (confirmed has
// no badge, provisional is italic+dashed, FX-pending shows the original
// currency). No visible sort control — the artifact has none; default sort
// stays date-desc (set by the caller's data fetch), matching it exactly.
export function LedgerTable({ rows, guessedIds }: LedgerTableProps) {
  if (rows.length === 0) {
    return (
      <div className="empty-state">
        <p>No transactions match these filters.</p>
      </div>
    );
  }

  const groups = groupByDate(rows);

  return (
    <div>
      {groups.map((group) => (
        <div key={group.dateHeading} className="li-date-group">
          <div className="li-date-heading">{group.dateHeading}</div>
          {group.rows.map((row) => (
            <LedgerTxRow key={row.id} row={row} guessedIds={guessedIds} />
          ))}
        </div>
      ))}
    </div>
  );
}

function LedgerTxRow({ row, guessedIds }: { row: LedgerRow; guessedIds: Set<number> }) {
  const isFxPending = row.currency !== "SGD";
  const isGuessedMerchant = row.merchant_id !== null && guessedIds.has(row.merchant_id);
  const day = new Date(`${row.txn_date}T00:00:00`).getDate();

  return (
    <div className="li-tx-row">
      <span className="day num money-figure">{String(day).padStart(2, "0")}</span>
      <span className="merchant">{row.merchant_display}</span>
      <span className="cat">
        <span className="dot" style={{ background: `var(${categoryColorVar(row.category)})` }} />
        <GuessedCategoryLabel category={row.category} isGuessed={isGuessedMerchant} merchantFilter={row.merchant_raw} />
      </span>
      <span className="card-badge">
        {row.method_display_name}
        {row.method_last4 ? ` ••${row.method_last4}` : ""}
      </span>
      <span className="amount">
        {row.status === "provisional" ? (
          <ProvisionalAmount amount={row.amount} currency={row.currency} />
        ) : (
          <span className="money-figure">{formatMoney(row.amount, row.currency)}</span>
        )}
      </span>
      <span className={`status${isFxPending ? " fx" : row.status === "provisional" ? " provisional" : row.status === "disputed" ? " fx" : " confirmed"}`}>
        {isFxPending ? "FX Pending" : row.status === "provisional" ? "Provisional" : row.status === "disputed" ? "Disputed" : "Confirmed"}
      </span>
    </div>
  );
}
