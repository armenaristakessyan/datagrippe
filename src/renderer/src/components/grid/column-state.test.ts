import { describe, expect, it } from 'vitest'
import {
  columnsSignature,
  defaultColumnState,
  freezeThrough,
  isDefaultColumnState,
  loadColumnState,
  moveColumn,
  normalizeColumnState,
  saveColumnState,
  setColumnHidden,
  visibleColumns,
} from './column-state'

describe('column arrangement', () => {
  it('hides and shows columns, never all of them', () => {
    let s = setColumnHidden(defaultColumnState(3), 1, true)
    expect(visibleColumns(s)).toEqual([0, 2])
    s = setColumnHidden(s, 0, true)
    expect(visibleColumns(s)).toEqual([2])
    expect(setColumnHidden(s, 2, true)).toBe(s)
    expect(visibleColumns(setColumnHidden(s, 0, false))).toEqual([0, 2])
  })

  it('moves a column to a display position', () => {
    expect(moveColumn(defaultColumnState(4), 3, 0).order).toEqual([3, 0, 1, 2])
    expect(moveColumn(defaultColumnState(4), 0, 9).order).toEqual([1, 2, 3, 0])
  })

  it('freezes leading visible columns, keeping one scrollable column', () => {
    expect(freezeThrough(defaultColumnState(3), 0).frozen).toBe(1)
    expect(freezeThrough(defaultColumnState(3), 2).frozen).toBe(2)
    expect(freezeThrough(freezeThrough(defaultColumnState(3), 1), -1).frozen).toBe(0)
  })

  it('normalizes a saved state for another column count', () => {
    expect(normalizeColumnState({ order: [5, 1, 1, 0], hidden: [0, 9], frozen: 7 }, 3)).toEqual({ order: [1, 0, 2], hidden: [0], frozen: 1 })
    expect(isDefaultColumnState(normalizeColumnState(undefined, 2))).toBe(true)
  })

  it('remembers an arrangement per key, for the same columns only', () => {
    const sig = columnsSignature([
      { name: 'id', dataType: 'int4' },
      { name: 'name', dataType: 'text' },
    ])
    saveColumnState('t:test', sig, { order: [1, 0], hidden: [], frozen: 1 })
    expect(loadColumnState('t:test', sig, 2)).toEqual({ order: [1, 0], hidden: [], frozen: 1 })
    expect(loadColumnState('t:test', 'other', 2)).toBeUndefined()
  })
})
