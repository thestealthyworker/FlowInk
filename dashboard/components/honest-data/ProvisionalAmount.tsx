import { formatMoney } from "./MoneyFigure";

// Provisional state (§4): italic Plex Mono with a dashed underline — same
// face as a confirmed figure, different posture, so the eye catches the
// difference without a legend.
export function ProvisionalAmount({ amount, currency = "SGD" }: { amount: number; currency?: string }) {
  return <span className="money-figure money-figure--provisional">{formatMoney(amount, currency)}</span>;
}

// Confirmed/provisional split, shown as two numbers rather than pre-summed
// into one the reader can't take apart (§4). Renders nothing when there is
// no provisional component — the split only earns its place once it means
// something.
export function AmountWithProvisionalSplit({
  confirmedTotal,
  provisionalTotal,
  currency = "SGD",
}: {
  confirmedTotal: number;
  provisionalTotal: number;
  currency?: string;
}) {
  if (provisionalTotal <= 0) {
    return <span className="money-figure">{formatMoney(confirmedTotal, currency)}</span>;
  }

  return (
    <span className="provisional-note">
      <span className="money-figure">{formatMoney(confirmedTotal, currency)}</span>
      {" + "}
      <ProvisionalAmount amount={provisionalTotal} currency={currency} />
      <svg className="provisional-note__clock" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M8 4.5V8l2.6 1.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
      <span className="visually-hidden">
        {formatMoney(provisionalTotal, currency)} of this is still provisional, not yet confirmed
      </span>
    </span>
  );
}
