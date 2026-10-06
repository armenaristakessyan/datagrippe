import { describe, expect, it } from 'vitest'
import { previewSql, sqlSummary } from './preview'

describe('previewSql', () => {
  it('drops blank lines and common indentation', () => {
    expect(previewSql('\n    select *\n\n      from orders\n    where id = 1\n')).toBe('select *\n  from orders\nwhere id = 1')
  })

  it('keeps at most three lines and marks the cut', () => {
    expect(previewSql('a\nb\nc\nd')).toBe('a\nb\nc …')
    expect(previewSql('a\nb\nc')).toBe('a\nb\nc')
  })

  it('caps very long statements', () => {
    const long = `select ${'x, '.repeat(400)}1`
    const out = previewSql(long, 3, 50)
    expect(out.length).toBeLessThanOrEqual(52)
    expect(out.endsWith(' …')).toBe(true)
  })

  it('normalizes CRLF and tabs', () => {
    expect(previewSql('\tselect 1\r\n\tfrom t')).toBe('select 1\nfrom t')
  })

  it('returns an empty string for blank input', () => {
    expect(previewSql('  \n\n ')).toBe('')
  })
})

describe('sqlSummary', () => {
  it('flattens whitespace and truncates', () => {
    expect(sqlSummary('select *\n  from   orders')).toBe('select * from orders')
    expect(sqlSummary('x'.repeat(10), 5)).toBe('xxxx…')
  })
})
