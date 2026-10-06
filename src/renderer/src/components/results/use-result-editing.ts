// Hook gluing a console result to in-place editing: the table it can be edited in, the rows shown
// (submitted values applied), the grid model with the pending changes, and the edit actions.
import { useEffect, useMemo } from 'react'
import type { CellValue, Dialect, StatementResult, TableRef } from '@shared/types'
import type { GridCellEdit } from '@/components/grid/DataGrid'
import { applyGridEdit, buildGridModel, type GridModel } from '@/components/table/grid-model'
import {
  EMPTY_CHANGES,
  changeCount,
  deleteRows,
  primaryKeyValues,
  revertRows,
  rowKeyOf,
  type PendingChanges,
  type RowRef,
} from '@/components/table/pending-changes'
import { useConnections } from '@/stores/connections'
import { objectKey, useExplorer } from '@/stores/explorer'
import { useTabs, type ConsoleTab } from '@/stores/tabs'
import { checkEditable, displayRows, editableTable, type EditTarget } from './result-editing'
import { useResultView, useResultViews, type ResultViewState } from './result-view-state'

export interface ResultEditing {
  /** Set when the rows can be edited. */
  target?: EditTarget
  table?: TableRef
  /** Rows to show / export (submitted values applied, submitted deletes left out). */
  rows: CellValue[][]
  /** Grid model with the pending changes (when editable). */
  model: GridModel | null
  changes: PendingChanges
  pending: number
  view: ResultViewState
  edit: (edits: readonly GridCellEdit[]) => void
  remove: (rows: readonly number[]) => void
  revert: (rows: readonly number[]) => void
  refsOf: (rows: readonly number[]) => RowRef[]
}

export function useResultEditing(tabId: string, result: StatementResult, viewKey: string, dialect: Dialect | undefined): ResultEditing {
  const tab = useTabs((s) => s.tabs.find((t): t is ConsoleTab => t.id === tabId && t.kind === 'console'))
  const connection = useConnections((s) => s.connections.find((c) => c.id === tab?.connectionId))
  const view = useResultView(viewKey)
  const d = dialect ?? connection?.dialect ?? 'postgres'
  const database = tab?.database ?? connection?.database ?? ''
  const defaultSchema = tab?.schema ?? (d === 'mssql' ? 'dbo' : 'public')
  const source = useMemo(() => editableTable(result, defaultSchema), [result, defaultSchema])
  const detailsKey = source && connection ? objectKey(connection.id, database, source.schema, source.name) : undefined
  const details = useExplorer((s) => (detailsKey ? s.details[detailsKey] : undefined))

  useEffect(() => {
    if (!source || !connection || details) return
    void useExplorer.getState().loadDetails(connection.id, database, source.schema, source.name)
  }, [source, connection, database, details])

  const check = useMemo(() => checkEditable(result, details?.data, connection, d), [result, details?.data, connection, d])
  const target = check.ok ? check.target : undefined
  const table = target && connection ? { connectionId: connection.id, database, schema: target.schema, name: target.name } : undefined

  const names = useMemo(() => result.columns.map((c) => c.name), [result.columns])
  const rows = useMemo(() => {
    if (!target) return result.rows
    const keyOf = (row: readonly CellValue[]) => {
      const key = primaryKeyValues(row, names, target.primaryKey)
      return key ? rowKeyOf(key, target.primaryKey) : null
    }
    return displayRows(result.rows, view, keyOf, names)
  }, [target, result.rows, view.applied, view.removed, names])

  const changes = view.changes ?? EMPTY_CHANGES
  const page = useMemo(() => (target ? { columns: result.columns, rows, primaryKey: target.primaryKey } : null), [target, result.columns, rows])
  const model = useMemo(() => (page ? buildGridModel(page, changes) : null), [page, changes])

  const update = (fn: (c: PendingChanges) => PendingChanges) => {
    const store = useResultViews.getState()
    const current = store.views[viewKey]?.changes ?? EMPTY_CHANGES
    store.patch(viewKey, { changes: fn(current), submitError: undefined })
  }
  const refsOf = (list: readonly number[]): RowRef[] => list.flatMap((r) => (model?.info[r] ? [model.info[r]!.ref] : []))

  return {
    target,
    table,
    rows,
    model,
    changes,
    pending: changeCount(changes),
    view,
    edit: (edits) => {
      if (!page) return
      update((c) => {
        const m = buildGridModel(page, c)
        return edits.reduce((acc, e) => applyGridEdit(acc, m, page, e.row, e.col, e.value), c)
      })
    },
    remove: (list) => update((c) => deleteRows(c, refsOf(list))),
    revert: (list) => update((c) => (list.length === 0 ? EMPTY_CHANGES : revertRows(c, refsOf(list)))),
    refsOf,
  }
}
