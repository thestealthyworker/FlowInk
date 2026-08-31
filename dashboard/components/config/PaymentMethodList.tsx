import { editRuleAction, toggleCardActiveAction } from "@/lib/actions/config";
import { describeRuleClaim } from "@/lib/derive/ruleCopy";
import type { MethodRule, PaymentMethod } from "@/lib/supabase/types";
import { RuleEditFields } from "./RuleEditFields";

// Scope items 1 ("list payment methods... issuer, last4, currency, active
// state, and whether it has rules") and 4 ("activate/deactivate a card")
// and, for an already-active rule, scope item 3 ("edit a rule"). No
// method_id branching anywhere below — every field rendered comes off
// the payment_methods/method_rules rows themselves.
export function PaymentMethodList({
  methods,
  rulesByMethod,
}: {
  methods: PaymentMethod[];
  rulesByMethod: Map<string, MethodRule[]>;
}) {
  if (methods.length === 0) {
    return (
      <div className="empty-state">
        <p>No payment methods configured yet. Load the example data below to see how this works, or add your own.</p>
      </div>
    );
  }

  return (
    <ul className="method-list">
      {methods.map((method) => {
        const activeRules = (rulesByMethod.get(method.id) ?? []).filter((r) => r.status === "active");
        const last4 = method.last4 ? `•••• ${method.last4}` : "no card number on file";

        return (
          <li key={method.id} className="method-card">
            <div className="method-card__head">
              <div>
                <h3>{method.display_name}</h3>
                <p className="method-card__meta">
                  {method.issuer} · {last4} · {method.currency}
                  {!method.has_rules && " · budget tracking only, no reward rules"}
                </p>
              </div>
              <span className={`method-card__badge ${method.active ? "method-card__badge--active" : ""}`}>
                {method.active ? "Active" : "Inactive"}
              </span>
            </div>

            <form action={toggleCardActiveAction} className="method-card__toggle">
              <input type="hidden" name="method_id" value={method.id} />
              <input type="hidden" name="next_active" value={(!method.active).toString()} />
              <button type="submit">{method.active ? "Deactivate" : "Activate"} this card</button>
            </form>

            {method.has_rules && (
              <details className="method-card__rules">
                <summary>
                  {activeRules.length} active rule{activeRules.length === 1 ? "" : "s"}
                </summary>
                {activeRules.length === 0 ? (
                  <p className="form-hint">No rules configured for this card yet.</p>
                ) : (
                  <ul className="method-card__rule-list">
                    {activeRules.map((rule) => (
                      <li key={rule.id} className="method-card__rule">
                        <p>{describeRuleClaim(rule, method)}</p>
                        <details>
                          <summary>Edit</summary>
                          <form action={editRuleAction} className="entry-form">
                            <RuleEditFields rule={rule} idPrefix={`method-${rule.id}`} />
                            <button type="submit" className="entry-form__submit">
                              Save
                            </button>
                          </form>
                        </details>
                      </li>
                    ))}
                  </ul>
                )}
              </details>
            )}
          </li>
        );
      })}
    </ul>
  );
}
