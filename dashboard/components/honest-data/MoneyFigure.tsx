// The shared money renderer every honest-data primitive below builds on.
// Confirmed is the default rendering (§4: "no badge — the absence of a
// marker is the signal"); ProvisionalAmount below is the only thing that
// changes posture, never this component's own props surface.

export interface MoneyFigureProps {
  amount: number;
  currency?: string;
  className?: string;
  signDisplay?: "auto" | "always";
}

export function formatMoney(amount: number, currency = "SGD"): string {
  const prefix = currency === "SGD" ? "S$" : `${currency} `;
  const abs = Math.abs(amount);
  const formatted = abs.toLocaleString("en-SG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${amount < 0 ? "-" : ""}${prefix}${formatted}`;
}

export function MoneyFigure({ amount, currency = "SGD", className }: MoneyFigureProps) {
  return <span className={`money-figure ${className ?? ""}`.trim()}>{formatMoney(amount, currency)}</span>;
}
