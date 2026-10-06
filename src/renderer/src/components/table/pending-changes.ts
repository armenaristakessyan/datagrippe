// Pending edits of the table data editor (pure, immutable). Existing rows are identified by a
// stable key built from their primary-key values, so edits survive a refetch of the same page.
import type { CellValue, DefaultValue, EditValue, RowChange } from '@shared/types'
import { compareDecimalStrings } from '@/components/grid/sort'

/** JSON of the primary-key values, in key order. */
export type RowKey = string

export const DEFAULT_VALUE: DefaultValue = { $default: true }

export function isDefaultValue(value: EditValue | undefined): value is DefaultValue {
  return typeof value === 'object' && value !== null && value.$default === true
}

export interface CellChange {
  original: CellValue
  value: CellValue
}

export interface RowUpdate {
  /** Primary-key values of the row as last fetched (used in the UPDATE's WHERE). */
  key: Record<string, CellValue>
  /** Changed columns only. */
  cells: Record<string, CellChange>
}

export interface PendingInsert {
  id: string
  /** Every column of the table; unedited ones hold DEFAULT_VALUE. */
  values: Record<string, EditValue>
}

export interface PendingChanges {
  updates: Record<RowKey, RowUpdate>
  /** Creation order (oldest first). */
  inserts: PendingInsert[]
  /** Row key → primary-key values. */
  deletes: Record<RowKey, Record<string, CellValue>>
}

export const EMPTY_CHANGES: PendingChanges = { updates: {}, inserts: [], deletes: {} }

export interface ExistingRowRef {
  kind: 'existing'
  rowKey: RowKey
  key: Record<string, CellValue>
}

export interface InsertedRowRef {
  kind: 'inserted'
  id: string
}

export type RowRef = ExistingRowRef | InsertedRowRef

export function rowKeyOf(key: Record<string, CellValue>, primaryKey: readonly string[]): RowKey {
  return JSON.stringify(primaryKey.map((column) => key[column] ?? null))
}

/** Primary-key values of a fetched row, or null when a key column is missing from the result. */
export function primaryKeyValues(
  row: readonly CellValue[],
  columns: readonly string[],
  primaryKey: readonly string[],
): Record<string, CellValue> | null {
  if (primaryKey.length === 0) return null
  const key: Record<string, CellValue> = {}
  for (const column of primaryKey) {
    const index = columns.indexOf(column)
    if (index < 0) return null
    key[column] = row[index] ?? null
  }
  return key
}

/**
 * Grid editors may hand back text for a numeric/boolean cell; "5" typed over 5 is not a change.
 * NULL only equals NULL.
 */
export function sameValue(a: CellValue, b: CellValue): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  return String(a) === String(b)
}

const DECIMAL_TEXT = /^[-+]?(\d+(\.\d*)?|\.\d+)$/

/**
 * Same number for a numeric column: PostgreSQL numerics arrive as text ('10.50'), so '10.5' typed
 * over it is not a change. Plain decimal text only (no exponent); compared exactly, never as doubles.
 */
export function sameNumericValue(a: CellValue, b: CellValue): boolean {
  if (a === null || b === null || typeof a === 'boolean' || typeof b === 'boolean') return false
  const ta = String(a).trim()
  const tb = String(b).trim()
  if (!DECIMAL_TEXT.test(ta) || !DECIMAL_TEXT.test(tb)) return false
  return compareDecimalStrings(ta, tb) === 0
}

export function hasChanges(changes: PendingChanges): boolean {
  return changeCount(changes) > 0
}

/** Number of row-level changes that a submit would send. */
export function changeCount(changes: PendingChanges): number {
  const deleted = Object.keys(changes.deletes)
  const updates = Object.keys(changes.updates).filter((k) => !(k in changes.deletes)).length
  return updates + deleted.length + changes.inserts.length
}

export function isDeleted(changes: PendingChanges, rowKey: RowKey): boolean {
  return rowKey in changes.deletes
}

/**
 * Set a cell of an existing row. `original` is the value as fetched; editing back to it removes the
 * cell change (and the row update once no cell is left). Deleted rows are not editable.
 */
export function editCell(
  changes: PendingChanges,
  row: ExistingRowRef,
  column: string,
  original: CellValue,
  value: CellValue,
): PendingChanges {
  if (isDeleted(changes, row.rowKey)) return changes
  const current = changes.updates[row.rowKey]
  const baseline = current?.cells[column]?.original ?? original
  const cells = { ...current?.cells }
  if (sameValue(baseline, value)) {
    if (!(column in cells)) return changes
    delete cells[column]
  } else {
    if (cells[column] && cells[column].value === value) return changes
    cells[column] = { original: baseline, value }
  }
  const updates = { ...changes.updates }
  if (Object.keys(cells).length === 0) delete updates[row.rowKey]
  else updates[row.rowKey] = { key: current?.key ?? row.key, cells }
  return { ...changes, updates }
}

