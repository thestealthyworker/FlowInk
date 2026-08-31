import { clearExampleDataAction, loadExampleDataAction } from "@/lib/actions/config";
import { ConfirmSubmitButton } from "@/components/ui/ConfirmSubmitButton";

// Scope item 5. A fresh deployment's payment_methods table is genuinely
// empty (0018_config_review.sql split the Singapore example set out of
// 0002_seed.sql) — that emptiness is the chosen product behaviour, not a
// bug, so this reads as a calm invitation, not an error state. exampleLoaded
// distinguishes the two directions: nothing to load twice, and nothing to
// clear that was never loaded.
export function ExampleDataControls({ exampleLoaded }: { exampleLoaded: boolean }) {
  return (
    <div className="example-data-controls">
      {exampleLoaded ? (
        <>
          <p>
            The Singapore worked example (UOB One, HSBC Revolution, Citi Cash Back) is loaded. Clearing removes only
            those cards, their rules, and their two example merchants — nothing you have added or edited yourself
            under a different id.
          </p>
          <form action={clearExampleDataAction}>
            <ConfirmSubmitButton label="Clear example data" confirmLabel="Confirm clear" />
          </form>
        </>
      ) : (
        <>
          <p>
            No cards configured yet — that&rsquo;s expected on a fresh deployment, not an error. Load a worked example
            (three real Singapore cards with real published rates) to see how the review queue, rule editor and card
            list behave before configuring your own cards.
          </p>
          <form action={loadExampleDataAction}>
            <button type="submit">Load the Singapore example</button>
          </form>
        </>
      )}
    </div>
  );
}
