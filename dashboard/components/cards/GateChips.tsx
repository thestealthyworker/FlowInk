import { formatMoney } from "@/components/honest-data/MoneyFigure";
import type { CardGate } from "@/lib/supabase/types";

// Generic replacement for the old UOB-only "10-txn gate cleared" line and
// Citi's implicit min_spend gate (previously invisible in the UI — only
// inferred from `gate_cleared`). Renders `status.gates[]` generically,
// templated on `gate.kind` (the only two kinds the contract defines
// today, per 0015) rather than hardcoded per-card copy — a third gate
// kind needs a template added here, not a rules-engine change.
export function GateChips({ gates, currency }: { gates: CardGate[]; currency: string }) {
  if (gates.length === 0) return null;

  return (
    <ul className="card-gauge__gates">
      {gates.map((gate, i) => (
        <li key={i} className="card-gauge__gate" data-cleared={gate.cleared || undefined}>
          <span className="card-gauge__gate-glyph" aria-hidden="true">
            {gate.cleared ? "✓" : "○"}
          </span>
          {gate.kind === "txn_count" ? (
            <>
              {gate.actual} of {gate.required} transaction{gate.required === 1 ? "" : "s"}
            </>
          ) : (
            <>
              {formatMoney(gate.actual, currency)} of {formatMoney(gate.required, currency)} minimum spend
            </>
          )}
          {!gate.cleared && gate.scope === "all_rewards" && " — bonus categories locked until this clears"}
        </li>
      ))}
    </ul>
  );
}
