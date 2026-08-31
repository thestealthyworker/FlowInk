import type { MethodRule, PaymentMethod, RulePreview } from "@/lib/supabase/types";
import { RuleReviewCard } from "./RuleReviewCard";

// The centrepiece WP5 exists to build: every method_rules row sitting at
// status = 'pending_review' — invisible to evaluate_period() (0018) until
// an operator decides — rendered so the decision means something. An
// empty queue is the calm, expected state (honest-data convention: no
// proposals waiting is not an error, and this reads the same as
// triage's own "nothing awaiting triage" empty-state--good block), never
// left silently blank.
export function ReviewQueue({
  rules,
  methodsById,
  previewsById,
}: {
  rules: MethodRule[];
  methodsById: Map<string, PaymentMethod>;
  previewsById: Map<number, RulePreview | null>;
}) {
  if (rules.length === 0) {
    return (
      <div className="empty-state empty-state--good">
        <span className="empty-state__glyph" aria-hidden="true">
          ✓
        </span>
        <p>
          Nothing waiting for review. When an AI research pass proposes a card rule it could not fully verify, it
          will appear here before it can affect any total.
        </p>
      </div>
    );
  }

  return (
    <ul className="review-queue">
      {rules.map((rule) => {
        const card = methodsById.get(rule.method_id);
        if (!card) return null; // defensive: FK guarantees this in practice
        return (
          <RuleReviewCard key={rule.id} rule={rule} card={card} preview={previewsById.get(rule.id) ?? null} />
        );
      })}
    </ul>
  );
}
