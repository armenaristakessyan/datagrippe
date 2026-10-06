import { describe, expect, it } from 'vitest'
import type { ExecutionResult, StatementResult } from '@shared/types'
import { codePointOffset, errorRange, executionErrorRange } from './error-mapping'

function result(sql: string, offset: number, error: StatementResult['error']): StatementResult {
  return { index: 0, sql, offset, kind: 'error', columns: [], rows: [], rowCount: null, hasMore: false, durationMs: 1, error }
}

describe('errorRange', () => {
  it('maps a PostgreSQL position (1-based, inside the statement) to the token', () => {
    const text = '-- report\nSELECT 1;\nSELECT nme FROM users;'
    // the user ran the whole script (executionOffset 0); the second statement starts at its own offset
    const sql = 'SELECT nme FROM users'
    const offset = text.indexOf(sql)
    const mapped = errorRange(text, 0, result(sql, offset, { message: 'column "nme" does not exist', position: 8 }))
    expect(mapped).toEqual({ start: offset + 7, end: offset + 10, message: 'column "nme" does not exist' })
    expect(text.slice(mapped!.start, mapped!.end)).toBe('nme')
  })

  it('adds the execution offset when only a selection / statement was run', () => {
    const text = 'SELECT 1;\n\nSELECT * FROM missing_table;'
    const sql = 'SELECT * FROM missing_table'
    const executionOffset = text.indexOf(sql)
    const mapped = errorRange(text, executionOffset, result(sql, 0, { message: 'relation does not exist', position: 15 }))
    expect(text.slice(mapped!.start, mapped!.end)).toBe('missing_table')
  })

  it('highlights a quoted identifier as a whole', () => {
    const text = 'SELECT "Bad Col" FROM t'
    const mapped = errorRange(text, 0, result(text, 0, { message: 'x', position: 8 }))
    expect(text.slice(mapped!.start, mapped!.end)).toBe('"Bad Col"')
  })

  it('maps a SQL Server line inside the batch, trimmed', () => {
    const text = 'SELECT 1\nGO\nSELECT *\n  FROM nope\nWHERE 1 = 1'
    const batch = 'SELECT *\n  FROM nope\nWHERE 1 = 1'
    const offset = text.indexOf(batch)
    const mapped = errorRange(text, 0, result(batch, offset, { message: "Invalid object name 'nope'.", line: 2 }))
    expect(text.slice(mapped!.start, mapped!.end)).toBe('FROM nope')
  })

  it('clamps out-of-range locations', () => {
    const text = 'SELECT x'
    expect(text.slice(...rangeOf(errorRange(text, 0, result(text, 0, { message: 'm', position: 99 }))))).toBe('x')
    expect(text.slice(...rangeOf(errorRange(text, 0, result(text, 0, { message: 'm', line: 7 }))))).toBe('SELECT x')
  })

  it('finds the statement again after the text was edited', () => {
    const sql = 'SELECT nme FROM users'
    const text = `-- inserted line\n${sql}`
    const mapped = errorRange(text, 0, result(sql, 0, { message: 'm', position: 8 }))
    expect(text.slice(mapped!.start, mapped!.end)).toBe('nme')
  })

  it('returns null without a location or when the statement is gone', () => {
    expect(errorRange('SELECT 1', 0, result('SELECT 1', 0, { message: 'boom' }))).toBeNull()
    expect(errorRange('SELECT 2', 0, result('SELECT 1', 0, { message: 'boom', position: 1 }))).toBeNull()
  })
})

describe('executionErrorRange', () => {
  it('uses the first failing statement', () => {
    const text = 'SELECT 1; SELECT nme;'
    const execution: ExecutionResult = {
      executionId: 'e',
      sessionId: 's',
      messages: [],
      durationMs: 2,
      cancelled: false,
      transaction: { autoCommit: true, inTransaction: false },
      results: [
        { ...result('SELECT 1', 0, undefined), kind: 'rows' },
        result('SELECT nme', 10, { message: 'column "nme" does not exist', position: 8 }),
      ],
    }
    const mapped = executionErrorRange(text, 0, execution)
    expect(text.slice(mapped!.start, mapped!.end)).toBe('nme')
  })
})

function rangeOf(r: { start: number; end: number } | null): [number, number] {
  if (!r) throw new Error('expected a range')
  return [r.start, r.end]
}

describe('PostgreSQL positions count characters, not UTF-16 units', () => {
  it('maps a position after astral characters onto the right token', () => {
    const sql = "SELECT '🚀🚀🚀' AS rockets, no_such_column FROM sales.orders"
    // PostgreSQL position: 1-based, in code points
    const position = Array.from(sql).indexOf('n') + 1
    const mapped = errorRange(sql, 0, { sql, offset: 0, error: { message: 'column "no_such_column" does not exist', position } })
    expect(mapped && sql.slice(mapped.start, mapped.end)).toBe('no_such_column')
  })

  it('codePointOffset walks surrogate pairs', () => {
    expect(codePointOffset('a🚀b', 2)).toBe(3)
    expect(codePointOffset('abc', 2)).toBe(2)
    expect(codePointOffset('ab', 10)).toBe(2)
  })
})
