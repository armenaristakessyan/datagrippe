import { describe, expect, it } from 'vitest'
import { NNBSP, formatBytes, formatCount, formatDuration, formatRelativeTime, formatTimestamp, pluralize } from './format'

describe('formatBytes', () => {
  it('formats binary multiples', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(12 * 1024 * 1024)).toBe('12 MB')
    expect(formatBytes(1.25 * 1024 ** 3)).toBe('1.3 GB')
    expect(formatBytes(-2048)).toBe('-2 KB')
  })
  it('promotes values that round up to the next unit', () => {
    expect(formatBytes(1024 * 1024 - 1)).toBe('1 MB')
  })
  it('handles missing values', () => {
    expect(formatBytes(undefined)).toBe('—')
    expect(formatBytes(Number.NaN)).toBe('—')
  })
})

describe('formatDuration', () => {
  it('formats milliseconds', () => {
    expect(formatDuration(0)).toBe('0 ms')
    expect(formatDuration(0.4)).toBe('<1 ms')
    expect(formatDuration(12)).toBe('12 ms')
    expect(formatDuration(999.4)).toBe('999 ms')
  })
  it('formats seconds', () => {
    expect(formatDuration(1000)).toBe('1 s')
    expect(formatDuration(1430)).toBe('1.4 s')
    expect(formatDuration(9990)).toBe('10 s')
    expect(formatDuration(23_400)).toBe('23 s')
    expect(formatDuration(59_700)).toBe('1 min')
  })
  it('formats minutes and hours', () => {
    expect(formatDuration(123_000)).toBe('2 min 3 s')
    expect(formatDuration(120_000)).toBe('2 min')
    expect(formatDuration(3_720_000)).toBe('1 h 2 min')
    expect(formatDuration(7_200_000)).toBe('2 h')
  })
  it('rejects invalid input', () => {
    expect(formatDuration(-5)).toBe('—')
    expect(formatDuration(null)).toBe('—')
  })
})

describe('formatCount', () => {
  it('groups thousands with a narrow no-break space', () => {
    expect(formatCount(0)).toBe('0')
    expect(formatCount(999)).toBe('999')
    expect(formatCount(1234)).toBe(`1${NNBSP}234`)
    expect(formatCount(1234567)).toBe(`1${NNBSP}234${NNBSP}567`)
    expect(formatCount(-98765)).toBe(`-98${NNBSP}765`)
    expect(formatCount(1234.5)).toBe(`1${NNBSP}234.5`)
    expect(formatCount(12345678901234567890n)).toBe(['12', '345', '678', '901', '234', '567', '890'].join(NNBSP))
  })
  it('pluralizes', () => {
    expect(pluralize(1, 'row')).toBe('1 row')
    expect(pluralize(2000, 'row')).toBe(`2${NNBSP}000 rows`)
    expect(pluralize(0, 'index', 'indexes')).toBe('0 indexes')
  })
})

describe('formatRelativeTime', () => {
  const now = new Date(2026, 9, 5, 15, 0, 0).getTime()
  it('formats recent past', () => {
    expect(formatRelativeTime(now - 10_000, now)).toBe('just now')
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5 min ago')
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3 h ago')
  })
  it('formats days and dates', () => {
    expect(formatRelativeTime(new Date(2026, 9, 4, 9, 0), now)).toBe('yesterday')
    expect(formatRelativeTime(new Date(2026, 9, 1, 9, 0), now)).toBe('4 days ago')
    expect(formatRelativeTime(new Date(2026, 2, 4, 9, 0), now)).toBe('Mar 4')
    expect(formatRelativeTime(new Date(2024, 2, 4, 9, 0), now)).toBe('Mar 4, 2024')
  })
  it('formats the future', () => {
    expect(formatRelativeTime(now + 5 * 60_000, now)).toBe('in 5 min')
    expect(formatRelativeTime(now + 2 * 3_600_000, now)).toBe('in 2 h')
  })
  it('accepts ISO strings and rejects garbage', () => {
    expect(formatRelativeTime(new Date(now - 120_000).toISOString(), now)).toBe('2 min ago')
    expect(formatRelativeTime('nope', now)).toBe('—')
  })
})

describe('formatTimestamp', () => {
  it('formats local time', () => {
    expect(formatTimestamp(new Date(2026, 2, 4, 14, 5, 9))).toBe('2026-03-04 14:05:09')
  })
})
