import Link from "next/link";
import { CardStatusPanel } from "@/components/cards/CardStatusPanel";
import { BudgetOnlyCard } from "@/components/cards/BudgetOnlyCard";
import { getCardDashboardStatus } from "@/lib/data/cards";
import { listPaymentMethods } from "@/lib/data/methods";
import { getPaymentMethodSplit } from "@/lib/data/spend";
import { currentCalendarMonth } from "@/lib/date";
import { createClient } from "@/lib/supabase/server";

// View 4 — Card optimisation (docs/DASHBOARD_PLAN.md §3 View 4, §6 D4).
// Consumes card_dashboard_status() (WP4: repointed to the generic
// evaluator, supabase/migrations/0017_repoint_card_period_status.sql) for
// every has_rules = true method, plus payment_methods directly for the
// has_rules = false, active = true ones (PayLah today) that RPC
// deliberately excludes (0007's own comment: "a wallet has nothing to
// show here"). No threshold/gate/reward logic is reimplemented in
// TypeScript anywhere on this route — the Postgres evaluator is the
// single source of truth; this page only merges two already-computed
// result sets and renders them.
export default async function CardsPage() {
  const supabase = await createClient();
  const [cards, methods] = await Promise.all([getCardDashboardStatus(supabase), listPaymentMethods(supabase)]);

  const rulesMethodIds = new Set(cards.map((c) => c.method_id));
  const walletMethods = methods.filter((m) => !m.has_rules && m.active && !rulesMethodIds.has(m.id));

  const walletSpend =
    walletMethods.length > 0 ? await getPaymentMethodSplit(supabase, currentCalendarMonth()) : [];
  const spendByMethod = new Map(walletSpend.map((s) => [s.method_id, s.total]));

  const isEmpty = cards.length === 0 && walletMethods.length === 0;

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

      {isEmpty ? (
        <div className="empty-state">
          <p>No payment methods configured.</p>
        </div>
      ) : (
        <div className="card-gauge-grid">
          {cards.map((card) => (
            <CardStatusPanel key={card.method_id} card={card} />
          ))}
          {walletMethods.map((method) => (
            <BudgetOnlyCard key={method.id} method={method} spend={spendByMethod.get(method.id) ?? 0} />
          ))}
        </div>
      )}
    </div>
  );
}
