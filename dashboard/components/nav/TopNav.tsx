"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Top header nav (redesign/visuals) — replaces the old left SideRail on
// every breakpoint above mobile; BottomTabBar still owns mobile nav.
// Matches the "Ledger & Ink" artifact exactly: ONE page with three anchor-
// linked sections (Command Center / Trends / Ledger, operator: "can the
// command center/trends/Ledger be in the same page as per the artifact"),
// not three separate routes. Cards is reachable from the Command Center's
// card-strip section instead of a top-level tab. The three write/entry
// features (budgets, manual entry, triage) are real separate pages,
// collapsed into one "Add" disclosure so they don't crowd the bar — a
// native <details>, no client state needed for the dropdown itself.
const PRIMARY = [
  { href: "/", label: "Command Center" },
  { href: "/#trends", label: "Trends" },
  { href: "/#ledger", label: "Ledger" },
] as const;

const ADD_GROUP = [
  { href: "/budgets", label: "Budgets" },
  { href: "/transactions/new", label: "Add manual entry" },
  { href: "/triage", label: "Merchant triage" },
  { href: "/config", label: "Cards & rules" },
] as const;

export function TopNav({ triageBadge, reviewBadge }: { triageBadge: number; reviewBadge: number }) {
  const pathname = usePathname();

  return (
    <nav className="topbar__nav" aria-label="Main navigation">
      {PRIMARY.map((item) => (
        // aria-current only for the exact "/" link (Command Center) —
        // pathname never carries a #hash, so the Trends/Ledger anchors
        // can't be marked current without client-side scrollspy, which is
        // out of scope here.
        <Link key={item.href} href={item.href} className="topbar__nav-link" aria-current={pathname === "/" && item.href === "/" ? "page" : undefined}>
          {item.label}
        </Link>
      ))}

      <details className="topbar__add">
        <summary>
          Add
          {triageBadge + reviewBadge > 0 && (
            <span
              className="topbar__add-badge"
              aria-label={`${triageBadge} merchants awaiting triage, ${reviewBadge} rules awaiting review`}
            >
              {triageBadge + reviewBadge}
            </span>
          )}
        </summary>
        <div className="topbar__add-menu">
          {ADD_GROUP.map((item) => (
            <Link key={item.href} href={item.href} className="topbar__add-link" aria-current={pathname === item.href ? "page" : undefined}>
              {item.label}
              {item.href === "/triage" && triageBadge > 0 && (
                <span className="topbar__add-badge" aria-label={`${triageBadge} awaiting`}>
                  {triageBadge}
                </span>
              )}
              {item.href === "/config" && reviewBadge > 0 && (
                <span className="topbar__add-badge" aria-label={`${reviewBadge} rules awaiting review`}>
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
