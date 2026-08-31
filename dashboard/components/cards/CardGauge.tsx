import { formatMoney } from "@/components/honest-data/MoneyFigure";
import { buildHsbcGaugeData, buildUobGaugeData, detectCardKind } from "@/lib/derive/cardGauge";
import type { CardDashboardStatusRow } from "@/lib/supabase/types";
import { HsbcGauge } from "./HsbcGauge";
import { UobGauge } from "./UobGauge";

// §3 View 4's composite gauge, dispatched per card kind. Citi renders as a
// greyed "ghost" card with a single line ("not yet issued") rather than
// being hidden, per the mark spec — the operator sees the system is aware
// of the card, not that it silently forgot.
export function CardGauge({ card }: { card: CardDashboardStatusRow }) {
  const kind = detectCardKind(card.status);

  if (kind === "citi-ghost") {
    return (
      <article className="card-gauge-card card-gauge-card--ghost" aria-label={`${card.display_name} — not yet issued`}>
        <h3>{card.display_name}</h3>
        <p>Not yet issued. The system is aware of this card and will start tracking it the moment it&rsquo;s live.</p>
      </article>
    );
  }

  if (kind === "uob") {
    const data = buildUobGaugeData(card.status);
    const quarter = (card.status.quarter ?? {}) as Parameters<typeof UobGauge>[0]["quarter"];
    return (
      <article className="card-gauge-card" aria-labelledby={`card-${card.method_id}-heading`}>
        <h3 id={`card-${card.method_id}-heading`}>{card.display_name}</h3>
        <UobGauge data={data} quarter={quarter} />
        <RawStatusTable status={card.status} />
      </article>
    );
  }

  if (kind === "hsbc") {
    const data = buildHsbcGaugeData(card.status);
    return (
      <article className="card-gauge-card" aria-labelledby={`card-${card.method_id}-heading`}>
        <h3 id={`card-${card.method_id}-heading`}>{card.display_name}</h3>
        <HsbcGauge data={data} />
        <RawStatusTable status={card.status} />
      </article>
    );
  }

  // Generic fallback — a has_rules method the dispatcher doesn't
  // recognise a dedicated gauge shape for yet. Never silently drops the
  // card; shows whatever the engine returned as a flat table instead.
  return (
    <article className="card-gauge-card" aria-labelledby={`card-${card.method_id}-heading`}>
      <h3 id={`card-${card.method_id}-heading`}>{card.display_name}</h3>
      {typeof card.status.spend === "number" && (
        <p className="card-gauge__figures">
          <span className="money-figure card-gauge__headline">{formatMoney(card.status.spend)}</span>
        </p>
      )}
      <RawStatusTable status={card.status} />
    </article>
  );
}

/** The accessibility-pass table-view twin every chart in this plan
 * requires (§3's own rule) — here doubling as full correctness coverage:
 * every field card_dashboard_status() returns for this card, unfiltered,
 * so a hand-check against a live RPC call (§6 D4 acceptance) has
 * something to check against directly in the rendered page. */
function RawStatusTable({ status }: { status: Record<string, unknown> }) {
  const entries = Object.entries(status).filter(([key]) => key !== "quarter");

  return (
    <details className="card-gauge__raw">
      <summary>View raw status</summary>
      <table className="data-table">
        <tbody>
          {entries.map(([key, value]) => (
            <tr key={key}>
              <th scope="row">{key}</th>
              <td>{formatRawValue(value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function formatRawValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
