import Link from "next/link";
import type { CSSProperties } from "react";
import { formatMoney } from "@/components/honest-data/MoneyFigure";
import type { MerchantLeaderboardRow } from "@/lib/data/spend";

// §3 View 3: horizontal bars, a single neutral hue — this is a nominal
// ranking of one series ("spend by merchant"), not an identity
// comparison, so per the dataviz colour formula's categorical/ordinal
// distinction it takes one slot, not eight. The dotted "?" badge links
// straight into /triage filtered to that merchant, per the mark spec.
export function MerchantLeaderboard({
  rows,
  guessedMerchantIds,
}: {
  rows: MerchantLeaderboardRow[];
  guessedMerchantIds: Set<number>;
}) {
  if (rows.length === 0) {
    return (
      <div className="empty-state">
        <p>No merchant spend in this period.</p>
      </div>
    );
  }

  const max = Math.max(...rows.map((r) => r.total), 1);

  return (
    <ol className="leaderboard">
      {rows.map((row, index) => {
        const isGuessed = row.merchant_id !== null && guessedMerchantIds.has(row.merchant_id);
        return (
          <li key={row.merchant_id ?? `raw:${row.merchant_raw_sample}`} className="leaderboard__row" style={{ "--bar-index": index } as CSSProperties}>
            <span className="leaderboard__rank">{index + 1}</span>
            <span className="leaderboard__name">
              {row.merchant_raw_sample}
              {isGuessed && (
                <Link
                  href={`/triage?merchant=${encodeURIComponent(row.merchant_raw_sample)}`}
                  className="leaderboard__guessed-badge"
                  title="Category guessed — confirm in triage"
                  aria-label={`${row.merchant_raw_sample} category is guessed — confirm in triage`}
                >
                  ?
                </Link>
              )}
            </span>
            <span className="leaderboard__track">
              <span className="leaderboard__fill" style={{ "--pct": row.total / max } as CSSProperties} />
            </span>
            <span className="leaderboard__figures">
              <span className="money-figure">{formatMoney(row.total)}</span>
              <span className="leaderboard__count">{row.count} txn{row.count === 1 ? "" : "s"}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
