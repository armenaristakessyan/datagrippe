// View state of the rows results shown in the results panel, shared by the grid and the header
// actions: the client-side sort, a lost cursor, and the "Load all" loop. Keyed per result of one
// execution, so a new run starts clean.
import { create } from 'zustand'
import type { CellValue, DbErrorInfo, SortSpec, StatementResult } from '@shared/types'
import type { PendingChanges } from '@/components/table/pending-changes'
import { useConsoles } from '@/stores/consoles'

export interface ResultViewState {
  sort: SortSpec[]
  /** Fetching more rows failed: the cursor is gone (closed by Explain, a commit…) or the session is. */
  fetchError?: DbErrorInfo
  /** "Load all" is running. */
  loadingAll?: boolean
  /** Asked to stop the "Load all" loop. */
  stopRequested?: boolean
  /** In-place editing: edits not submitted yet (see result-editing). */
  changes?: PendingChanges
  submitting?: boolean
  submitError?: DbErrorInfo
  /** Submitted values by row key (primary-key values as fetched) → column → value. */
  applied?: Record<string, Record<string, CellValue>>
  /** Row keys of submitted deletes. */
  removed?: string[]
}

const EMPTY: ResultViewState = { sort: [] }

interface ResultViewsStore {
  views: Record<string, ResultViewState>
  patch: (key: string, patch: Partial<ResultViewState>) => void
}

export const useResultViews = create<ResultViewsStore>((set) => ({
  views: {},
  patch: (key, patch) => set((s) => ({ views: { ...s.views, [key]: { ...(s.views[key] ?? EMPTY), ...patch } } })),
}))

export function resultViewKey(tabId: string, executionId: string | undefined, index: number): string {
  return `${tabId}\u0000${executionId ?? ''}\u0000${index}`
}

export function useResultView(key: string): ResultViewState {
  return useResultViews((s) => s.views[key]) ?? EMPTY
}

/** Forget the view state of the tab's older executions (called when a new execution is shown). */
export function pruneResultViews(tabId: string, executionId: string | undefined): void {
  const views = useResultViews.getState().views
  const prefix = `${tabId}\u0000`
  const keep = `${tabId}\u0000${executionId ?? ''}\u0000`
  const stale = Object.keys(views).filter((k) => k.startsWith(prefix) && !k.startsWith(keep))
  if (stale.length === 0) return
  const next = { ...views }
  for (const k of stale) delete next[k]
  useResultViews.setState({ views: next })
}

/** Rows can still be fetched for this result (and no earlier attempt failed). */
export function canFetchMore(result: Pick<StatementResult, 'hasMore' | 'cursorId'>, view: ResultViewState): boolean {
  return result.hasMore && !!result.cursorId && !view.fetchError
}

/**
 * Fetch the next page of a result. A failure is remembered on the result's view state, so neither
 * infinite scroll nor the header keep offering (and retrying) a fetch that cannot succeed.
 * Resolves to true when rows were added.
 */
export async function fetchMoreRows(tabId: string, index: number, key: string): Promise<boolean> {
  const store = useConsoles.getState()
  const before = store.runtime(tabId)
  const result = before.execution?.results[index]
  if (!result || !canFetchMore(result, useResultViews.getState().views[key] ?? EMPTY)) return false
  const count = result.rows.length
  await store.fetchMore(tabId, index)
  const after = useConsoles.getState().runtime(tabId)
  const now = after.execution?.results[index]
  if (!now || after.execution?.executionId !== before.execution?.executionId) return false
  if (now.rows.length > count) return true
  if (after.error && after.error !== before.error && result.hasMore) useResultViews.getState().patch(key, { fetchError: after.error })
  return false
}

/** Rows "Load all" fetches at most, whatever the result size (memory of the renderer). */
export const LOAD_ALL_MAX_ROWS = 200_000
/** …and at most this many cells (rows × columns). */
export const LOAD_ALL_MAX_CELLS = 5_000_000

export function loadAllLimit(columnCount: number): number {
  return Math.max(1, Math.min(LOAD_ALL_MAX_ROWS, Math.floor(LOAD_ALL_MAX_CELLS / Math.max(1, columnCount))))
}

/** Fetch pages until the result is complete, the limit is reached, a fetch fails or the user stops. */
export async function loadAllRows(tabId: string, index: number, key: string): Promise<void> {
  const views = useResultViews.getState()
  if (views.views[key]?.loadingAll) return
  views.patch(key, { loadingAll: true, stopRequested: false })
  try {
    for (;;) {
      const result = useConsoles.getState().runtime(tabId).execution?.results[index]
      const view = useResultViews.getState().views[key] ?? EMPTY
      if (!result || !canFetchMore(result, view) || view.stopRequested) break
      if (result.rows.length >= loadAllLimit(result.columns.length)) break
      // the store ignores a fetch while another one runs: wait for it
      if (useConsoles.getState().runtime(tabId).loadingMore) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        continue
      }
      if (!(await fetchMoreRows(tabId, index, key))) break
    }
  } finally {
    useResultViews.getState().patch(key, { loadingAll: false, stopRequested: false })
  }
}

export function stopLoadAll(key: string): void {
  useResultViews.getState().patch(key, { stopRequested: true })
}

/** Forget one view state (an unpinned result). */
export function dropResultView(key: string): void {
  const views = useResultViews.getState().views
  if (!(key in views)) return
  const next = { ...views }
  delete next[key]
  useResultViews.setState({ views: next })
}
