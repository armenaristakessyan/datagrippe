import { describe, expect, it } from 'vitest'
import type { CellValue } from '@shared/types'
import { columnKind } from './column-types'
import { compareDecimalStrings, compareValues, instantKey, intervalSeconds, nextSort, setSort, sortedOrder, sortRowsForView } from './sort'

const col = (values: CellValue[]): CellValue[][] => values.map((v) => [v])

describe('compareDecimalStrings', () => {
  it('orders by value, not text', () => {
    expect(compareDecimalStrings('10', '9')).toBe(1)
    expect(compareDecimalStrings('-10', '-9')).toBe(-1)
    expect(compareDecimalStrings('1.50', '1.5')).toBe(0)
    expect(compareDecimalStrings('-0', '0')).toBe(0)
    expect(compareDecimalStrings('12345678901234567890', '12345678901234567891')).toBe(-1)
    expect(compareDecimalStrings('0.001', '0.01')).toBe(-1)
  })
})

describe('compareValues', () => {
  it('compares string-encoded numerics numerically', () => {
    expect(compareValues('100', '20', 'number')).toBeGreaterThan(0)
    expect(compareValues('9007199254740993', '9007199254740992', 'number')).toBeGreaterThan(0)
    expect(compareValues('$1,200.00', '$300.00', 'number')).toBeGreaterThan(0)
    expect(compareValues('NaN', '5', 'number')).toBeGreaterThan(0)
    expect(compareValues('-Infinity', '-5', 'number')).toBeLessThan(0)
  })
  it('uses locale + numeric-aware compare for text', () => {
    expect(compareValues('item 2', 'item 10', 'text')).toBeLessThan(0)
    expect(compareValues('apple', 'Banana', 'text')).toBeLessThan(0)
    expect(compareValues('é', 'f', 'text')).toBeLessThan(0)
  })
  it('compares dates by code point and booleans false < true', () => {
    expect(compareValues('2024-01-02 00:00:00', '2023-12-31 23:59:59', 'date')).toBeGreaterThan(0)
    expect(compareValues(false, true, 'boolean')).toBeLessThan(0)
  })
  it('ranks mixed types', () => {
    expect(compareValues(1, 'a', 'text')).toBeLessThan(0)
    expect(compareValues(true, 1, 'text')).toBeLessThan(0)
  })
})

describe('sortedOrder', () => {
  it('returns null without keys', () => {
    expect(sortedOrder(col([1, 2]), [])).toBeNull()
  })
  it('sorts numbers numerically with NULLs last in both directions', () => {
    const rows = col(['10', null, '9', '100'])
    expect(sortedOrder(rows, [{ col: 0, direction: 'asc', kind: 'number' }])).toEqual([2, 0, 3, 1])
    expect(sortedOrder(rows, [{ col: 0, direction: 'desc', kind: 'number' }])).toEqual([3, 0, 2, 1])
  })
  it('is stable and supports multiple keys', () => {
    const rows: CellValue[][] = [
      ['b', 2],
      ['a', 2],
      ['b', 1],
      ['a', 1],
      ['a', 2],
    ]
    expect(sortedOrder(rows, [{ col: 0, direction: 'asc', kind: 'text' }])).toEqual([1, 3, 4, 0, 2])
    expect(
      sortedOrder(rows, [
        { col: 0, direction: 'asc', kind: 'text' },
        { col: 1, direction: 'desc', kind: 'number' },
      ]),
    ).toEqual([1, 4, 3, 0, 2])
  })
  it('handles JS numbers mixed with numeric text', () => {
    expect(sortedOrder(col([3, '1.5', 2]), [{ col: 0, direction: 'asc', kind: 'number' }])).toEqual([1, 2, 0])
  })
  it('sorts 200k rows quickly', () => {
    const rows = Array.from({ length: 200_000 }, (_, i) => [String((i * 7919) % 200_000)])
    const t = performance.now()
    const order = sortedOrder(rows, [{ col: 0, direction: 'asc', kind: 'number' }])!
    expect(performance.now() - t).toBeLessThan(1500)
    expect(rows[order[0]!]![0]).toBe('0')
    expect(rows[order[199_999]!]![0]).toBe('199999')
  })
})

