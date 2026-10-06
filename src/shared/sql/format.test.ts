import { describe, expect, it } from 'vitest'
import { formatSql, splitStatements, type FormatOptions } from './index'

const upper: FormatOptions = { keywordCase: 'upper', tabWidth: 2 }

describe('formatSql — postgres', () => {
  it('formats with keyword case and indentation', () => {
    expect(formatSql('select a, b from t where x = 1', 'postgres', upper)).toBe(
      'SELECT\n  a,\n  b\nFROM\n  t\nWHERE\n  x = 1',
    )
    expect(formatSql('SELECT a FROM t', 'postgres', { keywordCase: 'lower', tabWidth: 4 })).toBe(
      'select\n    a\nfrom\n    t',
    )
  })

  it('preserves keyword case when asked', () => {
    expect(formatSql('Select a From t', 'postgres', { keywordCase: 'preserve', tabWidth: 2 })).toBe(
      'Select\n  a\nFrom\n  t',
    )
  })

  it('keeps strings, dollar bodies and parameters intact', () => {
    const out = formatSql("select 'a;b', $$x;y$$, $1 from t", 'postgres', upper)
    expect(out).toContain("'a;b'")
    expect(out).toContain('$$x;y$$')
    expect(out).toContain('$1')
  })

  it('keeps statements separated', () => {
    const out = formatSql('select 1; select 2;', 'postgres', upper)
    expect(splitStatements(out, 'postgres').map((s) => s.text.replace(/\s+/g, ' '))).toEqual(['SELECT 1', 'SELECT 2'])
  })

  it('keeps a trailing newline', () => {
    expect(formatSql('select 1\n', 'postgres', upper)).toBe('SELECT\n  1\n')
  })

  it('returns the input unchanged when it cannot be parsed', () => {
    expect(formatSql('select ((( from', 'postgres', upper)).toBe('select ((( from')
    expect(formatSql("select 'abc", 'postgres', upper)).toBe("select 'abc")
  })

  it('returns blank input unchanged', () => {
    expect(formatSql('', 'postgres', upper)).toBe('')
    expect(formatSql('  \n', 'postgres', upper)).toBe('  \n')
  })
})

describe('formatSql — mssql', () => {
  it('formats T-SQL', () => {
    expect(formatSql('select top 10 [a] from dbo.t', 'mssql', upper)).toContain('[a]')
  })

  it('formats each batch and keeps GO separators', () => {
    expect(formatSql('select 1\ngo\nselect 2', 'mssql', upper)).toBe('SELECT\n  1\ngo\nSELECT\n  2')
  })

  it('keeps GO counts and comments on the GO line', () => {
    const out = formatSql('insert into t default values\n  GO 5 -- five\nselect 1', 'mssql', upper)
    expect(out.split('\n')).toContain('GO 5 -- five')
    expect(splitStatements(out, 'mssql').map((b) => b.repeat)).toEqual([5, undefined])
  })

  it('keeps a trailing GO', () => {
    expect(formatSql('select 1\nGO\n', 'mssql', upper)).toBe('SELECT\n  1\nGO\n')
  })

  it('does not treat GO inside a string as a separator', () => {
    const out = formatSql("select 'x\nGO\ny'", 'mssql', upper)
    expect(splitStatements(out, 'mssql')).toHaveLength(1)
  })

  it('returns the whole input unchanged when one batch fails', () => {
    const sql = 'select 1\nGO\nselect ((( from'
    expect(formatSql(sql, 'mssql', upper)).toBe(sql)
  })
})
