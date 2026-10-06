import { describe, expect, it } from 'vitest'
import type { ExecutionResult, StatementResult } from '@shared/types'
import { summarizeExecution } from './status-summary'

const result = (index: number, patch: Partial<StatementResult>): StatementResult => ({
  index,
  sql: `stmt ${index}`,
  offset: 0,
  kind: 'command',
  columns: [],
  rows: [],
  rowCount: null,
  hasMore: false,
  durationMs: 1,
  ...patch,
})

const execution = (results: StatementResult[], durationMs = 11): ExecutionResult => ({
  executionId: 'e',
  sessionId: 's',
  results,
  messages: [],
  durationMs,
  cancelled: false,
  transaction: { autoCommit: true, inTransaction: false },
})

describe('summarizeExecution', () => {
  it('uses the active result’s own duration, like the results header', () => {
    const run = execution([result(0, { kind: 'rows', rows: [[1], [2], [3], [4], [5]], rowCount: 5, durationMs: 5 })], 6)
    expect(summarizeExecution(run, 0, 'results')).toEqual({ text: '5 rows', durationMs: 5, danger: false, title: undefined })
  })

  it('summarizes a script as N statements when Messages is shown', () => {
    const run = execution([
      result(0, { command: 'CREATE TABLE' }),
      result(1, { rowCount: 2, command: 'INSERT' }),
      result(2, { rowCount: 2, command: 'UPDATE' }),
      result(3, { command: 'DO' }),
    ])
    expect(summarizeExecution(run, 3, 'messages')).toMatchObject({ text: '4 statements', durationMs: 11, danger: false })
    // The results view still describes the statement it shows.
    expect(summarizeExecution(run, 1, 'results')).toMatchObject({ text: '2 affected', durationMs: 1, title: 'Statement 2 of 4' })
  })

  it('counts failures in danger tone', () => {
    const run = execution([result(0, {}), result(1, { kind: 'error', error: { message: 'boom' } })])
    expect(summarizeExecution(run, 1, 'messages')).toMatchObject({ text: '2 statements · 1 failed', danger: true })
    expect(summarizeExecution(run, 1, 'results')).toMatchObject({ text: 'Failed', danger: true })
  })

  it('describes the plan while the Plan view is active', () => {
    const run = execution([result(0, { rowCount: 2 })])
    const plan = { format: 'postgres-json' as const, raw: '[]', root: null, totalTimeMs: 0.45 }
    expect(summarizeExecution(run, 0, 'explain', plan)).toMatchObject({ text: 'Plan', durationMs: 0.45 })
    expect(summarizeExecution(undefined, 0, 'explain', { ...plan, totalTimeMs: undefined })).toEqual({ text: 'Plan' })
    expect(summarizeExecution(undefined, 0, 'results')).toBeNull()
  })

  it('reports a cancelled run', () => {
    expect(summarizeExecution({ ...execution([]), cancelled: true }, 0, 'results')).toEqual({ text: 'Cancelled', durationMs: 11 })
  })
})
