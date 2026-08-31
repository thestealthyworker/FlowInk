/**
 * Maps `items` through `fn` with a bounded number of in-flight calls,
 * preserving input order in the result.
 *
 * Edge Functions get 400s of wall clock but only 2s of CPU (async I/O
 * excluded), so independent network calls should overlap — awaiting 30
 * Gmail fetches in sequence wastes most of the wall-clock budget on
 * round trips. The bound keeps us from opening 30 sockets at once and
 * tripping Gmail's per-user rate limit.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  };

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  await Promise.all(workers);
  return results;
}