describe('nextSort', () => {
  it('cycles asc → desc → none', () => {
    let s = nextSort([], 'a', false)
    expect(s).toEqual([{ column: 'a', direction: 'asc' }])
    s = nextSort(s, 'a', false)
    expect(s).toEqual([{ column: 'a', direction: 'desc' }])
    expect(nextSort(s, 'a', false)).toEqual([])
  })
  it('replaces other columns without multi', () => {
    expect(nextSort([{ column: 'a', direction: 'asc' }], 'b', false)).toEqual([{ column: 'b', direction: 'asc' }])
  })
  it('adds and cycles in place with multi', () => {
    let s = nextSort([{ column: 'a', direction: 'asc' }], 'b', true)
    expect(s).toEqual([
      { column: 'a', direction: 'asc' },
      { column: 'b', direction: 'asc' },
    ])
    s = nextSort(s, 'a', true)
    expect(s).toEqual([
      { column: 'a', direction: 'desc' },
      { column: 'b', direction: 'asc' },
    ])
    expect(nextSort(s, 'a', true)).toEqual([{ column: 'b', direction: 'asc' }])
  })
})

describe('setSort', () => {
  it('sets or clears explicitly', () => {
    expect(setSort([{ column: 'a', direction: 'asc' }], 'b', 'desc')).toEqual([{ column: 'b', direction: 'desc' }])
    expect(setSort([{ column: 'a', direction: 'asc' }], 'a', null)).toEqual([])
    expect(setSort([{ column: 'a', direction: 'asc' }], 'b', 'desc', true)).toHaveLength(2)
  })
})

describe('temporal sorting', () => {
  const sortColumn = (values: string[], dataType: string, dialect?: 'postgres' | 'mssql'): CellValue[] => {
    const rows = values.map((v) => [v])
    const order = sortedOrder(rows, [{ col: 0, direction: 'asc', kind: columnKind(dataType, dialect) }])!
    return order.map((i) => rows[i]![0]!)
  }

  it('orders PostgreSQL intervals by duration', () => {
    expect(sortColumn(['10 days', '2 days', '1 year', '3 mons', '00:30:00'], 'interval')).toEqual(['00:30:00', '2 days', '10 days', '3 mons', '1 year'])
    expect(sortColumn(['1 day 02:00:00', '-1 days', '1 day', '@ 2 hours ago', 'P1D', 'PT36H'], 'interval')).toEqual([
      '-1 days',
      '@ 2 hours ago',
      '1 day',
      'P1D',
      '1 day 02:00:00',
      'PT36H',
    ])
  })

  it('orders values carrying different offsets by instant', () => {
    // 10:00 +05:00 is 05:00 UTC, which is before 06:00 +00:00
    expect(sortColumn(['2024-01-01 06:00:00.0000000 +00:00', '2024-01-01 10:00:00.0000000 +05:00'], 'datetimeoffset', 'mssql')).toEqual([
      '2024-01-01 10:00:00.0000000 +05:00',
      '2024-01-01 06:00:00.0000000 +00:00',
    ])
    expect(sortColumn(['2024-01-15 09:30:00+02', '2024-01-15 08:00:00+00', '2024-01-15 09:00:00.5+00'], 'timestamptz')).toEqual([
      '2024-01-15 09:30:00+02',
      '2024-01-15 08:00:00+00',
      '2024-01-15 09:00:00.5+00',
    ])
  })

  it('keeps ordering plain dates and timestamps by text', () => {
    expect(sortColumn(['2024-02-01', '2023-12-31', '2024-01-15'], 'date')).toEqual(['2023-12-31', '2024-01-15', '2024-02-01'])
    expect(intervalSeconds('2024-01-15')).toBeNull()
    expect(instantKey('2024-01-15 10:00:00')).toBeNull()
  })
})

describe('sortRowsForView', () => {
  it('orders rows like the grid (column kinds inferred the same way)', () => {
    const columns = [{ name: 'n', dataType: 'numeric' }, { name: 't', dataType: 'text' }]
    const rows = [['10', 'b'], ['9', 'a'], [null, 'c']]
    expect(sortRowsForView(columns, rows, [{ column: 'n', direction: 'desc' }], 'postgres')).toEqual([['10', 'b'], ['9', 'a'], [null, 'c']])
    expect(sortRowsForView(columns, rows, [{ column: 'n', direction: 'asc' }], 'postgres')).toEqual([['9', 'a'], ['10', 'b'], [null, 'c']])
    expect(sortRowsForView(columns, rows, [])).toEqual(rows)
  })
})
