// Selection model of the DataGrid, in VIEW coordinates (row = position after client-side sorting).
// One rectangular range between an anchor (the active cell) and a focus (the moving end).
import type { GridSelection } from './DataGrid'

export interface CellPos {
  row: number
  col: number
}

/** cells: a rectangle · rows: whole rows · columns: whole columns (grows with appended rows) · all. */
export type SelectionMode = 'cells' | 'rows' | 'columns' | 'all'

export interface Selection {
  anchor: CellPos
  focus: CellPos
  mode: SelectionMode
}

/** Inclusive bounds. */
export interface Rect {
  r0: number
  r1: number
  c0: number
  c1: number
}

export function cellSelection(pos: CellPos): Selection {
  return { anchor: pos, focus: pos, mode: 'cells' }
}

export function rowSelection(anchorRow: number, focusRow: number, activeCol = 0): Selection {
  return { anchor: { row: anchorRow, col: activeCol }, focus: { row: focusRow, col: activeCol }, mode: 'rows' }
}

export function columnSelection(anchorCol: number, focusCol: number, activeRow = 0): Selection {
  return { anchor: { row: activeRow, col: anchorCol }, focus: { row: activeRow, col: focusCol }, mode: 'columns' }
}

export function allSelection(active: CellPos = { row: 0, col: 0 }): Selection {
  return { anchor: active, focus: active, mode: 'all' }
}

export function selectionRect(sel: Selection | null, rowCount: number, colCount: number): Rect | null {
  if (!sel || colCount === 0) return null
  const lastRow = rowCount - 1
  const lastCol = colCount - 1
  switch (sel.mode) {
    case 'all':
      return rowCount === 0 ? null : { r0: 0, r1: lastRow, c0: 0, c1: lastCol }
    case 'rows':
      if (rowCount === 0) return null
      return { r0: clamp(Math.min(sel.anchor.row, sel.focus.row), 0, lastRow), r1: clamp(Math.max(sel.anchor.row, sel.focus.row), 0, lastRow), c0: 0, c1: lastCol }
    case 'columns':
      return {
        r0: 0,
        r1: Math.max(lastRow, 0),
        c0: clamp(Math.min(sel.anchor.col, sel.focus.col), 0, lastCol),
        c1: clamp(Math.max(sel.anchor.col, sel.focus.col), 0, lastCol),
      }
    case 'cells':
      if (rowCount === 0) return null
      return {
        r0: clamp(Math.min(sel.anchor.row, sel.focus.row), 0, lastRow),
        r1: clamp(Math.max(sel.anchor.row, sel.focus.row), 0, lastRow),
        c0: clamp(Math.min(sel.anchor.col, sel.focus.col), 0, lastCol),
        c1: clamp(Math.max(sel.anchor.col, sel.focus.col), 0, lastCol),
      }
  }
}

export function inRect(rect: Rect | null, row: number, col: number): boolean {
  return !!rect && row >= rect.r0 && row <= rect.r1 && col >= rect.c0 && col <= rect.c1
}

export function rectCellCount(rect: Rect | null): number {
  return rect ? (rect.r1 - rect.r0 + 1) * (rect.c1 - rect.c0 + 1) : 0
}

/** The selection covers whole columns (copy includes the header row). */
export function coversWholeColumns(sel: Selection | null): boolean {
  return sel?.mode === 'columns' || sel?.mode === 'all'
}

/** Keep positions inside the grid after rows or columns changed. */
export function clampSelection(sel: Selection | null, rowCount: number, colCount: number): Selection | null {
  if (!sel) return null
  if (colCount === 0) return null
  if (rowCount === 0 && sel.mode !== 'columns') return null
  const fix = (p: CellPos): CellPos => ({ row: clamp(p.row, 0, Math.max(rowCount - 1, 0)), col: clamp(p.col, 0, colCount - 1) })
  const anchor = fix(sel.anchor)
  const focus = fix(sel.focus)
  if (samePos(anchor, sel.anchor) && samePos(focus, sel.focus)) return sel
  return { ...sel, anchor, focus }
}

export function samePos(a: CellPos, b: CellPos): boolean {
  return a.row === b.row && a.col === b.col
}

export function sameSelection(a: Selection | null, b: Selection | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.mode === b.mode && samePos(a.anchor, b.anchor) && samePos(a.focus, b.focus)
}

/** Shift+click / drag: move the focus end, keeping whole-row / whole-column modes on their axis. */
export function extendTo(sel: Selection | null, pos: CellPos, mode?: SelectionMode): Selection {
  if (!sel) return { anchor: pos, focus: pos, mode: mode ?? 'cells' }
  const m = mode ?? (sel.mode === 'all' ? 'cells' : sel.mode)
  const anchor = sel.mode === 'all' && m === 'cells' ? { row: 0, col: 0 } : sel.anchor
  return { anchor, focus: pos, mode: m }
}

