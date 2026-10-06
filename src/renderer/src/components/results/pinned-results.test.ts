import { beforeEach, describe, expect, it } from 'vitest'
import type { ExecutionResult, StatementResult } from '@shared/types'
import { MAX_PINNED, dropPinned, isPinned, noteExecution, pinResult, showPinned, syncPinned, unpinResult, usePinnedResults } from './pinned-results'

function rows(index: number, values: number[]): StatementResult {
  return {
    index,
    sql: `select ${index}`,
    offset: 0,
    kind: 'rows',
    columns: [{ name: 'n', dataType: 'int4', nullable: true }],
    rows: values.map((v) => [v]),
    rowCount: values.length,
    hasMore: false,
    durationMs: 1,
  } as unknown as StatementResult
}

function execution(id: string, results: StatementResult[]): ExecutionResult {
  return { executionId: id, sessionId: 's', results, messages: [], durationMs: 1, cancelled: false, transaction: 'idle' } as unknown as ExecutionResult
}

describe('pinned results', () => {
  beforeEach(() => usePinnedResults.setState({ pinned: {}, active: {}, seen: {} }))

  it('keeps a pinned result after the console runs again', () => {
    const first = execution('e1', [rows(0, [1, 2])])
    noteExecution('t', 'e1')
    pinResult('t', first, 0)
    expect(isPinned('t', 'e1', 0)).toBe(true)
    noteExecution('t', 'e2')
    const [pin] = usePinnedResults.getState().pinned.t!
    expect(pin!.result.rows).toEqual([[1], [2]])
    expect(pin!.executionId).toBe('e1')
  })

  it('follows rows fetched later while its execution is live', () => {
    const first = execution('e1', [rows(0, [1])])
    pinResult('t', first, 0)
    syncPinned('t', execution('e1', [rows(0, [1, 2, 3])]))
    expect(usePinnedResults.getState().pinned.t![0]!.result.rows).toHaveLength(3)
    // another execution never overwrites the snapshot
    syncPinned('t', execution('e2', [rows(0, [9])]))
    expect(usePinnedResults.getState().pinned.t![0]!.result.rows).toHaveLength(3)
  })

  it('goes back to the live output when a new execution arrives', () => {
    pinResult('t', execution('e1', [rows(0, [1])]), 0)
    noteExecution('t', 'e2')
    const id = usePinnedResults.getState().pinned.t![0]!.id
    showPinned('t', id)
    noteExecution('t', 'e2')
    expect(usePinnedResults.getState().active.t).toBe(id)
    noteExecution('t', 'e3')
    expect(usePinnedResults.getState().active.t).toBeUndefined()
  })

  it('unpins by id or by result, and caps the list', () => {
    for (let i = 0; i < MAX_PINNED + 2; i++) pinResult('t', execution(`e${i}`, [rows(0, [i])]), 0)
    const list = usePinnedResults.getState().pinned.t!
    expect(list).toHaveLength(MAX_PINNED)
    expect(list[0]!.executionId).toBe('e2')
    showPinned('t', list[0]!.id)
    unpinResult('t', { id: list[0]!.id })
    expect(usePinnedResults.getState().active.t).toBeUndefined()
    unpinResult('t', { executionId: 'e3', index: 0 })
    expect(usePinnedResults.getState().pinned.t!.map((p) => p.executionId)).not.toContain('e3')
    dropPinned('t')
    expect(usePinnedResults.getState().pinned.t).toBeUndefined()
  })
})
