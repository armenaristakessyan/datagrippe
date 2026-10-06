import { describe, expect, it } from 'vitest'
import type { StatementResult } from '@shared/types'
import { buildMessages, formatDuration, leadingKeyword, summarizeResult } from './summary'

function result(overrides: Partial<StatementResult>): StatementResult {
  return {
    index: 0,
    sql: 'select 1',
    offset: 0,
    kind: 'rows',
    columns: [],
    rows: [],
    rowCount: 0,
    hasMore: false,
    durationMs: 12,
    ...overrides,
  }
}

describe('summary', () => {
  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0 ms')
    expect(formatDuration(12.4)).toBe('12 ms')
    expect(formatDuration(1234)).toBe('1.23 s')
    expect(formatDuration(12_345)).toBe('12.3 s')
    expect(formatDuration(65_000)).toBe('1 min 5 s')
  })

  it('summarizes row results', () => {
    const rows = Array.from({ length: 42 }, () => [1])
    expect(summarizeResult(result({ command: 'SELECT', rows, rowCount: 42 }))).toEqual({ level: 'info', text: 'SELECT · 42 rows · 12 ms' })
    expect(summarizeResult(result({ command: 'SELECT', rows: [[1]], rowCount: 1 })).text).toBe('SELECT · 1 row · 12 ms')
    const page = Array.from({ length: 500 }, () => [1])
    expect(summarizeResult(result({ command: 'SELECT', rows: page, rowCount: 500, hasMore: true, durationMs: 8 })).text).toBe(
      'SELECT · first 500 rows · 8 ms',
    )
    expect(summarizeResult(result({ sql: '-- c\nWITH x AS (select 1) select * from x', rows: [[1], [2]], rowCount: 2 })).text).toBe(
      'WITH · 2 rows · 12 ms',
    )
    const many = Array.from({ length: 1234 }, () => [1])
    expect(summarizeResult(result({ command: 'SELECT', rows: many, rowCount: 1234 })).text).toBe('SELECT · 1,234 rows · 12 ms')
  })

  it('summarizes commands and errors', () => {
    expect(summarizeResult(result({ kind: 'command', command: 'UPDATE', rowCount: 3, durationMs: 4 })).text).toBe(
      'UPDATE · 3 rows affected · 4 ms',
    )
    expect(summarizeResult(result({ kind: 'command', command: 'CREATE TABLE', rowCount: null, durationMs: 2 })).text).toBe(
      'CREATE TABLE · 2 ms',
    )
    // no command tag (SQL Server batches): derived from the SQL, row count shown when known
    expect(summarizeResult(result({ kind: 'command', sql: 'create table t (id int)', rowCount: null, durationMs: 2 })).text).toBe(
      'CREATE TABLE · 2 ms',
    )
    expect(summarizeResult(result({ kind: 'command', sql: 'delete from t', rowCount: 1, durationMs: 2 })).text).toBe(
      'DELETE · 1 row affected · 2 ms',
    )
    expect(summarizeResult(result({ kind: 'error', error: { message: 'relation "x" does not exist' } }))).toEqual({
      level: 'error',
      text: 'relation "x" does not exist',
    })
  })

  it('extracts leading keywords', () => {
    expect(leadingKeyword('  /* x */ -- y\n select 1')).toBe('SELECT')
    expect(leadingKeyword('CREATE OR REPLACE VIEW v AS select 1')).toBe('CREATE VIEW')
    expect(leadingKeyword('create unique index i on t(x)')).toBe('CREATE INDEX')
    expect(leadingKeyword('drop table t')).toBe('DROP TABLE')
    expect(leadingKeyword('')).toBeUndefined()
  })

  it('merges summaries with server messages chronologically', () => {
    const results = [result({ command: 'SELECT', durationMs: 10 }), result({ kind: 'command', command: 'UPDATE', rowCount: 1, durationMs: 10 })]
    const messages = buildMessages(
      results,
      [
        { level: 'notice', text: 'during first', at: 1005 },
        { level: 'notice', text: 'during second', at: 1015 },
        { level: 'notice', text: 'at boundary', at: 1010 },
      ],
      1000,
    )
    expect(messages.map((m) => m.text)).toEqual([
      'during first',
      'at boundary',
      'SELECT · 0 rows · 10 ms',
      'during second',
      'UPDATE · 1 row affected · 10 ms',
    ])
    expect(messages[2].at).toBe(1010)
  })

  it('places messages by resultsBefore when the driver reports it', () => {
    const results = [result({ command: 'SELECT', durationMs: 0 }), result({ command: 'SELECT', durationMs: 0 })]
    // Same timestamps everywhere: only resultsBefore can order them.
    const messages = buildMessages(
      results,
      [
        { level: 'info', text: 'p1', at: 1000, resultsBefore: 0 },
        { level: 'info', text: 'p2', at: 1000, resultsBefore: 1 },
        { level: 'info', text: 'p3', at: 1000, resultsBefore: 2 },
      ],
      1000,
    )
    expect(messages.map((m) => m.text)).toEqual(['p1', 'SELECT · 0 rows · 0 ms', 'p2', 'SELECT · 0 rows · 0 ms', 'p3'])
  })
})