export function addInsert(changes: PendingChanges, insert: PendingInsert): PendingChanges {
  return { ...changes, inserts: [...changes.inserts, insert] }
}

/** New insert with every column set to DEFAULT, then `values` applied. */
export function newInsert(id: string, columns: readonly string[], values: Record<string, EditValue> = {}): PendingInsert {
  const row: Record<string, EditValue> = {}
  for (const column of columns) row[column] = column in values ? (values[column] ?? null) : DEFAULT_VALUE
  return { id, values: row }
}

export function editInsertedCell(changes: PendingChanges, id: string, column: string, value: EditValue): PendingChanges {
  const index = changes.inserts.findIndex((i) => i.id === id)
  const insert = changes.inserts[index]
  if (!insert) return changes
  const current = insert.values[column]
  if (isDefaultValue(value) ? isDefaultValue(current) : !isDefaultValue(current) && current === value) return changes
  const inserts = [...changes.inserts]
  inserts[index] = { ...insert, values: { ...insert.values, [column]: value } }
  return { ...changes, inserts }
}

/** Mark rows for deletion. Deleting a pending insert simply drops it. */
export function deleteRows(changes: PendingChanges, rows: readonly RowRef[]): PendingChanges {
  if (rows.length === 0) return changes
  const dropped = new Set(rows.filter((r): r is InsertedRowRef => r.kind === 'inserted').map((r) => r.id))
  const deletes = { ...changes.deletes }
  for (const row of rows) {
    if (row.kind !== 'existing') continue
    // Keep the key the row was fetched with, even if its PK cells were edited.
    deletes[row.rowKey] = changes.updates[row.rowKey]?.key ?? row.key
  }
  return { ...changes, deletes, inserts: changes.inserts.filter((i) => !dropped.has(i.id)) }
}

/** Drop every pending change (update, delete, insert) of the given rows. */
export function revertRows(changes: PendingChanges, rows: readonly RowRef[]): PendingChanges {
  if (rows.length === 0) return changes
  const updates = { ...changes.updates }
  const deletes = { ...changes.deletes }
  const dropped = new Set<string>()
  for (const row of rows) {
    if (row.kind === 'inserted') dropped.add(row.id)
    else {
      delete updates[row.rowKey]
      delete deletes[row.rowKey]
    }
  }
  return { updates, deletes, inserts: changes.inserts.filter((i) => !dropped.has(i.id)) }
}

/** Whether any of the rows has something to revert. */
export function rowsHaveChanges(changes: PendingChanges, rows: readonly RowRef[]): boolean {
  return rows.some((row) =>
    row.kind === 'inserted'
      ? changes.inserts.some((i) => i.id === row.id)
      : row.rowKey in changes.updates || row.rowKey in changes.deletes,
  )
}

/**
 * RowChange[] for data:applyChanges: deletes first (frees unique values), then updates, then inserts
 * in creation order. Updates of rows that are also deleted are dropped.
 */
export function toRowChanges(changes: PendingChanges): RowChange[] {
  const out: RowChange[] = []
  for (const key of Object.values(changes.deletes)) out.push({ type: 'delete', key: { ...key } })
  for (const [rowKey, update] of Object.entries(changes.updates)) {
    if (rowKey in changes.deletes) continue
    const values: Record<string, CellValue> = {}
    for (const [column, cell] of Object.entries(update.cells)) values[column] = cell.value
    out.push({ type: 'update', key: { ...update.key }, values })
  }
  for (const insert of changes.inserts) out.push({ type: 'insert', values: { ...insert.values } })
  return out
}

export interface ChangeSummary {
  updates: number
  inserts: number
  deletes: number
}

export function summarize(changes: PendingChanges): ChangeSummary {
  const deletes = Object.keys(changes.deletes).length
  const updates = Object.keys(changes.updates).filter((k) => !(k in changes.deletes)).length
  return { updates, inserts: changes.inserts.length, deletes }
}

/** "2 updates, 1 insert, 3 deletes". */
export function describeSummary(summary: ChangeSummary): string {
  const parts: string[] = []
  const part = (n: number, word: string) => {
    if (n > 0) parts.push(`${n} ${word}${n === 1 ? '' : 's'}`)
  }
  part(summary.updates, 'update')
  part(summary.inserts, 'insert')
  part(summary.deletes, 'delete')
  return parts.join(', ')
}
