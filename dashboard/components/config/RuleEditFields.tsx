import { CATEGORIES, type MethodRule } from "@/lib/supabase/types";

// Shared editable-fields block for a method_rules row — used identically
// by the review queue's "correct before approving" form and the payment
// method rule editor (scope item 3, "edit a rule"). One markup, one set
// of field names, so both forms post through the exact same
// editRuleAction -> edit_method_rule() RPC -> method_rules_validate()
// trigger path (0018) — there is no second, parallel edit implementation
// to keep in sync with this one.
//
// Only the fields a reviewer/operator plausibly corrects are exposed:
// rate, threshold, cap_amount, payout, txn_min, categories, notes,
// valid_to. method_id/rule_type/priority/valid_from/cap_basis/
// reward_form/gate_scope are structural — changing them reshapes what
// the rule IS, not a correction to a number, and stay out of this form
// (an operator who needs that reaches for a fresh proposal instead).
export function RuleEditFields({ rule, idPrefix }: { rule: MethodRule; idPrefix: string }) {
  return (
    <>
      <input type="hidden" name="rule_id" value={rule.id} />

      {(rule.rule_type === "category_rate" || rule.rule_type === "tier") && (
        <>
          <label htmlFor={`${idPrefix}-rate`}>Rate {rule.rule_type === "tier" ? "(only if this tier pays a rate, not a flat amount)" : ""}</label>
          <input
            id={`${idPrefix}-rate`}
            name="rate"
            type="number"
            step="0.0001"
            min="0"
            defaultValue={rule.rate ?? ""}
          />
        </>
      )}

      {rule.rule_type !== "cap" && (
        <>
          <label htmlFor={`${idPrefix}-threshold`}>Threshold (spend needed to unlock this rule, if any)</label>
          <input
            id={`${idPrefix}-threshold`}
            name="threshold"
            type="number"
            step="0.01"
            min="0"
            defaultValue={rule.threshold ?? ""}
          />
        </>
      )}

      {rule.rule_type === "cap" && (
        <>
          <label htmlFor={`${idPrefix}-cap_amount`}>Cap amount</label>
          <input
            id={`${idPrefix}-cap_amount`}
            name="cap_amount"
            type="number"
            step="0.01"
            min="0"
            defaultValue={rule.cap_amount ?? ""}
            required
          />
        </>
      )}

      {rule.rule_type === "tier" && (
        <>
          <label htmlFor={`${idPrefix}-payout`}>Flat payout</label>
          <input
            id={`${idPrefix}-payout`}
            name="payout"
            type="number"
            step="0.01"
            min="0"
            defaultValue={rule.payout ?? ""}
          />
        </>
      )}

      {(rule.rule_type === "txn_count" || rule.rule_type === "tier") && (
        <>
          <label htmlFor={`${idPrefix}-txn_min`}>Minimum transactions</label>
          <input id={`${idPrefix}-txn_min`} name="txn_min" type="number" step="1" min="0" defaultValue={rule.txn_min ?? ""} />
        </>
      )}

      {(rule.rule_type === "category_rate") && (
        <fieldset className="rule-edit__categories">
          <legend>Categories (leave all unchecked to mean &ldquo;everything&rdquo;)</legend>
          {CATEGORIES.map((c) => (
            <label key={c} className="entry-form__checkbox">
              <input type="checkbox" name="categories" value={c} defaultChecked={(rule.categories ?? []).includes(c)} />
              {c}
            </label>
          ))}
        </fieldset>
      )}

      <label htmlFor={`${idPrefix}-notes`}>Notes</label>
      <textarea id={`${idPrefix}-notes`} name="notes" rows={2} defaultValue={rule.notes ?? ""} />

      <label htmlFor={`${idPrefix}-valid_to`}>Ends on (leave blank if still current)</label>
      <input id={`${idPrefix}-valid_to`} name="valid_to" type="date" defaultValue={rule.valid_to ?? ""} />
    </>
  );
}
