import Link from "next/link";
import type { Category } from "@/lib/supabase/types";

// Guessed-category state (§4): a dotted underline on the category label
// itself, everywhere it renders — 250 of 251 merchants sit at
// confidence='guessed' today, so this is the majority-case rendering to
// design for, not a rare edge case. Links straight into /triage.
export function GuessedCategoryLabel({
  category,
  isGuessed,
  merchantFilter,
}: {
  category: Category | "uncategorised";
  isGuessed: boolean;
  merchantFilter?: string;
}) {
  if (!isGuessed) return <span>{category}</span>;

  const href = merchantFilter ? `/triage?merchant=${encodeURIComponent(merchantFilter)}` : "/triage";

  return (
    <Link href={href} className="guessed-label" title="Category guessed — confirm in triage">
      {category}
      <span className="visually-hidden"> (category guessed, unconfirmed — open triage)</span>
    </Link>
  );
}
