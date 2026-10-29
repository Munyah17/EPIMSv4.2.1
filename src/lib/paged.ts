/**
 * PostgREST (Supabase) caps any single response at ~1,000 rows
 * (max-rows). A bare .select() — and even .limit(5000) — therefore
 * silently truncates bigger tables: the invisible "999" ceiling that
 * showed up on list pages and in computed counts.
 *
 * fetchAllRows() pages through .range() until a short page ends the
 * scan, so callers get the real, complete set instead of the first
 * slice.
 *
 * `build` must mint a FRESH query builder each call (supabase-js
 * builders are one-shot). Pagination is only stable over a
 * deterministic ORDER BY, so pass `orderBy` — it is appended as the
 * final sort key, a no-op tiebreaker on queries that already sort.
 */
export const PAGE_SIZE = 1000

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchAllRows<T = any>(
  build: () => any,
  opts: { maxRows?: number; orderBy?: string } = {},
): Promise<{ data: T[] | null; error: any }> {
  const maxRows = opts.maxRows ?? Infinity
  const all: T[] = []
  for (let from = 0; all.length < maxRows; from += PAGE_SIZE) {
    const to = Math.min(from + PAGE_SIZE, maxRows) - 1
    let q = build()
    if (opts.orderBy) q = q.order(opts.orderBy)
    const { data, error } = await q.range(from, to)
    if (error) return { data: null, error }
    const rows = (data ?? []) as T[]
    all.push(...rows)
    if (rows.length < to - from + 1) break
  }
  return { data: all, error: null }
}
