// In-place editing of console results: when a SELECT reads one table whose primary key columns are
// all in the result, its cells can be edited (and rows deleted) like in the table editor. Edits are
// pending until submitted in one transaction through data:applyChanges, with the key values of the
// edited rows. Submitted values are kept as an overlay on the (immutable) console result.
import { classifyStatement } from '@shared/sql'
import type { CellValue, ConnectionConfig, Dialect, StatementResult, TableDetails, TableRef } from '@shared/types'
import { commitOpenCellEditor } from '@/components/grid/edit-session'
import {
  EMPTY_CHANGES,
  changeCount,
  describeSummary,
  summarize,
  toRowChanges,
  type PendingChanges,
} from '@/components/table/pending-changes'
import { toast } from '@/components/ui'
import { api, errorInfo } from '@/lib/api'
import { pluralize } from '@/lib/format'
import { useSettings } from '@/stores/settings'
import { useUi } from '@/stores/ui'
import { inferTableName, shortName } from './result-meta'
import { useResultViews, type ResultViewState } from './result-view-state'

export interface EditTarget {
  schema: string
  name: string
  primaryKey: string[]
  /** Result column indices that cannot be edited (other tables, expressions, identity…). */
  readOnlyColumns: Set<number>
}

export type EditCheck = { ok: true; target: EditTarget } | { ok: false; reason: string }

/** Table a result's rows can be edited in, from the statement (schema defaults to the console's). */
export function editableTable(result: Pick<StatementResult, 'columns' | 'sql' | 'kind'>, defaultSchema: string): { schema: string; name: string } | undefined {
  if (result.kind !== 'rows') return undefined
  const table = inferTableName(result)
  if (!table) return undefined
  const parts = table.split('.')
  if (parts.length > 2) return undefined
  return parts.length === 2 ? { schema: parts[0]!, name: parts[1]! } : { schema: defaultSchema, name: parts[0]! }
}

/**
 * Whether the result can be edited in `details`' table, and which columns. Requirements: a read-only
 * statement (a SELECT), a base table with a primary key whose columns are all in the result (once
 * each), and a connection that allows writes.
 */
export function checkEditable(
  result: Pick<StatementResult, 'columns' | 'sql' | 'kind'>,
  details: TableDetails | undefined,
  connection: Pick<ConnectionConfig, 'readOnly'> | undefined,
  dialect: Dialect,
): EditCheck {
  if (result.kind !== 'rows') return { ok: false, reason: 'Not a row result.' }
  if (connection?.readOnly) return { ok: false, reason: 'The connection is read-only.' }
  try {
    if (!classifyStatement(result.sql, dialect).readOnly) return { ok: false, reason: 'Only the rows of a SELECT can be edited.' }
  } catch {
    return { ok: false, reason: 'Only the rows of a SELECT can be edited.' }
  }
  if (!details) return { ok: false, reason: 'The source table is unknown.' }
  if (details.kind !== 'table') return { ok: false, reason: `${details.name} is not a table.` }
  if (details.primaryKey.length === 0) return { ok: false, reason: `${details.name} has no primary key.` }
  const names = result.columns.map((c) => c.name)
  const count = (name: string) => names.filter((n) => n === name).length
  // PostgreSQL reports each column's source table: expressions and joined tables have another one.
  const fromTable = (i: number) => {
    const t = result.columns[i]?.table
    if (dialect === 'postgres') return t !== undefined && shortName(t) === details.name
    return t === undefined || shortName(t) === details.name
  }
  for (const key of details.primaryKey) {
    const index = names.indexOf(key)
    if (index < 0 || count(key) !== 1 || !fromTable(index)) return { ok: false, reason: `Select the primary key (${details.primaryKey.join(', ')}) to edit these rows.` }
  }
  const info = new Map(details.columns.map((c) => [c.name, c]))
  const readOnlyColumns = new Set<number>()
  result.columns.forEach((c, i) => {
    const column = info.get(c.name)
    if (!column || count(c.name) !== 1 || !fromTable(i) || column.isGenerated || column.isIdentity) readOnlyColumns.add(i)
  })
  return { ok: true, target: { schema: details.schema, name: details.name, primaryKey: details.primaryKey, readOnlyColumns } }
}

/** Result rows with the submitted values applied and the deleted rows left out. */
export function displayRows(
  rows: readonly CellValue[][],
  view: Pick<ResultViewState, 'applied' | 'removed'>,
  keyOf: (row: readonly CellValue[]) => string | null,
  columns: readonly string[],
): CellValue[][] {
  const applied = view.applied
  const removed = view.removed
  if (!applied && !removed) return rows as CellValue[][]
  const out: CellValue[][] = []
  for (const row of rows) {
    const key = keyOf(row)
    if (key !== null && removed?.includes(key)) continue
    const patch = key === null ? undefined : applied?.[key]
    out.push(patch ? columns.map((name, i) => (name in patch ? (patch[name] ?? null) : (row[i] ?? null))) : row)
  }
  return out
}

/** Submit the pending changes of a result; on success they become the overlay of its rows. */
export async function submitResultChanges(
  key: string,
  table: TableRef,
  connection: Pick<ConnectionConfig, 'name' | 'productionGuard'> | undefined,
): Promise<void> {
  // a value still being typed in a cell is part of the submit
  commitOpenCellEditor()
  const store = useResultViews.getState()
  const view = store.views[key]
  const changes = view?.changes ?? EMPTY_CHANGES
  const count = changeCount(changes)
  if (!view || view.submitting || count === 0) return
  const summary = summarize(changes)
  const qualified = `${table.schema}.${table.name}`
  if (summary.deletes > 0 && connection?.productionGuard && useSettings.getState().settings.confirmDestructive) {
    const ok = await useUi.getState().confirm({
      title: `Delete ${pluralize(summary.deletes, 'row')} from ${qualified}?`,
      message: `${connection.name} is flagged as production. The changes run in a single transaction.`,
      confirmLabel: `Submit ${pluralize(count, 'change')}`,
      danger: true,
    })
    if (!ok) return
  }
  store.patch(key, { submitting: true, submitError: undefined })
  try {
    const result = await api.data.applyChanges(table, toRowChanges(changes))
    const latest = useResultViews.getState().views[key] ?? view
    const applied = { ...(latest.applied ?? {}) }
    for (const [rowKey, update] of Object.entries(changes.updates)) {
      if (rowKey in changes.deletes) continue
      const values: Record<string, CellValue> = { ...(applied[rowKey] ?? {}) }
      for (const [column, cell] of Object.entries(update.cells)) values[column] = cell.value
      applied[rowKey] = values
    }
    const removed = [...new Set([...(latest.removed ?? []), ...Object.keys(changes.deletes)])]
    useResultViews.getState().patch(key, { submitting: false, changes: EMPTY_CHANGES, applied, removed })
    toast.success(`${pluralize(count, 'change')} applied`, { description: `${pluralize(result.affected, 'row')} affected in ${qualified}` })
  } catch (error) {
    useResultViews.getState().patch(key, { submitting: false, submitError: errorInfo(error) })
  }
}

export function describeChanges(changes: PendingChanges): string {
  return describeSummary(summarize(changes))
}
