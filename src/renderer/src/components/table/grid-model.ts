// Projection of a fetched page + pending changes onto the rows handed to <DataGrid/>.
// Pending inserts come first (newest on top), then the page rows with their edits applied.
import type { CellValue, ColumnInfo, ColumnMeta, EditValue } from '@shared/types'
import type { RowState } from '@/components/grid/DataGrid'
import { columnKind } from '@/components/grid/column-types'
import {
  DEFAULT_VALUE,
  editCell,
  editInsertedCell,
  isDefaultValue,
  primaryKeyValues,
  rowKeyOf,
  sameNumericValue,
  type PendingChanges,
  type PendingInsert,
  type RowRef,
} from './pending-changes'

/** Placeholder shown (dimmed) in a pending insert's cell that will use the column default. */
export const DEFAULT_PLACEHOLDER = 'DEFAULT'

export interface PageLike {
  columns: ColumnMeta[]
  rows: CellValue[][]
  primaryKey: string[]
}

export interface GridRowInfo {
  ref: RowRef
  /** Index into page.rows for existing rows. */
  pageIndex?: number
  /** Stable React key. */
  key: string
}

export interface GridModel {
  rows: CellValue[][]
  info: GridRowInfo[]
}

function displayInsertValue(value: EditValue | undefined): CellValue {
  if (value === undefined || isDefaultValue(value)) return null
  return value
}

export function buildGridModel(page: PageLike, changes: PendingChanges): GridModel {
  const names = page.columns.map((c) => c.name)
  const rows: CellValue[][] = []
  const info: GridRowInfo[] = []

  for (let i = changes.inserts.length - 1; i >= 0; i--) {
    const insert = changes.inserts[i] as PendingInsert
    rows.push(names.map((name) => displayInsertValue(insert.values[name])))
    info.push({ ref: { kind: 'inserted', id: insert.id }, key: `ins:${insert.id}` })
  }

  page.rows.forEach((row, pageIndex) => {
    const key = primaryKeyValues(row, names, page.primaryKey)
    if (!key) {
      rows.push(row)
      info.push({ ref: { kind: 'existing', rowKey: `#${pageIndex}`, key: {} }, pageIndex, key: `idx:${pageIndex}` })
      return
    }
    const rowKey = rowKeyOf(key, page.primaryKey)
    const update = changes.updates[rowKey]
    rows.push(update ? names.map((name, c) => (name in update.cells ? (update.cells[name]?.value ?? null) : (row[c] ?? null))) : row)
    info.push({ ref: { kind: 'existing', rowKey, key }, pageIndex, key: `row:${rowKey}` })
  })

  return { rows, info }
}

export function rowStateOf(changes: PendingChanges, info: GridRowInfo | undefined): RowState | undefined {
  if (!info) return undefined
  const { ref } = info
  if (ref.kind === 'inserted') return 'inserted'
  if (ref.rowKey in changes.deletes) return 'deleted'
  if (ref.rowKey in changes.updates) return 'modified'
  return undefined
}

/** DEFAULT_PLACEHOLDER for a pending insert's cell that still uses the column default. */
export function cellPlaceholderIn(changes: PendingChanges, info: GridRowInfo | undefined, column: string | undefined): string | undefined {
  if (!info || column === undefined || info.ref.kind !== 'inserted') return undefined
  const id = info.ref.id
  const insert = changes.inserts.find((i) => i.id === id)
  if (!insert) return undefined
  const value = insert.values[column]
  return value === undefined || isDefaultValue(value) ? DEFAULT_PLACEHOLDER : undefined
}

export function isCellModifiedIn(changes: PendingChanges, info: GridRowInfo | undefined, column: string | undefined): boolean {
  if (!info || column === undefined) return false
  const { ref } = info
  if (ref.kind === 'inserted') {
    const insert = changes.inserts.find((i) => i.id === ref.id)
    return insert !== undefined && !isDefaultValue(insert.values[column])
  }
  return changes.updates[ref.rowKey]?.cells[column] !== undefined
}

/** Grid column indices that must never be edited: identity and generated columns. */
export function readOnlyColumnIndices(columns: readonly ColumnMeta[], details: readonly ColumnInfo[] | undefined): Set<number> {
  const locked = new Set<number>()
  if (!details) return locked
  const byName = new Map(details.map((c) => [c.name, c]))
  columns.forEach((column, index) => {
    const info = byName.get(column.name)
    if (info && (info.isIdentity || info.isGenerated)) locked.add(index)
  })
  return locked
}

/**
 * Values for "Duplicate row": the displayed values of the source row, except locked
 * (identity / generated) columns which stay DEFAULT.
 */
export function duplicateValues(
  model: GridModel,
  changes: PendingChanges,
  gridRow: number,
  columns: readonly ColumnMeta[],
  locked: ReadonlySet<number>,
): Record<string, EditValue> {
  const values: Record<string, EditValue> = {}
  const info = model.info[gridRow]
  const insert = info?.ref.kind === 'inserted' ? changes.inserts.find((i) => info.ref.kind === 'inserted' && i.id === info.ref.id) : undefined
  const row = model.rows[gridRow] ?? []
  columns.forEach((column, index) => {
    if (locked.has(index)) values[column.name] = DEFAULT_VALUE
    else if (insert) values[column.name] = insert.values[column.name] ?? DEFAULT_VALUE
    else values[column.name] = row[index] ?? null
  })
  return values
}

/** Sorted, de-duplicated grid rows covered by a selection or a context-menu row list. */
export function rowRange(a: number, b: number): number[] {
  const from = Math.min(a, b)
  const to = Math.max(a, b)
  return Array.from({ length: to - from + 1 }, (_, i) => from + i)
}

/** Apply a grid edit (source row/col of the model) to the pending changes. */
export function applyGridEdit(
  changes: PendingChanges,
  model: GridModel,
  page: PageLike,
  gridRow: number,
  col: number,
  value: CellValue,
): PendingChanges {
  const info = model.info[gridRow]
  const column = page.columns[col]?.name
  if (!info || column === undefined) return changes
  if (info.ref.kind === 'inserted') {
    return editInsertedCell(changes, info.ref.id, column, value)
  }
  if (info.pageIndex === undefined || page.primaryKey.length === 0) return changes
  const original = page.rows[info.pageIndex]?.[col] ?? null
  // '10.5' typed over a numeric '10.50' is the same value: back to the original, no pending change
  const numeric = columnKind(page.columns[col]?.dataType ?? '') === 'number'
  return editCell(changes, info.ref, column, original, numeric && sameNumericValue(original, value) ? original : value)
}
