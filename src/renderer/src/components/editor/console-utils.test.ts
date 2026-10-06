import { describe, expect, it } from 'vitest'
import { fileBaseName, formatElapsed, suggestedFileName } from './console-utils'

describe('console utils', () => {
  it('derives file names', () => {
    expect(fileBaseName('/Users/me/sql/report.sql')).toBe('report.sql')
    expect(fileBaseName('C:\\work\\daily.sql')).toBe('daily.sql')
    expect(suggestedFileName({ title: 'Query 1' })).toBe('Query 1.sql')
    expect(suggestedFileName({ title: 'report.sql' })).toBe('report.sql')
    expect(suggestedFileName({ title: 'a/b: c' })).toBe('a-b- c.sql')
    expect(suggestedFileName({ title: '  ' })).toBe('query.sql')
    expect(suggestedFileName({ title: 'x', filePath: '/tmp/x.sql' })).toBe('/tmp/x.sql')
  })

  it('formats the elapsed ticker', () => {
    expect(formatElapsed(0)).toBe('0.0 s')
    expect(formatElapsed(1450)).toBe('1.4 s')
    expect(formatElapsed(59_940)).toBe('59.9 s')
    expect(formatElapsed(65_000)).toBe('1:05')
  })
})
