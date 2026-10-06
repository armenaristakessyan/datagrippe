import { describe, expect, it } from 'vitest'
import type { StatementResult } from '@shared/types'
import { codePointToIndex, commandSummary, errorLocation, locateStatement, errorReport, inferTableName, isCancelledResult, resultLabel, severityLabel, rowCountLabel, shortName } from './result-meta'

function result(partial: Partial<StatementResult>): StatementResult {
  return { index: 0, sql: 'select 1', offset: 0, kind: 'rows', columns: [], rows: [], rowCount: 0, hasMore: false, durationMs: 1, ...partial }
}

describe('inferTableName', () => {
  const t = (sql: string) => inferTableName({ sql, columns: [{ name: 'a', dataType: 'int4' }] })
  it('uses ColumnMeta.table when every column agrees', () => {
    expect(inferTableName({ sql: 'select 1', columns: [{ name: 'a', dataType: 'x', table: 'orders' }, { name: 'b', dataType: 'x', table: 'orders' }] })).toBe('orders')
  })
  it('prefers the schema-qualified name of the statement over a bare ColumnMeta.table', () => {
    const columns = [{ name: 'a', dataType: 'int4', table: 'orders' }]
    expect(inferTableName({ sql: 'SELECT * FROM sales.orders', columns })).toBe('sales.orders')
    expect(inferTableName({ sql: 'select * from "Sales"."Orders"', columns: [{ name: 'a', dataType: 'int4', table: 'Orders' }] })).toBe('Sales.Orders')
    // a qualified ColumnMeta.table is trusted as is; a different table in the text is ignored
    expect(inferTableName({ sql: 'SELECT * FROM sales.orders', columns: [{ name: 'a', dataType: 'x', table: 'sales.orders' }] })).toBe('sales.orders')
    expect(inferTableName({ sql: 'SELECT * FROM sales.order_view', columns })).toBe('orders')
  })
  it('reads simple single-table selects', () => {
    expect(t('SELECT * FROM orders')).toBe('orders')
    expect(t('select id from public.orders o where id > 1 order by id')).toBe('public.orders')
    expect(t('SELECT TOP 10 * FROM [dbo].[Order Lines] AS ol')).toBe('dbo.Order Lines')
    expect(t('select * from "Users" limit 5;')).toBe('Users')
    expect(t('TABLE events')).toBe('events')
    expect(t("select * from t -- from other\n where name = 'from x'")).toBe('t')
  })
  it('gives up on joins, subqueries, set operations and functions', () => {
    expect(t('select * from a join b on a.id = b.id')).toBeUndefined()
    expect(t('select * from a, b')).toBeUndefined()
    expect(t('select * from (select 1) s')).toBeUndefined()
    expect(t('select 1 union select 2 from x')).toBeUndefined()
    expect(t('select * from generate_series(1, 10)')).toBeUndefined()
    expect(t('select now()')).toBeUndefined()
    expect(t('update t set a = 1')).toBeUndefined()
  })
  it('shortens qualified names', () => {
    expect(shortName('public.orders')).toBe('orders')
    expect(shortName('orders')).toBe('orders')
  })
})

describe('resultLabel', () => {
  it('labels rows by table or position', () => {
    expect(resultLabel(result({ sql: 'select * from public.orders' }), 'postgres').label).toBe('orders')
    expect(resultLabel(result({ index: 2, sql: 'select 1' }), 'postgres').label).toBe('Result 3')
  })
  it('labels commands with their row count', () => {
    expect(resultLabel(result({ kind: 'command', command: 'UPDATE', rowCount: 3, sql: 'update t set a=1' }), 'postgres').label).toBe('UPDATE · 3')
    expect(resultLabel(result({ kind: 'command', rowCount: null, sql: 'create table x (a int)' }), 'postgres').label).toBe('CREATE')
  })
  it('labels errors by position', () => {
    expect(resultLabel(result({ kind: 'error', index: 1, error: { message: 'boom' } }), 'postgres')).toMatchObject({ label: 'Result 2' })
  })
})

describe('rowCountLabel', () => {
  it('describes complete, fetchable and truncated results', () => {
    expect(rowCountLabel({ rows: [[1]], hasMore: false })).toEqual({ text: '1 row', truncated: false, more: false })
    expect(rowCountLabel({ rows: Array.from({ length: 500 }, () => [1]), hasMore: true, cursorId: 'c' })).toEqual({ text: '500+ rows', truncated: false, more: true })
    expect(rowCountLabel({ rows: Array.from({ length: 500 }, () => [1]), hasMore: true })).toEqual({ text: 'First 500 rows', truncated: true, more: false })
  })
})

