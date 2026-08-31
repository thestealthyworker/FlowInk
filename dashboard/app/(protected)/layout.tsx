import type { ReactNode } from "react";
import { BottomTabBar } from "@/components/nav/BottomTabBar";
import { TopNav } from "@/components/nav/TopNav";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { signOut } from "@/lib/actions/auth";
import { countPendingRules } from "@/lib/data/methodRules";
import { listGuessedMerchantIds } from "@/lib/data/merchants";
import { createClient } from "@/lib/supabase/server";

// The app shell (redesign/visuals): a top header nav on tablet/desktop
// (replacing the old left rail), a bottom tab bar on mobile with its own
// "Add" tab — a shape change across the 768px breakpoint, not one
// reflowing nav component. The mobile FAB was removed: it visually
// collided with the new Add tab's upward-opening menu, and duplicated
// exactly one of that menu's three options (manual entry).
export default async function ProtectedLayout({ children }: { children: ReactNode }) {
  const supabase = await createClient();
  const [guessedIds, reviewBadge] = await Promise.all([
    listGuessedMerchantIds(supabase),
    countPendingRules(supabase),
  ]);

  return (
    <div className="shell">
      <header className="topbar">
        <span className="topbar__brand-group">
          <span className="topbar__brand">FlowInk</span>
          <span className="topbar__brand-sub">Personal Ledger</span>
        </span>
        <TopNav triageBadge={guessedIds.size} reviewBadge={reviewBadge} />
        <div className="topbar__actions">
          <ThemeToggle />
          <form action={signOut} className="topbar__signout">
            <button type="submit">Sign out</button>
          </form>
        </div>
      </header>

      <main className="shell__content">{children}</main>

      <BottomTabBar triageBadge={guessedIds.size} reviewBadge={reviewBadge} />
    </div>
  );
}
