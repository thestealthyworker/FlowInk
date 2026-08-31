import type { DailySpend } from "../data/dailySpend";

/** Zero-fills every date in [dateFrom, dateTo] so the heatmap always
 * renders a full, evenly-spaced grid rather than compressing around
 * whatever days happened to have spend. */
export function fillDailySeries(rows: DailySpend[], dateFrom: string, dateTo: string): DailySpend[] {
  const totalsByDay = new Map(rows.map((r) => [r.txn_date, r.total]));
  const result: DailySpend[] = [];

  const cursor = new Date(`${dateFrom}T00:00:00`);
  const end = new Date(`${dateTo}T00:00:00`);
  while (cursor <= end) {
    const key = cursor.toISOString().slice(0, 10);
    result.push({ txn_date: key, total: totalsByDay.get(key) ?? 0 });
    cursor.setDate(cursor.getDate() + 1);
  }

  return result;
}
