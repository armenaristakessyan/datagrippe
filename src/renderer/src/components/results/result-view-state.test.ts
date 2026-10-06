import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionResult, StatementResult } from '@shared/types'

const fetchMore = vi.fn()

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    info: { message: string; kind?: string }
    constructor(info: { message: string; kind?: string }) {
      super(info.message)
      this.info = info
    }
  }
  return {
    ApiError,
    api: { session: { fetchMore }, meta: {}, workspace: { save: vi.fn(async () => undefined), load: vi.fn() } },
    errorInfo: (e: unknown) => (e instanceof ApiError ? e.info : { message: e instanceof Error ? e.message : String(e), kind: 'internal' }),
    errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
    onEvent: () => () => undefined,
  }
})

const { ApiError } = await import('@/lib/api')
const { useConsoles } = await import('@/stores/consoles')
const { useTabs } = await import('@/stores/tabs')
const { canFetchMore, fetchMoreRows, loadAllLimit, loadAllRows, resultViewKey, useResultViews } = await import('./result-view-state')

function rowsResult(n: number, hasMore = true): StatementResult {
  return {
    index: 0,
    sql: 'select g from generate_series(1, 5000) g',
    offset: 0,
    kind: 'rows',
    columns: [{ name: 'g', dataType: 'int4', nullable: true }],
    rows: Array.from({ length: n }, (_, i) => [i + 1]),
    rowCount: n,
    hasMore,
    cursorId: 'cur',
    durationMs: 1,
  } as unknown as StatementResult
}

function setup(result: StatementResult) {
  // the store only updates runtimes of open console tabs
  useTabs.setState({ tabs: [{ id: 't', kind: 'console', title: 'Console', connectionId: 'c1', database: 'db', content: '' }] as never, activeTabId: 't' })
  const execution = { executionId: 'e1', sessionId: 's1', results: [result], messages: [], durationMs: 1, cancelled: false } as unknown as ExecutionResult
  useConsoles.setState((s) => ({ runtimes: { ...s.runtimes, t: { ...s.runtime('t'), sessionId: 's1', execution, loadingMore: false, error: undefined } } }))
}

const key = resultViewKey('t', 'e1', 0)

describe('fetching more rows of a console result', () => {
  beforeEach(() => {
    fetchMore.mockReset()
    useResultViews.setState({ views: {} })
  })

  it('stops offering more rows once the cursor is gone (no retry loop)', async () => {
    setup(rowsResult(500))
    fetchMore.mockRejectedValue(new ApiError({ message: 'This result is no longer available', kind: 'not-found' }))
    expect(await fetchMoreRows('t', 0, key)).toBe(false)
    const view = useResultViews.getState().views[key]!
    expect(view.fetchError?.kind).toBe('not-found')
    const result = useConsoles.getState().runtime('t').execution!.results[0]!
    expect(canFetchMore(result, view)).toBe(false)
    // later attempts (infinite scroll, Load more, Load all) do not call main again
    expect(await fetchMoreRows('t', 0, key)).toBe(false)
    await loadAllRows('t', 0, key)
    expect(fetchMore).toHaveBeenCalledTimes(1)
  })

  it('appends pages until the result is complete', async () => {
    setup(rowsResult(500))
    let served = 0
    fetchMore.mockImplementation(async () => {
      served++
      return { rows: Array.from({ length: 500 }, () => [0]), hasMore: served < 3 }
    })
    await loadAllRows('t', 0, key)
    expect(fetchMore).toHaveBeenCalledTimes(3)
    expect(useConsoles.getState().runtime('t').execution!.results[0]!.rows).toHaveLength(2000)
    expect(useResultViews.getState().views[key]?.loadingAll).toBe(false)
  })

  it('caps "Load all" by rows × columns', () => {
    expect(loadAllLimit(1)).toBe(200_000)
    expect(loadAllLimit(100)).toBe(50_000)
  })
})