export type Move =
  | { kind: 'by'; dr: number; dc: number }
  /** Cmd/Ctrl+arrow: jump to the first / last row or column. */
  | { kind: 'edge'; dr: number; dc: number }
  | { kind: 'rowStart' }
  | { kind: 'rowEnd' }
  | { kind: 'first' }
  | { kind: 'last' }

function target(from: CellPos, move: Move, rowCount: number, colCount: number): CellPos {
  const lastRow = Math.max(rowCount - 1, 0)
  const lastCol = Math.max(colCount - 1, 0)
  switch (move.kind) {
    case 'by':
      return { row: clamp(from.row + move.dr, 0, lastRow), col: clamp(from.col + move.dc, 0, lastCol) }
    case 'edge':
      return {
        row: move.dr < 0 ? 0 : move.dr > 0 ? lastRow : from.row,
        col: move.dc < 0 ? 0 : move.dc > 0 ? lastCol : from.col,
      }
    case 'rowStart':
      return { row: from.row, col: 0 }
    case 'rowEnd':
      return { row: from.row, col: lastCol }
    case 'first':
      return { row: 0, col: 0 }
    case 'last':
      return { row: lastRow, col: lastCol }
  }
}

/**
 * Keyboard navigation. Without `extend` the active cell moves and the range collapses onto it;
 * with `extend` (shift) the focus end moves and the anchor stays.
 */
export function moveSelection(sel: Selection | null, move: Move, extend: boolean, rowCount: number, colCount: number): Selection | null {
  if (rowCount === 0 || colCount === 0) return null
  const current = sel ?? cellSelection({ row: 0, col: 0 })
  if (!sel && !extend) return current
  if (!extend) return cellSelection(target(current.anchor, move, rowCount, colCount))
  const focus = target(current.focus, move, rowCount, colCount)
  const vertical = move.kind === 'by' || move.kind === 'edge' ? move.dc === 0 : false
  const horizontal = move.kind === 'by' || move.kind === 'edge' ? move.dr === 0 : move.kind === 'rowStart' || move.kind === 'rowEnd'
  if (current.mode === 'rows' && vertical) return { ...current, focus }
  if (current.mode === 'columns' && horizontal) return { ...current, focus }
  if (current.mode === 'cells') return { ...current, focus }
  // switching axis out of a whole-row / column / all selection: continue as a rectangle
  const rect = selectionRect(current, rowCount, colCount)!
  const anchor = { row: rect.r0, col: rect.c0 }
  const corner = { row: rect.r1, col: rect.c1 }
  return { anchor, focus: target(corner, move, rowCount, colCount), mode: 'cells' }
}

/** Tab / Shift+Tab: next / previous cell, wrapping across rows. Null when leaving the grid. */
export function tabSelection(sel: Selection | null, backwards: boolean, rowCount: number, colCount: number): Selection | null {
  if (rowCount === 0 || colCount === 0) return null
  const from = sel?.anchor ?? { row: 0, col: backwards ? 0 : -1 }
  let { row, col } = from
  col += backwards ? -1 : 1
  if (col >= colCount) {
    col = 0
    row += 1
  } else if (col < 0) {
    col = colCount - 1
    row -= 1
  }
  if (row < 0 || row >= rowCount) return null
  return cellSelection({ row, col })
}

/** Selection reported to the parent: rows mapped to source indices through the view order. */
export function toGridSelection(sel: Selection | null, rowCount: number, colCount: number, sourceRow: (view: number) => number): GridSelection | null {
  const rect = selectionRect(sel, rowCount, colCount)
  if (!sel || !rect) return null
  const anchorView = sel.mode === 'columns' || sel.mode === 'all' ? rect.r0 : clamp(sel.anchor.row, rect.r0, rect.r1)
  const focusView = sel.mode === 'columns' || sel.mode === 'all' ? rect.r1 : clamp(sel.focus.row, rect.r0, rect.r1)
  const anchorCol = sel.mode === 'rows' || sel.mode === 'all' ? rect.c0 : sel.anchor.col
  const focusCol = sel.mode === 'rows' || sel.mode === 'all' ? rect.c1 : sel.focus.col
  return {
    anchor: { row: sourceRow(anchorView), col: anchorCol },
    focus: { row: sourceRow(focusView), col: focusCol },
  }
}

/** Source indices of the selected rows, in view order. */
export function selectedSourceRows(rect: Rect | null, sourceRow: (view: number) => number): number[] {
  if (!rect) return []
  const out: number[] = []
  for (let r = rect.r0; r <= rect.r1; r++) out.push(sourceRow(r))
  return out
}

function clamp(n: number, min: number, max: number): number {
  return n < min ? min : n > max ? max : n
}
