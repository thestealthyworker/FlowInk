"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Mobile shape (redesign/visuals): matches the top nav's 3 in-page anchor
// destinations on the single Command Center page — Command Center,
// Trends, Ledger — plus its own "Add" disclosure (budgets/manual entry/
// triage), since the top bar's nav (including its Add dropdown) is hidden
// on mobile to avoid duplicating this bar. Cards is reachable from the
// Command Center's card-strip section, not a tab.
const TABS = [
  { href: "/", label: "This month" },
  { href: "/#trends", label: "Trends" },
  { href: "/#ledger", label: "Ledger" },
] as const;

const ADD_GROUP = [
  { href: "/budgets", label: "Budgets" },
  { href: "/transactions/new", label: "Add manual entry" },
  { href: "/triage", label: "Merchant triage" },
  { href: "/config", label: "Cards & rules" },
] as const;

export function BottomTabBar({ triageBadge, reviewBadge }: { triageBadge: number; reviewBadge: number }) {
  const pathname = usePathname();

  return (
    <nav className="bottom-tabs" aria-label="Main navigation">
      {TABS.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          className="bottom-tabs__item"
          aria-current={pathname === "/" && tab.href === "/" ? "page" : undefined}
        >
          {tab.label}
        </Link>
      ))}

      <details className="bottom-tabs__add">
        <summary className="bottom-tabs__item">
          Add
          {triageBadge + reviewBadge > 0 && (
            <span
              className="bottom-tabs__badge"
              aria-label={`${triageBadge} merchants awaiting triage, ${reviewBadge} rules awaiting review`}
            >
              {triageBadge + reviewBadge}
            </span>
          )}
        </summary>
        <div className="bottom-tabs__add-menu">
          {ADD_GROUP.map((item) => (
            <Link key={item.href} href={item.href} className="bottom-tabs__add-link">
              {item.label}
              {item.href === "/triage" && triageBadge > 0 && (
                <span className="bottom-tabs__badge" aria-label={`${triageBadge} awaiting`}>
                  {triageBadge}
                </span>
              )}
              {item.href === "/config" && reviewBadge > 0 && (
                <span className="bottom-tabs__badge" aria-label={`${reviewBadge} rules awaiting review`}>
                  {reviewBadge}
                </span>
              )}
            </Link>
          ))}
        </div>
      </details>
    </nav>
  );
}
