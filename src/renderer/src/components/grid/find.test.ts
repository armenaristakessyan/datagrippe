import { describe, expect, it } from 'vitest'
import type { CellValue } from '@shared/types'
import { collectMatches, filteredOrder, makeMatcher, nearestMatch, passesFilters } from './find'

const rows: CellValue[][] = [
  [1, 'Ada Lovelace', null],
  [2, 'Alan Turing', 'failed'],
  [3, 'Grace Hopper', 'ok'],
  [42, 'Barbara', 'FAILED'],
]

describe('find in loaded rows', () => {
  it('matches displayed text, case-insensitively by default, never NULL', () => {
    const m = makeMatcher('failed')!
    expect(m('FAILED')).toBe(true)
    expect(m(null)).toBe(false)
    expect(makeMatcher('failed', true)!('FAILED')).toBe(false)
    expect(makeMatcher('42')!(42)).toBe(true)
    expect(makeMatcher('')).toBeNull()
  })

  it('collects matches in view order, reporting view columns', () => {
    const order = [3, 2, 1, 0] // e.g. a descending sort
    const { matches, capped } = collectMatches(rows, order.length, (v) => order[v]!, [2, 1], makeMatcher('a')!)
    expect(capped).toBe(false)
    // view row 0 is source row 3 ('Barbara', 'FAILED'): both view columns match
    expect(matches.slice(0, 2)).toEqual([
      { row: 0, col: 0 },
      { row: 0, col: 1 },
    ])
    expect(collectMatches(rows, 4, (v) => v, [0, 1, 2], makeMatcher('a')!, 2).capped).toBe(true)
  })

  it('steps to the next / previous match, wrapping around', () => {
    const matches = [
      { row: 0, col: 1 },
      { row: 2, col: 0 },
      { row: 5, col: 3 },
    ]
    expect(nearestMatch(matches, { row: 2, col: 0 }, false)).toBe(2)
    expect(nearestMatch(matches, { row: 2, col: 0 }, false, true)).toBe(1)
    expect(nearestMatch(matches, { row: 5, col: 3 }, false)).toBe(0)
    expect(nearestMatch(matches, { row: 0, col: 1 }, true)).toBe(2)
    expect(nearestMatch(matches, null, true)).toBe(2)
    expect(nearestMatch([], null, false)).toBe(-1)
  })
})

describe('value filters', () => {
  it('keeps rows equal to (or different from) a value; NULL is a value', () => {
    expect(passesFilters(rows[1], [{ col: 2, value: 'failed', exclude: false }])).toBe(true)
    expect(passesFilters(rows[0], [{ col: 2, value: null, exclude: false }])).toBe(true)
    expect(passesFilters(rows[0], [{ col: 2, value: null, exclude: true }])).toBe(false)
  })

  it('filters a sorted order and the "only matching rows" view', () => {
    const sorted = [3, 2, 1, 0]
    expect(filteredOrder(rows, sorted, 3, [{ col: 2, value: 'ok', exclude: true }], null)).toEqual([3, 1, 0])
    expect(filteredOrder(rows, null, 3, [], makeMatcher('turing'))).toEqual([1])
  })
})
