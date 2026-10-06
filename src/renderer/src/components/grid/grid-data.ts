// Layout constants and pure helpers shared by the DataGrid parts.
import type { CellValue, ColumnMeta } from '@shared/types'
import type { ColumnKind } from './column-types'
import type { Rect } from './selection'

export const ROW_HEIGHT = 24
export const HEADER_HEIGHT = 38
/** Rows from the end at which onLoadMore fires. */
export const LOAD_MORE_THRESHOLD = 100
/** Cells touched by bulk actions (Set NULL) at most. */
export const BULK_EDIT_LIMIT = 10_000

export function gutterWidth(rowCount: number): number {
  const digits = String(Math.max(rowCount, 1)).length
  return Math.max(44, Math.ceil(digits * 7 + 24))
}

/** Prefix sums: offsets[i] = left of column i, offsets[n] = total width. */
export function columnOffsets(widths: readonly number[]): number[] {
  const out = new Array<number>(widths.length + 1)
  out[0] = 0
  for (let i = 0; i < widths.length; i++) out[i + 1] = out[i]! + widths[i]!
  return out
}

/** Column under content x (0 = left of the first column); clamped to the existing columns. */
export function columnAt(offsets: readonly number[], x: number): number {
  const n = offsets.length - 1
  if (n <= 0) return -1
  if (x <= 0) return 0
  if (x >= offsets[n]!) return n - 1
  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (offsets[mid]! <= x) lo = mid
    else hi = mid - 1
  }
  return lo
}

export interface TableSlice {
  columns: ColumnMeta[]
  rows: CellValue[][]
}

/**
 * The selected rectangle as a small table (rows and columns in view order). `sourceCol` maps view
 * columns to source columns (identity by default).
 */
export function sliceRect(
  rect: Rect,
  columns: readonly ColumnMeta[],
  rows: readonly CellValue[][],
  sourceRow: (view: number) => number,
  sourceCol: (view: number) => number = (c) => c,
): TableSlice {
  const picked: number[] = []
  for (let c = rect.c0; c <= rect.c1; c++) picked.push(sourceCol(c))
  const cols = picked.flatMap((c) => (columns[c] ? [columns[c]] : []))
  const out: CellValue[][] = []
  for (let r = rect.r0; r <= rect.r1; r++) {
    const row = rows[sourceRow(r)]
    if (!row) continue
    out.push(picked.map((c) => row[c] ?? null))
  }
  return { columns: cols, rows: out }
}

/** "id, name, total" — for "Copy column names". */
export function columnNames(columns: readonly ColumnMeta[]): string {
  return columns.map((c) => c.name).join(', ')
}

/**
 * Column geometry shared by the header and the rows (memoized: identity changes only on resize).
 * Indexed by VIEW column (display order, hidden columns left out).
 */
export interface GridLayout {
  widths: readonly number[]
  offsets: readonly number[]
  kinds: readonly ColumnKind[]
  /** Right-aligned numeric columns. */
  numeric: readonly boolean[]
  /** View column → index into the row / the `columns` prop. */
  source: readonly number[]
  /** Leading view columns pinned while scrolling horizontally. */
  frozen: number
  gutter: number
  totalWidth: number
}
