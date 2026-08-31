import { formatMoney } from "./MoneyFigure";

// `{method}:pending` period-key state (§4, §7 item 3): the rules engine
// cannot yet emit this state — SETUP_STATUS's cycle-day/public-holiday
// note for the 2026-08-16 UOB transaction is the closest existing
// analogue, but nothing in the schema currently marks a transaction this
// way. Built as a primitive now, per the plan's explicit recommendation
// ("building the dashboard's rendering ahead of the engine emitting the
// state is fine"), so the shape exists once (if) the engine gains it —
// not called anywhere in this phase's live views.
export function PeriodPendingRow({
  merchantRaw,
  amount,
  txnDate,
  onOverride,
}: {
  merchantRaw: string;
  amount: number;
  txnDate: string;
  onOverride?: () => void;
}) {
  return (
    <div className="period-pending-row">
      <span>
        {merchantRaw} · {txnDate} · <span className="money-figure">{formatMoney(amount)}</span>
      </span>
      <span className="period-pending-row__tag">Period unresolved</span>
      {onOverride && (
        <button type="button" onClick={onOverride}>
          Assign period
        </button>
      )}
    </div>
  );
}
