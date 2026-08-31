import { formatMoney } from "@/components/honest-data/MoneyFigure";

export interface CommandCenterKpi {
  label: string;
  value: string;
  delta: string;
  deltaTone?: "good" | "warn" | "critical";
  detail: string;
  ariaLabel: string;
}

// Ported from the artifact's .li-kpi-row — 4 cards, each revealing a
// second computed line on hover/focus (never mouse-only: :focus-within
// mirrors :hover, per the artifact's own accessibility rule).
export function CommandCenterKpiRow({ kpis }: { kpis: CommandCenterKpi[] }) {
  return (
    <div className="li-kpi-row">
      {kpis.map((kpi) => (
        <div key={kpi.label} className="li-kpi" tabIndex={0} role="group" aria-label={kpi.ariaLabel}>
          <div className="label">{kpi.label}</div>
          <div className="value money-figure">{kpi.value}</div>
          <div className={`delta${kpi.deltaTone ? ` ${kpi.deltaTone}` : ""}`}>{kpi.delta}</div>
          <div className="li-reveal">{kpi.detail}</div>
        </div>
      ))}
    </div>
  );
}

export function fmt(amount: number): string {
  return formatMoney(amount);
}
