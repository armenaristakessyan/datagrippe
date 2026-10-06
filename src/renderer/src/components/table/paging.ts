// Row-window text of the pager (pure).
import { NNBSP, formatCount } from '@/lib/format'

export interface PageWindow {
  offset: number
  shown: number
  hasMore: boolean
  pageSize: number
  /** Exact total (counted, or known because this is the last page). */
  total?: number
  /** Planner estimate, only meaningful without a filter. */
  estimate?: number
}

/** "Rows 1–500", "Rows 1–500 of 12 345", "Rows 1–500 of ~12 345", "No rows". */
export function describeWindow(w: PageWindow): { range: string; total?: string } {
  if (w.shown === 0) return { range: w.offset === 0 ? 'No rows' : `No rows after ${formatCount(w.offset)}` }
  const range = `Rows ${formatCount(w.offset + 1)}–${formatCount(w.offset + w.shown)}`
  if (w.total !== undefined) return { range, total: `of${NNBSP}${formatCount(w.total)}` }
  if (w.estimate !== undefined && w.estimate > w.offset + w.shown) return { range, total: `of${NNBSP}~${formatCount(Math.round(w.estimate))}` }
  return { range }
}

/** Exact total when it can be derived without counting. */
export function knownTotal(offset: number, shown: number, hasMore: boolean, exactCount: number | undefined): number | undefined {
  if (exactCount !== undefined) return exactCount
  if (!hasMore && (shown > 0 || offset === 0)) return offset + shown
  return undefined
}
