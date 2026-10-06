import { describe, expect, it } from 'vitest'
import {
  allSelection,
  cellSelection,
  clampSelection,
  columnSelection,
  coversWholeColumns,
  extendTo,
  inRect,
  moveSelection,
  rectCellCount,
  rowSelection,
  selectedSourceRows,
  selectionRect,
  tabSelection,
  toGridSelection,
} from './selection'

describe('selectionRect', () => {
  it('normalizes cell ranges in any direction', () => {
    const sel = { anchor: { row: 5, col: 3 }, focus: { row: 2, col: 1 }, mode: 'cells' as const }
    expect(selectionRect(sel, 10, 5)).toEqual({ r0: 2, r1: 5, c0: 1, c1: 3 })
  })
  it('expands whole rows, columns and all', () => {
    expect(selectionRect(rowSelection(4, 2), 10, 5)).toEqual({ r0: 2, r1: 4, c0: 0, c1: 4 })
    expect(selectionRect(columnSelection(3, 1), 10, 5)).toEqual({ r0: 0, r1: 9, c0: 1, c1: 3 })
    expect(selectionRect(allSelection(), 10, 5)).toEqual({ r0: 0, r1: 9, c0: 0, c1: 4 })
  })
  it('column selections grow with appended rows', () => {
    const sel = columnSelection(0, 0)
    expect(selectionRect(sel, 10, 2)!.r1).toBe(9)
    expect(selectionRect(sel, 500, 2)!.r1).toBe(499)
  })
  it('is null without columns or rows', () => {
    expect(selectionRect(cellSelection({ row: 0, col: 0 }), 0, 3)).toBeNull()
    expect(selectionRect(null, 3, 3)).toBeNull()
  })
})

describe('rect helpers', () => {
  it('tests membership and counts cells', () => {
    const rect = { r0: 1, r1: 2, c0: 0, c1: 2 }
    expect(inRect(rect, 1, 2)).toBe(true)
    expect(inRect(rect, 3, 0)).toBe(false)
    expect(rectCellCount(rect)).toBe(6)
    expect(rectCellCount(null)).toBe(0)
  })
  it('reports whole-column selections', () => {
    expect(coversWholeColumns(columnSelection(1, 2))).toBe(true)
    expect(coversWholeColumns(allSelection())).toBe(true)
    expect(coversWholeColumns(rowSelection(1, 2))).toBe(false)
  })
})

describe('moveSelection', () => {
  const start = cellSelection({ row: 2, col: 2 })
  it('moves and collapses without shift', () => {
    expect(moveSelection(start, { kind: 'by', dr: 1, dc: 0 }, false, 10, 5)).toEqual(cellSelection({ row: 3, col: 2 }))
    expect(moveSelection(start, { kind: 'by', dr: -5, dc: 9 }, false, 10, 5)).toEqual(cellSelection({ row: 0, col: 4 }))
  })
  it('extends the focus with shift and keeps the anchor', () => {
    const s = moveSelection(start, { kind: 'by', dr: 2, dc: 1 }, true, 10, 5)!
    expect(s.anchor).toEqual({ row: 2, col: 2 })
    expect(s.focus).toEqual({ row: 4, col: 3 })
    const s2 = moveSelection(s, { kind: 'by', dr: 1, dc: 0 }, true, 10, 5)!
    expect(s2.focus).toEqual({ row: 5, col: 3 })
  })
  it('jumps to edges, row ends and corners', () => {
    expect(moveSelection(start, { kind: 'edge', dr: 1, dc: 0 }, false, 10, 5)!.anchor).toEqual({ row: 9, col: 2 })
    expect(moveSelection(start, { kind: 'rowEnd' }, false, 10, 5)!.anchor).toEqual({ row: 2, col: 4 })
    expect(moveSelection(start, { kind: 'rowStart' }, false, 10, 5)!.anchor).toEqual({ row: 2, col: 0 })
    expect(moveSelection(start, { kind: 'last' }, false, 10, 5)!.anchor).toEqual({ row: 9, col: 4 })
    expect(moveSelection(start, { kind: 'first' }, true, 10, 5)).toEqual({ anchor: { row: 2, col: 2 }, focus: { row: 0, col: 0 }, mode: 'cells' })
  })
  it('keeps whole-row mode along its axis, becomes a rectangle otherwise', () => {
    const rows = rowSelection(3, 3)
    expect(moveSelection(rows, { kind: 'by', dr: 1, dc: 0 }, true, 10, 5)).toEqual({ ...rows, focus: { row: 4, col: 0 } })
    const across = moveSelection(rows, { kind: 'by', dr: 0, dc: -1 }, true, 10, 5)!
    expect(across.mode).toBe('cells')
    expect(selectionRect(across, 10, 5)).toEqual({ r0: 3, r1: 3, c0: 0, c1: 3 })
  })
  it('starts at the first cell when nothing is selected', () => {
    expect(moveSelection(null, { kind: 'by', dr: 1, dc: 0 }, false, 10, 5)).toEqual(cellSelection({ row: 0, col: 0 }))
    expect(moveSelection(null, { kind: 'by', dr: 1, dc: 0 }, false, 0, 5)).toBeNull()
  })
})

