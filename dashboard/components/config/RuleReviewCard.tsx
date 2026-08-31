import { approveRuleAction, editRuleAction, rejectRuleAction } from "@/lib/actions/config";
import { confidenceLabel, describeRuleClaim, formatCategories, formatPeriod } from "@/lib/derive/ruleCopy";
import type { MethodRule, PaymentMethod, RulePreview } from "@/lib/supabase/types";
import { ConfirmSubmitButton } from "@/components/ui/ConfirmSubmitButton";
import { RuleEditFields } from "./RuleEditFields";
import { RulePreviewDiff } from "./RulePreviewDiff";

// One proposed rule, in full: what it claims (plain sentence, not JSON),
// where it says it came from, its computed real-period effect, a way to
// correct it before deciding, and the decision itself. This card is the
// entire point of WP5 — a five-stage AI validator gating a rule behind
// pending_review (WP7) means nothing if this is a JSON blob and a button.
export function RuleReviewCard({
  rule,
  card,
  preview,
}: {
  rule: MethodRule;
  card: PaymentMethod;
  preview: RulePreview | null;
}) {
  const claim = describeRuleClaim(rule, card);
  const citations = rule.source_citations ?? [];

  return (
    <li className="review-card" id={`rule-${rule.id}`} aria-labelledby={`rule-${rule.id}-heading`}>
      <div className="review-card__head">
        <p className="review-card__eyebrow">
          {card.display_name} · {rule.rule_type.replace(/_/g, " ")} · applies to {formatCategories(rule.categories)}
        </p>
        <h3 id={`rule-${rule.id}-heading`} className="review-card__claim">
          {claim}
        </h3>
        <p className="review-card__period">{formatPeriod(rule.valid_from, rule.valid_to)}</p>
      </div>

      <div className="review-card__provenance">
        <p className="review-card__provenance-label">
          Proposed by {rule.proposed_by === "ai" ? "the AI research pass" : "the operator"}
          {rule.proposed_by === "ai" && <> — confidence: {confidenceLabel(rule.ai_confidence)}</>}
        </p>
        {rule.ai_rationale && <p className="review-card__rationale">&ldquo;{rule.ai_rationale}&rdquo;</p>}
        {rule.proposed_by === "ai" && citations.length === 0 && (
          <p className="review-card__no-source">No source cited for this rule — verify it directly before approving.</p>
        )}
        {citations.length > 0 && (
          <ul className="review-card__citations">
            {citations.map((c, i) => (
              <li key={i}>
                {c.url ? (
                  <a href={c.url} target="_blank" rel="noreferrer">
                    {c.title ?? c.url}
                  </a>
                ) : (
                  <span>{c.title ?? "Untitled source"}</span>
                )}
                {c.quote && <span className="review-card__quote"> — &ldquo;{c.quote}&rdquo;</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {preview && <RulePreviewDiff preview={preview} currency={card.currency} />}

      <details className="review-card__edit">
        <summary>Correct a number before deciding</summary>
        <form action={editRuleAction} className="entry-form">
          <RuleEditFields rule={rule} idPrefix={`edit-${rule.id}`} />
          <button type="submit" className="entry-form__submit">
            Save correction
          </button>
        </form>
      </details>

      <div className="review-card__decision">
        <form action={approveRuleAction} className="review-card__decision-form">
          <input type="hidden" name="rule_id" value={rule.id} />
          <label htmlFor={`approve-note-${rule.id}`} className="form-hint">
            Note (optional)
          </label>
          <input id={`approve-note-${rule.id}`} name="review_note" type="text" placeholder="Matches T&C clause…" />
          <button type="submit" className="review-card__approve">
            Approve — make this rule live
          </button>
        </form>

        <form action={rejectRuleAction} className="review-card__decision-form">
          <input type="hidden" name="rule_id" value={rule.id} />
          <label htmlFor={`reject-note-${rule.id}`} className="form-hint">
            Reason (optional — a generic one is recorded if left blank)
          </label>
          <input id={`reject-note-${rule.id}`} name="review_note" type="text" placeholder="Could not find this in the T&C…" />
          <ConfirmSubmitButton label="Reject" confirmLabel="Confirm reject" />
        </form>
      </div>
    </li>
  );
}
