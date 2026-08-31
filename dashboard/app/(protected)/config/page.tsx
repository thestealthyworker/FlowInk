import { ExampleDataControls } from "@/components/config/ExampleDataControls";
import { PaymentMethodList } from "@/components/config/PaymentMethodList";
import { ReviewQueue } from "@/components/config/ReviewQueue";
import { listMethodRules, previewMethodRule } from "@/lib/data/methodRules";
import { listPaymentMethods } from "@/lib/data/methods";
import { createClient } from "@/lib/supabase/server";
import type { MethodRule, RulePreview } from "@/lib/supabase/types";

// WP5: the config review and edit surface. Deliberately NOT a wizard —
// one page, three plain sections (review queue first, since that is
// where an unreviewed AI proposal actually poses risk; card list;
// example-data controls) — see this migration package's own task brief
// for why a five-step onboarding flow was cut down to this.
export default async function ConfigPage() {
  const supabase = await createClient();
  const [methods, allRules] = await Promise.all([listPaymentMethods(supabase), listMethodRules(supabase)]);

  const methodsById = new Map(methods.map((m) => [m.id, m]));
  const rulesByMethod = new Map<string, MethodRule[]>();
  for (const rule of allRules) {
    const list = rulesByMethod.get(rule.method_id) ?? [];
    list.push(rule);
    rulesByMethod.set(rule.method_id, list);
  }

  const pendingRules = allRules.filter((r) => r.status === "pending_review");

  // One preview per pending rule, computed server-side against each
  // card's real current period — see preview_method_rule() (0018) and
  // RulePreviewDiff.tsx for what this buys the reviewer. Fetched in
  // parallel; a single failed preview (e.g. an unresolvable period for a
  // not-yet-active card) degrades to "no live preview" for that one card
  // rather than failing the whole queue — see RulePreviewDiff's own
  // `error`/`active === false` branches.
  const previewEntries = await Promise.all(
    pendingRules.map(async (rule): Promise<[number, RulePreview | null]> => {
      try {
        return [rule.id, await previewMethodRule(supabase, rule.id)];
      } catch {
        return [rule.id, null];
      }
    })
  );
  const previewsById = new Map(previewEntries);

  const exampleLoaded = methods.some((m) => m.is_example);

  return (
    <div className="config-page">
      <header className="page-header">
        <p className="page-header__eyebrow">Config</p>
        <h1>Cards &amp; rules</h1>
        <p>
          Manage your payment methods and their reward rules, and decide on anything an AI research pass proposed
          before it can affect a total.
        </p>
      </header>

      <section aria-labelledby="review-heading" className="page-section">
        <h2 id="review-heading">
          Awaiting review{pendingRules.length > 0 ? ` (${pendingRules.length})` : ""}
        </h2>
        <p>
          A proposed rule sits here, fully validated but inert, until you approve or reject it — it cannot affect any
          reward total while it waits.
        </p>
        <ReviewQueue rules={pendingRules} methodsById={methodsById} previewsById={previewsById} />
      </section>

      <section aria-labelledby="methods-heading" className="page-section">
        <h2 id="methods-heading">Payment methods</h2>
        <PaymentMethodList methods={methods} rulesByMethod={rulesByMethod} />
      </section>

      <section aria-labelledby="example-heading" className="page-section">
        <h2 id="example-heading">Example data</h2>
        <ExampleDataControls exampleLoaded={exampleLoaded} />
      </section>
    </div>
  );
}