describe('tabSelection', () => {
  it('wraps across rows and leaves the grid at the ends', () => {
    expect(tabSelection(cellSelection({ row: 0, col: 4 }), false, 3, 5)).toEqual(cellSelection({ row: 1, col: 0 }))
    expect(tabSelection(cellSelection({ row: 1, col: 0 }), true, 3, 5)).toEqual(cellSelection({ row: 0, col: 4 }))
    expect(tabSelection(cellSelection({ row: 2, col: 4 }), false, 3, 5)).toBeNull()
    expect(tabSelection(cellSelection({ row: 0, col: 0 }), true, 3, 5)).toBeNull()
    expect(tabSelection(null, false, 3, 5)).toEqual(cellSelection({ row: 0, col: 0 }))
  })
})

describe('extendTo', () => {
  it('keeps the anchor and the mode', () => {
    expect(extendTo(rowSelection(2, 2), { row: 6, col: 0 })).toEqual({ anchor: { row: 2, col: 0 }, focus: { row: 6, col: 0 }, mode: 'rows' })
    expect(extendTo(null, { row: 1, col: 1 })).toEqual(cellSelection({ row: 1, col: 1 }))
  })
})

describe('clampSelection', () => {
  it('pulls positions back inside after rows shrink', () => {
    const sel = { anchor: { row: 8, col: 1 }, focus: { row: 9, col: 6 }, mode: 'cells' as const }
    expect(clampSelection(sel, 5, 3)).toEqual({ anchor: { row: 4, col: 1 }, focus: { row: 4, col: 2 }, mode: 'cells' })
    expect(clampSelection(sel, 0, 3)).toBeNull()
    const same = cellSelection({ row: 1, col: 1 })
    expect(clampSelection(same, 5, 3)).toBe(same)
  })
})

describe('source mapping', () => {
  const order = [3, 0, 2, 1]
  const sourceRow = (v: number) => order[v]!
  it('maps view rows through the sort order', () => {
    const sel = { anchor: { row: 0, col: 1 }, focus: { row: 2, col: 0 }, mode: 'cells' as const }
    expect(toGridSelection(sel, 4, 2, sourceRow)).toEqual({ anchor: { row: 3, col: 1 }, focus: { row: 2, col: 0 } })
    expect(selectedSourceRows(selectionRect(sel, 4, 2), sourceRow)).toEqual([3, 0, 2])
  })
  it('reports whole columns as full row spans', () => {
    expect(toGridSelection(columnSelection(1, 1), 4, 2, sourceRow)).toEqual({ anchor: { row: 3, col: 1 }, focus: { row: 1, col: 1 } })
  })
})
