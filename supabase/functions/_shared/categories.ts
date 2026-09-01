// The fixed category vocabulary from docs/architecture.md §4.
//
// Single source of truth for the 11-category vocabulary. Telegram-based
// merchant-triage and its telegram-webhook validator were removed
// 2026-08-25 (operator decision, see docs/architecture.md §2) — merchant
// triage moves to the web dashboard (Phase 5, not yet built), which will
// import CATEGORIES
// the same way those two functions did: to render the category picker and
// to validate writes against it server-side rather than trusting whatever
// a client sends. Ingest also imports it (isCategory-style validation
// belongs wherever a category string reaches the database).
//
// `commute` = Grab and taxis. `transport` = MRT and bus via SimplyGo.
// They earn differently and must stay separate.
export const CATEGORIES = [
  "groceries",
  "dining",
  "petrol",
  "commute",
  "transport",
  "bills",
  "online",
  "retail",
  "healthcare",
  "household",
  "other",
] as const;

export type Category = typeof CATEGORIES[number];

export function isCategory(value: unknown): value is Category {
  return typeof value === "string" && (CATEGORIES as readonly string[]).includes(value);
}
