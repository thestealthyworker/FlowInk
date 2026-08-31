import Link from "next/link";
import type { CardWatch } from "@/lib/derive/cardStatus";

// The home view's single card-related KPI (operator: "this doesn't show
// any info on my credit card metrics — i believe that will be under the
// Cards section?"). Deliberately NOT a fourth tile in the KPI grid: the
// plan's own priority order (docs/DASHBOARD_PLAN.md §1, §2) puts budgets
// and spend ahead of card optimisation, and a full gauge belongs to the
// dedicated /cards view (Phase D4, not yet built). This is a single
// slim line — visually one notch below the KPI cards, not competing with
// them — carrying the one card fact that could change a decision made
// today, with a jump link down to the full per-card strip that already
// exists further down the page.
export function CardWatchLine({ watch }: { watch: CardWatch | null }) {
  if (!watch) return null;

  return (
    <p className="card-watch">
      <span className="card-watch__tag">Card to watch</span>
      <Link href="#card-strip-heading" className="card-watch__link">
        <strong>{watch.displayName}</strong> — {watch.summary.headline}
      </Link>
    </p>
  );
}
