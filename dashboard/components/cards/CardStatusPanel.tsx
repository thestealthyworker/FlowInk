import { formatMoney, MoneyFigure } from "@/components/honest-data/MoneyFigure";
import { IntegrationNotice } from "@/components/honest-data/IntegrationNotice";
import type { CardDashboardStatusRow, CardPeriodStatus } from "@/lib/supabase/types";
import { GateChips } from "./GateChips";
import { GroupStrip } from "./GroupStrip";
import { RateTrack } from "./RateTrack";
import { TierTrack } from "./TierTrack";

// The generic replacement for the old CardGauge.tsx dispatcher
// (detectCardKind + UobGauge/HsbcGauge/RawStatusTable-fallback). One
// component, reading only fields the contract itself names —
// reward_tracks[].kind, cap.basis, gates[], group, estimate_caveats[] —
// never a method_id or a duck-typed field-name guess. A card outside the
// three this team has written rules for (or one with none at all) renders
// through the exact same path every other card does, not a degraded
// fallback table.
export function CardStatusPanel({ card }: { card: CardDashboardStatusRow }) {
  const status = card.status;
  const headingId = `card-${card.method_id}-heading`;

  if (status.error) {
    return (
      <article className="card-gauge-card card-gauge-card--ghost" aria-labelledby={headingId}>
        <h3 id={headingId}>{card.display_name}</h3>
        <p>{describeError(status.error)}</p>
      </article>
    );
  }

  if (status.active === false) {
    return (
      <article className="card-gauge-card card-gauge-card--ghost" aria-labelledby={headingId}>
        <h3 id={headingId}>{card.display_name}</h3>
        <p>Not yet active. The system is aware of this card and will start tracking it the moment it&rsquo;s live.</p>
      </article>
    );
  }

  if (status.has_rules === false) {
    // card_dashboard_status() already filters to has_rules = true, so this
    // is defensive rather than a path any live row takes today — kept so
    // this component never silently mishandles a shape it could see.
    return (
      <article className="card-gauge-card card-gauge-card--budget-only" aria-labelledby={headingId}>
        <h3 id={headingId}>{card.display_name}</h3>
        <p className="card-gauge__meta">No reward rules configured for this method — budget tracking only.</p>
      </article>
    );
  }

  const currency = status.currency ?? "SGD";
  const money = (amount: number) => formatMoney(amount, currency);
  const spend = status.spend?.total ?? 0;
  const txnCount = status.spend?.txn_count ?? null;
  const daysLeft = status.period?.days_left ?? null;
  const periodKind = status.period?.kind ?? "period";
  const gates = status.gates ?? [];
  const tracks = status.reward_tracks ?? [];
  const tierTrack = tracks.find((t) => t.kind === "tier");
  const rateTracks = tracks.filter((t) => t.kind === "category_rate");
  const cap = status.cap ?? null;
  const rewardAccrued = status.reward_accrued;
  const atRisk = status.at_risk?.value === true;
  const caveats = status.estimate_caveats ?? [];

  return (
    <article className="card-gauge-card" aria-labelledby={headingId}>
      <h3 id={headingId}>
        {card.display_name}
        {atRisk && <span className="card-gauge__tag card-gauge__tag--warning">At risk</span>}
      </h3>

      <div className="card-gauge">
        <div className="card-gauge__figures">
          <span className="money-figure card-gauge__headline">
            <MoneyFigure amount={spend} currency={currency} />
          </span>
          <span className="card-gauge__sub">
            this {periodKind}
            {daysLeft !== null && ` · ${daysLeft} day${daysLeft === 1 ? "" : "s"} left`}
          </span>
        </div>

        <GateChips gates={gates} currency={currency} />

        {tierTrack && <TierTrack track={tierTrack} spend={spend} txnCount={txnCount} currency={currency} />}

        {rateTracks.length > 0 && (
          <div className="card-gauge__section-group">
            {rateTracks.map((track, i) => (
              <RateTrack key={i} track={track} currency={currency} />
            ))}
          </div>
        )}

        {rateTracks.length > 0 && typeof rewardAccrued === "number" && (
          <p className="card-gauge__meta">
            Rate-based reward this period: <MoneyFigure amount={rewardAccrued} currency={currency} />
            {cap && ` of a ${money(cap.amount)} ${cap.basis} cap (${money(cap.remaining ?? 0)} left${cap.exhausted ? ", cap reached" : ""})`}.
          </p>
        )}

        {!tierTrack && rateTracks.length === 0 && (
          <p className="card-gauge__meta">No reward rules matched this period.</p>
        )}

        {status.crediting && (
          <p className="card-gauge__meta">
            Credits in blocks of {money(status.crediting.block_size)}, once accrual reaches{" "}
            {money(status.crediting.floor)}. Credited so far: <MoneyFigure amount={status.crediting.credited} currency={currency} />
            {status.crediting.accrued_uncredited > 0 && (
              <>
                {" "}
                — <MoneyFigure amount={status.crediting.accrued_uncredited} currency={currency} /> accrued but not yet
                credited.
              </>
            )}
          </p>
        )}

        {status.group && <GroupStrip group={status.group} currency={currency} />}

        {caveats.length > 0 && (
          <IntegrationNotice tone="calm">
            {caveats.map((caveat, i) => (
              <p key={i}>{caveat}</p>
            ))}
          </IntegrationNotice>
        )}
      </div>

      <RawStatusTable status={status} />
    </article>
  );
}

// The DB's `note`/`error` strings are developer-facing (reference a
// column name, a migration section) — surfaced with a short, honest
// prefix rather than left as raw backend text, but never invented.
function describeError(error: string): string {
  return `This card’s status can’t be shown right now: ${error}`;
}

/** The accessibility-pass table-view twin every chart in this plan
 * requires, doubling as a genuine debug/audit aid: every field this
 * card's status carries, unfiltered, behind a <details> — not the only
 * view an unrecognised card gets (that was the old fallback's problem),
 * just always available alongside the real one. */
function RawStatusTable({ status }: { status: CardPeriodStatus }) {
  const entries = Object.entries(status).filter(([key]) => key !== "group");

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
