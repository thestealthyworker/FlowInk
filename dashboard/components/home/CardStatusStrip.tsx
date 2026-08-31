import type { CardDashboardStatusRow } from "@/lib/supabase/types";
import { summarizeCardStatus } from "@/lib/derive/cardStatus";

// A one-line-per-card strip, not the full /cards detail view (§2 point 3,
// §3 View 4 is Phase D4's composite gauge). Reachable from the home
// view's CardWatchLine callout (which surfaces just the one most-urgent
// fact) via an in-page anchor down to this section's heading, so the full
// per-card picture stays one click/scroll away rather than disappearing.
export function CardStatusStrip({ cards }: { cards: CardDashboardStatusRow[] }) {
  if (cards.length === 0) return null;

  return (
    <section aria-labelledby="card-strip-heading">
      <h2 id="card-strip-heading">Cards</h2>
      <ul className="card-strip__list">
        {cards.map((card) => {
          const summary = summarizeCardStatus(card.status);
          return (
            <li key={card.method_id} className="card-strip__item" data-tone={summary.tone}>
              <span>
                <span className="card-strip__dot" aria-hidden="true" />
                <span className="card-strip__name">{card.display_name}</span>
              </span>
              <span className="card-strip__detail">
                <span className="card-strip__tone-word">{summary.toneWord}</span>
                {summary.headline}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