describe('commandSummary', () => {
  it('reports affected rows or completion', () => {
    expect(commandSummary({ rowCount: 3, sql: '' })).toBe('3 rows affected')
    expect(commandSummary({ rowCount: 1, sql: '' })).toBe('1 row affected')
    expect(commandSummary({ rowCount: null, command: 'CREATE TABLE', sql: '' })).toBe('CREATE TABLE completed')
    expect(commandSummary({ rowCount: null, sql: 'drop table x' }, 'postgres')).toBe('DROP completed')
  })
})

describe('errorLocation', () => {
  const sql = 'select *\nfrom missing_table\nwhere 1 = 1'
  it('maps a PostgreSQL position to the token and its line', () => {
    const pos = sql.indexOf('missing_table') + 1
    expect(errorLocation(sql, { position: pos })).toEqual({
      start: pos - 1,
      end: pos - 1 + 'missing_table'.length,
      line: 2,
      column: 6,
      lineText: 'from missing_table',
      caretOffset: 5,
    })
  })
  it('counts PostgreSQL positions in characters, not UTF-16 units', () => {
    const astral = "SELECT '😀😀😀' AS e, nope FROM public.customers"
    // the server counts each emoji as one character
    const pos = [...astral.slice(0, astral.indexOf('nope'))].length + 1
    const loc = errorLocation(astral, { position: pos })!
    expect(astral.slice(loc.start, loc.end)).toBe('nope')
    expect(loc.column).toBe(pos)
    expect(loc.lineText.slice(0, loc.caretOffset)).toBe("SELECT '😀😀😀' AS e, ")
  })
  it('maps a SQL Server line number to the trimmed line', () => {
    const batch = 'select 1\n  selec 2\nselect 3'
    expect(errorLocation(batch, { line: 2 })).toEqual({ start: 11, end: 18, line: 2, column: 3, lineText: '  selec 2', caretOffset: 2 })
    expect(errorLocation(batch, { line: 99 })?.line).toBe(3)
  })
  it('clamps positions past the end and returns null without a location', () => {
    expect(errorLocation('select', { position: 50 })?.start).toBe(5)
    expect(errorLocation('select', {})).toBeNull()
  })
})

describe('codePointToIndex / locateStatement', () => {
  it('converts character positions to string indices', () => {
    expect(codePointToIndex('a😀b', 0)).toBe(0)
    expect(codePointToIndex('a😀b', 2)).toBe(3)
    expect(codePointToIndex('a😀b', 99)).toBe(4)
  })
  it('finds a statement that moved, and gives up when it was edited', () => {
    const text = '-- note\nSELECT 1;\nSELECT nope;'
    expect(locateStatement(text, 'SELECT nope', text.indexOf('SELECT nope'))).toBe(text.indexOf('SELECT nope'))
    expect(locateStatement(text, 'SELECT nope', 10)).toBe(text.indexOf('SELECT nope'))
    expect(locateStatement(text, 'SELECT gone', 10)).toBeNull()
  })
})

describe('severityLabel', () => {
  it('labels numeric SQL Server severities', () => {
    expect(severityLabel('16')).toBe('Severity 16')
    expect(severityLabel('ERROR')).toBe('ERROR')
  })
})

describe('errorReport', () => {
  it('includes code, detail, hint, location and statement', () => {
    const text = errorReport({ message: 'relation "x" does not exist', code: '42P01', hint: 'Check the name', position: 15 }, 'select * from x', 'postgres')
    expect(text).toBe('relation "x" does not exist\nSQLSTATE: 42P01\nHint: Check the name\nLine 1, column 15\n\nselect * from x')
    expect(errorReport({ message: 'm', code: '208' }, undefined, 'mssql')).toBe('m\nError number: 208')
  })
})

describe('isCancelledResult', () => {
  it('recognizes user cancellation', () => {
    expect(isCancelledResult(result({ kind: 'error', error: { message: 'x', code: '57014' } }))).toBe(true)
    expect(isCancelledResult(result({ kind: 'error', error: { message: 'x', kind: 'cancelled' } }))).toBe(true)
    expect(isCancelledResult(result({ kind: 'error', index: 1, error: { message: 'x' } }), { cancelled: true, results: [1, 2] })).toBe(true)
    expect(isCancelledResult(result({ kind: 'error', index: 0, error: { message: 'x' } }), { cancelled: true, results: [1, 2] })).toBe(false)
    expect(isCancelledResult(result({ kind: 'rows' }), { cancelled: true, results: [1] })).toBe(false)
  })
})
