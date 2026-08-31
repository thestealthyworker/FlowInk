import Link from "next/link";
import type { CategoryBarRow } from "@/lib/derive/budgetSummary";
import { CategoryBar } from "./CategoryBar";

export function CategoryBarList({
  rows,
  unbudgetedCount,
}: {
  rows: CategoryBarRow[];
  unbudgetedCount: number;
}) {
  return (
    <section aria-labelledby="category-bars-heading">
      <div className="category-bars__heading">
        <h2 id="category-bars-heading">Category caps</h2>
      </div>

      {rows.length > 0 ? (
        <ul className="bar-list">
          {rows.map((row, index) => (
            <CategoryBar key={row.category} row={row} index={index} />
          ))}
        </ul>
      ) : (
        <p>No category has a budget cap set for this period yet.</p>
      )}

      {unbudgetedCount > 0 && (
        <p className="unbudgeted-note">
          {unbudgetedCount} more {unbudgetedCount === 1 ? "category has" : "categories have"} spend this month but no
          cap set. <Link href="/budgets">Add one in Budgets →</Link>
        </p>
      )}
    </section>
  );
}
