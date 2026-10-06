import { describe, expect, it } from 'vitest'
import { columnAt, columnNames, columnOffsets, gutterWidth, sliceRect } from './grid-data'

describe('column geometry', () => {
  const offsets = columnOffsets([100, 50, 80])
  it('builds prefix offsets', () => {
    expect(offsets).toEqual([0, 100, 150, 230])
  })
  it('finds the column under an x position, clamped', () => {
    expect(columnAt(offsets, -5)).toBe(0)
    expect(columnAt(offsets, 0)).toBe(0)
    expect(columnAt(offsets, 99.9)).toBe(0)
    expect(columnAt(offsets, 100)).toBe(1)
    expect(columnAt(offsets, 229)).toBe(2)
    expect(columnAt(offsets, 999)).toBe(2)
    expect(columnAt([0], 10)).toBe(-1)
  })
  it('sizes the gutter for the row count', () => {
    expect(gutterWidth(9)).toBe(44)
    expect(gutterWidth(200_000)).toBeGreaterThan(gutterWidth(999))
  })
})

describe('sliceRect', () => {
  it('extracts the selected rectangle in view order', () => {
    const columns = ['a', 'b', 'c'].map((name) => ({ name, dataType: 'text' }))
    const rows = [
      ['a0', 'b0', 'c0'],
      ['a1', 'b1', 'c1'],
      ['a2', 'b2', 'c2'],
    ]
    const order = [2, 0, 1]
    const slice = sliceRect({ r0: 0, r1: 1, c0: 1, c1: 2 }, columns, rows, (v) => order[v]!)
    expect(slice.columns.map((c) => c.name)).toEqual(['b', 'c'])
    expect(slice.rows).toEqual([
      ['b2', 'c2'],
      ['b0', 'c0'],
    ])
    expect(columnNames(slice.columns)).toBe('b, c')
  })
})
