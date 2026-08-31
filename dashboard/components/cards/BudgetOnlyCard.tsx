import { MoneyFigure } from "@/components/honest-data/MoneyFigure";
import type { PaymentMethod } from "@/lib/supabase/types";

// A has_rules = false, active = true method (PayLah today; any future
// debit card or wallet) — genuinely nothing to optimise, per
// card_dashboard_status()'s own comment (0007), but the operator should
// still see the system knows the method exists, not have it silently
// absent from the page. Plain display name, this-period spend, and a
// one-line note — deliberately not a gauge, since there is no threshold
// to gauge progress against.
export function BudgetOnlyCard({ method, spend }: { method: PaymentMethod; spend: number }) {
  return (
    <article
      className="card-gauge-card card-gauge-card--budget-only"
      aria-labelledby={`card-${method.id}-heading`}
    >
      <h3 id={`card-${method.id}-heading`}>{method.display_name}</h3>
      <p className="card-gauge__figures">
        <span className="money-figure card-gauge__headline">
          <MoneyFigure amount={spend} currency={method.currency} />
        </span>
        <span className="card-gauge__sub">this month</span>
      </p>
      <p className="card-gauge__meta">No reward rules configured for this method — budget tracking only.</p>
    </article>
  );
}
