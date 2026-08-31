import Link from "next/link";
import { CardGauge } from "@/components/cards/CardGauge";
import { getCardDashboardStatus } from "@/lib/data/cards";
import { createClient } from "@/lib/supabase/server";

// View 4 — Card optimisation (docs/DASHBOARD_PLAN.md §3 View 4, §6 D4).
// Consumes card_dashboard_status() only — no threshold logic reimplemented
// in TypeScript anywhere in this route or its components; the Postgres
// engine (supabase/migrations/0007_rules_engine.sql) is the single source
// of truth for every gate, tier, and cap decision rendered here.
export default async function CardsPage() {
  const supabase = await createClient();
  const cards = await getCardDashboardStatus(supabase);

  return (
    <div className="cards-page">
      <header className="page-header">
        <p className="page-header__eyebrow">Card optimisation</p>
        <h1>Cards</h1>
        <p>
          Per-card period progress against tiers, caps and transaction counts, straight from the rules engine.{" "}
          <Link href="/cards/tier-3">See the Tier-3 record →</Link>
        </p>
      </header>

      {cards.length === 0 ? (
        <div className="empty-state">
          <p>No cards with rules configured.</p>
        </div>
      ) : (
        <div className="card-gauge-grid">
          {cards.map((card) => (
            <CardGauge key={card.method_id} card={card} />
          ))}
        </div>
      )}
    </div>
  );
}
