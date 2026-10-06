// Table data editor tab: paged, filtered, sorted rows with inline editing and a pending-changes
// model submitted in one transaction.
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CopyPlus,
  FileCode2,
  FileUp,
  GitFork,
  Link2,
  Lock,
  Plus,
  RefreshCw,
  RotateCcw,
  Rows3,
  SearchX,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  Undo2,
  Upload,
} from 'lucide-react'
import type { CellValue, DbErrorInfo } from '@shared/types'
import { DataGrid, type GridCellEdit, type GridMenuContext, type GridMenuItem, type GridSelection } from '@/components/grid/DataGrid'
import {
  Button,
  Callout,
  EmptyState,
  IconButton,
  ProgressBar,
  Spinner,
  SqlText,
  Toolbar,
  ToolbarGroup,
  ToolbarSeparator,
  ToolbarSpacer,
  Tooltip,
  toast,
} from '@/components/ui'
import { registerCommands } from '@/lib/commands'
import { cn } from '@/lib/cn'
import { pluralize } from '@/lib/format'
import { uid } from '@/lib/id'
import { connectionById, useConnections } from '@/stores/connections'
import { objectKey, useExplorer } from '@/stores/explorer'
import { useSettings } from '@/stores/settings'
import type { TableTab } from '@/stores/tabs'
import { ErrorDetail } from './ErrorDetail'
import { importCsvInto } from './ImportCsvDialog'
import { FilterInput, SortChips } from './FilterBar'
import { GridSkeleton } from './GridSkeleton'
import { PagerBar } from './PagerBar'
import { knownTotal } from './paging'
import { PreviewChangesDialog } from './PreviewChangesDialog'
import { ViewSwitch } from './ViewSwitch'
import { filterPlaceholder } from './filter-placeholder'
import { combineWhere, foreignKeyLabels, referencedRows, referencingRows, valuePredicate, type RowLink } from './row-filters'
import {
  applyGridEdit,
  buildGridModel,
  duplicateValues,
  cellPlaceholderIn,
  isCellModifiedIn,
  readOnlyColumnIndices,
  rowRange,
  rowStateOf,
} from './grid-model'
import {
  DEFAULT_VALUE,
  EMPTY_CHANGES,
  addInsert,
  changeCount,
  deleteRows,
  describeSummary,
  editInsertedCell,
  hasChanges,
  newInsert,
  revertRows,
  rowsHaveChanges,
  summarize,
  type PendingChanges,
  type RowRef,
} from './pending-changes'
import {
  applyFilter,
  countRows,
  goToOffset,
  loadPage,
  cancelLoad,
  openSibling,
  tableRefOf,
  openTableFiltered,
  openSqlInConsole,
  refresh,
  setPageSize,
  setSort,
  submitChanges,
  tableKeyOf,
} from './table-actions'
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZES,
  clearRecentFilters,
  flipSort,
  initialSession,
  patchSession,
  removeSort,
  useTableSessions,
} from './table-session'

const FALLBACK_SESSION = initialSession()
const NO_FILTERS: string[] = []

export function TableDataView({ tab }: { tab: TableTab }) {
  const session = useTableSessions((s) => s.sessions[tab.id]) ?? FALLBACK_SESSION
  const recent = useTableSessions((s) => s.recentFilters[tableKeyOf(tab)]) ?? NO_FILTERS
  const details = useExplorer((s) => s.details[objectKey(tab.connectionId, tab.database, tab.table.schema, tab.table.name)])
  const nullDisplay = useSettings((s) => s.settings.nullDisplay)
  const showRowNumbers = useSettings((s) => s.settings.gridRowNumbers)
  const dialect = useConnections((s) => s.connections.find((c) => c.id === tab.connectionId)?.dialect)
  const [selection, setSelection] = useState<GridSelection | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const filterRef = useRef<HTMLInputElement>(null)

  const { page, changes } = session

  useEffect(() => {
    const existing = useTableSessions.getState().sessions[tab.id]
    if (!existing) {
      const maxRows = useSettings.getState().settings.maxRows
      const size = PAGE_SIZES.find((n) => n === maxRows) ?? DEFAULT_PAGE_SIZE
      patchSession(tab.id, initialSession(size))
    }
    if (!existing?.page && !existing?.loading) void loadPage(tab)
    void useExplorer.getState().loadDetails(tab.connectionId, tab.database, tab.table.schema, tab.table.name)
    // The tab object only changes identity on rename; the id identifies the table.
  }, [tab.id])

  const model = useMemo(() => (page ? buildGridModel(page, changes) : null), [page, changes])
  const locked = useMemo(() => readOnlyColumnIndices(page?.columns ?? [], details?.data?.columns), [page?.columns, details?.data?.columns])
  const editable = page?.editable === true
  const primaryKeyColumns = useMemo(
    () => new Set((page?.columns ?? []).flatMap((c, i) => (page?.primaryKey.includes(c.name) ? [i] : []))),
    [page?.columns, page?.primaryKey],
  )
  const busy = session.loading || session.submitting
  const pending = changeCount(changes)
  const summary = describeSummary(summarize(changes))
  const qualified = `${tab.table.schema}.${tab.table.name}`

  const selectedRows = useMemo(() => {
    if (!selection || !model) return []
    // the grid lists the rows when they are not a contiguous range (find: only matching rows)
    return (selection.rows ?? rowRange(selection.anchor.row, selection.focus.row)).filter((r) => r < model.rows.length)
  }, [selection, model])

  const refsOf = (rows: readonly number[]): RowRef[] =>
    rows.flatMap((r) => {
      const ref = model?.info[r]?.ref
      return ref ? [ref] : []
    })

  const updateChanges = (fn: (c: PendingChanges) => PendingChanges) => patchSession(tab.id, (s) => ({ changes: fn(s.changes) }))

  const columnNames = page?.columns.map((c) => c.name) ?? []

  const addRow = () => {
    if (!editable) return
    updateChanges((c) => addInsert(c, newInsert(uid('ins'), columnNames)))
  }

  const duplicateRows = (rows: readonly number[]) => {
    if (!editable || !model || !page || rows.length === 0) return
    const copies = rows.map((r) => duplicateValues(model, changes, r, page.columns, locked))
    updateChanges((c) => copies.reduce((acc, values) => addInsert(acc, newInsert(uid('ins'), columnNames, values)), c))
  }

  const deleteGridRows = (rows: readonly number[]) => {
    if (!editable || rows.length === 0) return
    updateChanges((c) => deleteRows(c, refsOf(rows)))
  }

  const revert = (rows: readonly number[]) => {
    const before = changes
    const refs = refsOf(rows)
    const scoped = refs.length > 0 && rowsHaveChanges(before, refs)
    const after = scoped ? revertRows(before, refs) : EMPTY_CHANGES
    const reverted = changeCount(before) - changeCount(after)
    if (reverted <= 0) return
    patchSession(tab.id, { changes: after, submitError: undefined })
    toast.message(`Reverted ${pluralize(reverted, 'change')}`, {
      action: { label: 'Undo', onClick: () => patchSession(tab.id, { changes: before }) },
    })
  }

  /** Reset the selected cells of pending inserts to DEFAULT (other rows are left alone). */
  const setDefault = (rows: readonly number[], columns: readonly number[]) => {
    if (!editable || !page) return
    const cols = columns.filter((c) => !locked.has(c))
    updateChanges((c) => {
      const m = buildGridModel(page, c)
      let next = c
      for (const r of rows) {
        const info = m.info[r]
        if (!info) continue
        for (const col of cols) {
          const name = page.columns[col]?.name
          if (name === undefined) continue
          if (info.ref.kind === 'inserted') next = editInsertedCell(next, info.ref.id, name, DEFAULT_VALUE)
        }
      }
      return next
    })
  }

  const onCellEdit = (row: number, col: number, value: CellValue) => {
    if (!editable || !page) return
    updateChanges((c) => applyGridEdit(c, buildGridModel(page, c), page, row, col, value))
  }

  /** Paste / Set NULL: many cells in one update (cell edits never add or remove model rows). */
  const onCellsEdit = (edits: readonly GridCellEdit[]) => {
    if (!editable || !page || edits.length === 0) return
    updateChanges((c) => {
      const m = buildGridModel(page, c)
      return edits.reduce((acc, e) => applyGridEdit(acc, m, page, e.row, e.col, e.value), c)
    })
  }

  /** A paste past the last row adds pending inserts (cells not pasted keep their DEFAULT). */
  const onPasteRows = (pasted: readonly (CellValue | undefined)[][]) => {
    if (!editable || !page) return
    updateChanges((c) =>
      pasted.reduce((acc, values) => {
        const named: Record<string, CellValue> = {}
        page.columns.forEach((column, i) => {
          const v = values[i]
          if (v !== undefined && !locked.has(i)) named[column.name] = v
        })
        return addInsert(acc, newInsert(uid('ins'), columnNames, named))
      }, c),
    )
  }

  /** "Filter by this value": narrows the server-side filter of the table. */
  const filterByValue = (col: number, value: CellValue, exclude: boolean) => {
    const column = page?.columns[col]
    if (!column) return
    const where = combineWhere(session.where, valuePredicate({ column: column.name, dataType: column.dataType, value }, exclude, dialect ?? 'postgres'))
    patchSession(tab.id, { draftWhere: where })
    void applyFilter(tab, where)
  }

  // Foreign keys: header glyphs, and navigation to referenced / referencing rows.
  const foreignKeys = details?.data?.foreignKeys
  const referencedBy = details?.data?.referencedBy
  const foreignKeyColumns = useMemo(
    () => (page && foreignKeys ? foreignKeyLabels(foreignKeys, page.columns, tab.table.schema) : undefined),
    [page?.columns, foreignKeys, tab.table.schema],
  )
  /** Links of a source row of the grid (the active column narrows the referenced ones). */
  const rowLinks = (row: number, col: number | undefined): { referenced: RowLink[]; referencing: RowLink[] } => {
    const values = model?.rows[row]
    if (!page || !values || model?.info[row]?.ref.kind !== 'existing') return { referenced: [], referencing: [] }
    const column = col === undefined ? undefined : page.columns[col]?.name
    const d = dialect ?? 'postgres'
    return {
      referenced: foreignKeys ? referencedRows(foreignKeys, page.columns, values, column, tab.table.schema, d) : [],
      referencing: referencedBy ? referencingRows(referencedBy, page.columns, values, tab.table.schema, d) : [],
    }
  }
  const followLink = (link: RowLink) =>
    void openTableFiltered({ connectionId: tab.connectionId, database: tab.database, schema: link.schema, name: link.table }, link.where)

  const clearFilter = () => {
    patchSession(tab.id, { draftWhere: '' })
    void applyFilter(tab, '')
  }

  const openPreview = () => {
    if (hasChanges(changes)) setPreviewOpen(true)
  }

  // Commands act on this (the active) table tab while it is mounted.
  const activeLinks = () => (selection ? rowLinks(selection.anchor.row, selection.anchor.col) : { referenced: [], referencing: [] })
  const latest = useRef({ editable, pending, selectedRows, addRow, deleteGridRows, revert, openPreview, sql: page?.sql, activeLinks, followLink })
  latest.current = { editable, pending, selectedRows, addRow, deleteGridRows, revert, openPreview, sql: page?.sql, activeLinks, followLink }

  useEffect(
    () =>
      registerCommands([
        {
          id: 'submit-table-changes',
          title: 'Submit table changes',
          group: 'Table data',
          icon: Upload,
          shortcut: 'CmdOrCtrl+S',
          keywords: ['save', 'commit', 'apply'],
          when: () => latest.current.editable,
          run: () => submitChanges(tab),
        },
        {
          id: 'refresh-table',
          title: 'Refresh table data',
          group: 'Table data',
          icon: RefreshCw,
          keywords: ['reload'],
          run: () => refresh(tab),
        },
        {
          id: 'table-add-row',
          title: 'Add row',
          group: 'Table data',
          icon: Plus,
          keywords: ['insert', 'new'],
          when: () => latest.current.editable,
          run: () => latest.current.addRow(),
        },
        {
          id: 'table-delete-rows',
          title: 'Delete selected rows',
          group: 'Table data',
          icon: Trash2,
          when: () => latest.current.editable && latest.current.selectedRows.length > 0,
          run: () => latest.current.deleteGridRows(latest.current.selectedRows),
        },
        {
          id: 'table-revert-changes',
          title: 'Revert all pending changes',
          group: 'Table data',
          icon: Undo2,
          keywords: ['discard', 'undo'],
          when: () => latest.current.pending > 0,
          run: () => latest.current.revert([]),
        },
        {
          id: 'table-preview-changes',
          title: 'Preview SQL of pending changes',
          group: 'Table data',
          icon: FileCode2,
          when: () => latest.current.pending > 0,
          run: () => latest.current.openPreview(),
        },
        {
          id: 'table-count-rows',
          title: 'Count rows',
          group: 'Table data',
          keywords: ['total', 'count(*)'],
          run: () => countRows(tab),
        },
        {
          id: 'table-filter-rows',
          title: 'Filter rows…',
          group: 'Table data',
          keywords: ['where', 'search'],
          run: () => {
            filterRef.current?.focus()
            filterRef.current?.select()
          },
        },
        {
          id: 'table-open-in-console',
          title: 'Open table query in console',
          group: 'Table data',
          icon: SquareTerminal,
          when: () => latest.current.sql !== undefined,
          run: () => {
            if (latest.current.sql) openSqlInConsole(tab, latest.current.sql)
          },
        },
        {
          id: 'table-open-referenced-row',
          title: 'Open referenced row',
          group: 'Table data',
          icon: Link2,
          keywords: ['foreign key', 'fk', 'navigate', 'parent'],
          when: () => latest.current.activeLinks().referenced.length > 0,
          run: () => {
            const [link] = latest.current.activeLinks().referenced
            if (link) latest.current.followLink(link)
          },
        },
        {
          id: 'table-referencing-rows',
          title: 'Show rows referencing this row',
          group: 'Table data',
          icon: GitFork,
          keywords: ['foreign key', 'fk', 'children', 'referenced by'],
          when: () => latest.current.activeLinks().referencing.length > 0,
          run: () => {
            const links = latest.current.activeLinks().referencing
            const [first] = links
            if (!first) return
            if (links.length > 1) toast.message(`Opened ${first.table}`, { description: `${links.length - 1} more referencing ${links.length === 2 ? 'table is' : 'tables are'} in the row's context menu.` })
            latest.current.followLink(first)
          },
        },
        {
          id: 'import-csv',
          title: `Import data from CSV into ${tab.table.name}…`,
          group: 'Table data',
          icon: FileUp,
          keywords: ['csv', 'tsv', 'load', 'upload', 'insert', 'file'],
          when: () => tab.table.kind === 'table' && !connectionById(tab.connectionId)?.readOnly,
          run: () => void importCsvInto(tableRefOf(tab)),
        },
        {
          id: 'open-table-structure',
          title: `Open structure of ${tab.table.name}`,
          group: 'Table data',
          keywords: ['columns', 'indexes', 'ddl'],
          run: () => openSibling(tab, 'structure'),
        },
      ]),
    [tab.id],
  )

  const contextMenuItems = ({ rows, columns, active }: GridMenuContext): GridMenuItem[] => {
    if (!model) return []
    const items: GridMenuItem[] = []
    if (editable) {
      const refs = refsOf(rows)
      const allDeleted = refs.length > 0 && refs.every((r) => r.kind === 'existing' && r.rowKey in changes.deletes)
      const inserted = refs.some((r) => r.kind === 'inserted')
      const n = rows.length
      items.push(
        { label: 'Add row', onSelect: addRow },
        { label: n > 1 ? `Duplicate ${n} rows` : 'Duplicate row', disabled: n === 0, onSelect: () => duplicateRows(rows) },
        allDeleted
          ? { label: n > 1 ? `Restore ${n} rows` : 'Restore row', onSelect: () => updateChanges((c) => revertRows(c, refs)) }
          : { label: n > 1 ? `Delete ${n} rows` : 'Delete row', danger: true, disabled: n === 0, onSelect: () => deleteGridRows(rows) },
        { label: n > 1 ? 'Revert rows' : 'Revert row', disabled: !rowsHaveChanges(changes, refs), onSelect: () => revert(rows) },
      )
      // Set NULL is built into the grid; DEFAULT only makes sense for pending inserts.
      if (inserted) items.push({ separator: true }, { label: 'Set to DEFAULT', disabled: columns.length === 0, onSelect: () => setDefault(rows, columns) })
    }
    if (active) {
      const { referenced, referencing } = rowLinks(active.row, active.col)
      if (referenced.length + referencing.length > 0) {
        if (items.length > 0) items.push({ separator: true })
        for (const link of [...referenced, ...referencing.slice(0, 8)]) items.push({ label: link.label, onSelect: () => followLink(link) })
      }
    }
    return items
  }

  const shown = page?.rows.length ?? 0
  const offset = page?.offset ?? session.offset
  const total = page ? knownTotal(offset, shown, page.hasMore, session.exactCount) : undefined
  const estimate = !session.where && details?.data?.rowEstimate !== undefined && details.data.rowEstimate >= 0 ? details.data.rowEstimate : undefined
  const selectionHasChanges = rowsHaveChanges(changes, refsOf(selectedRows))

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <Toolbar className="gap-1.5">
        <ViewSwitch tab={tab} />
        <IconButton
          icon={RefreshCw}
          label="Refresh"
          loading={session.loading && page !== undefined}
          disabled={session.submitting}
          onClick={() => void refresh(tab)}
        />
        <FilterInput
          inputRef={filterRef}
          value={session.draftWhere}
          applied={session.where}
          recent={recent}
          invalid={session.error?.kind === 'database' && session.where !== ''}
          disabled={session.submitting}
          placeholder={filterPlaceholder(session.page?.columns, dialect ?? 'postgres')}
          onChange={(draftWhere) => patchSession(tab.id, { draftWhere })}
          onApply={(where) => void applyFilter(tab, where)}
          onClearRecent={() => clearRecentFilters(tableKeyOf(tab))}
        />
        <SortChips
          sort={session.sort}
          disabled={busy}
          onFlip={(column) => void setSort(tab, flipSort(session.sort, column))}
          onRemove={(column) => void setSort(tab, removeSort(session.sort, column))}
          onClear={() => void setSort(tab, [])}
        />
        <ToolbarSpacer />
        {editable && (
          <>
            <ToolbarGroup>
              <IconButton icon={Plus} label="Add row" disabled={session.submitting} onClick={addRow} />
              <IconButton
                icon={CopyPlus}
                label={selectedRows.length > 1 ? `Duplicate ${selectedRows.length} rows` : 'Duplicate row'}
                disabled={session.submitting || selectedRows.length === 0}
                onClick={() => duplicateRows(selectedRows)}
              />
              <IconButton
                icon={Trash2}
                label={selectedRows.length > 1 ? `Delete ${selectedRows.length} rows` : 'Delete row'}
                disabled={session.submitting || selectedRows.length === 0}
                onClick={() => deleteGridRows(selectedRows)}
              />
              <IconButton
                icon={Undo2}
                label={selectionHasChanges ? 'Revert selected rows' : 'Revert all changes'}
                disabled={session.submitting || pending === 0}
                onClick={() => revert(selectionHasChanges ? selectedRows : [])}
              />
            </ToolbarGroup>
            <ToolbarSeparator className="mx-0.5" />
            <IconButton icon={FileCode2} label="Preview SQL" disabled={pending === 0} onClick={openPreview} />
            <Tooltip content={pending > 0 ? `Submit ${summary}` : 'No pending changes'} shortcut="CmdOrCtrl+S">
              <Button
                variant={pending > 0 ? 'primary' : 'secondary'}
                leadingIcon={Upload}
                loading={session.submitting}
                disabled={pending === 0 || session.loading}
                onClick={() => void submitChanges(tab)}
                className="pr-2"
              >
                Submit
                {pending > 0 && (
                  <span className="ml-0.5 min-w-[18px] rounded-full bg-accent-fg/20 px-1.5 text-center text-2xs font-semibold leading-4 tabular">
                    {pending}
                  </span>
                )}
              </Button>
            </Tooltip>
            <ToolbarSeparator className="mx-0.5" />
          </>
        )}
        <IconButton
          icon={SquareTerminal}
          label="Open in console"
          disabled={!page}
          onClick={() => page && openSqlInConsole(tab, page.sql)}
        />
      </Toolbar>

      {page && !page.editable && (
        <div role="status" className="flex h-7 shrink-0 items-center gap-2 border-b border-line bg-info-soft px-3 text-xs">
          <Lock size={13} strokeWidth={1.75} className="text-info" aria-hidden />
          <span className="font-medium text-fg">Read-only</span>
          <span className="truncate text-muted">{page.readOnlyReason ?? 'This object cannot be edited.'}</span>
        </div>
      )}

      {session.submitError && (
        <div className="shrink-0 border-b border-line bg-panel px-3 py-2">
          <Callout
            tone="danger"
            title="Changes were not applied"
            actions={
              <>
                <Button size="xs" leadingIcon={FileCode2} onClick={openPreview}>
                  Preview SQL
                </Button>
                <Button size="xs" variant="ghost" onClick={() => patchSession(tab.id, { submitError: undefined })}>
                  Dismiss
                </Button>
              </>
            }
          >
            {/* positions point into generated SQL the user never wrote */}
            <ErrorDetail error={session.submitError} showPosition={false} />
            <p className="pt-1 text-subtle">The transaction was rolled back; your edits are still pending.</p>
          </Callout>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {session.loading && page && <ProgressBar className="absolute inset-x-0 top-0 z-10" />}
        {(session.loading || session.counting) && <SlowLoadNotice onCancel={() => cancelLoad(tab)} counting={!session.loading} />}
        {session.error ? (
          <LoadError
            error={session.error}
            filtered={session.where !== ''}
            onRetry={() => void loadPage(tab)}
            onClearFilter={clearFilter}
            onEditFilter={() => {
              filterRef.current?.focus()
              filterRef.current?.select()
            }}
          />
        ) : page && model ? (
          <div className={cn('h-full transition-opacity duration-100', session.loading && 'opacity-60')}>
            <DataGrid
              key={tab.id}
              columns={page.columns}
              rows={model.rows}
              rowKey={(row) => model.info[row]?.key ?? String(row)}
              resetKey={`${page.offset}\u0000${page.sql}`}
              getRowNumber={(row) => {
                const index = model.info[row]?.pageIndex
                return index === undefined ? undefined : page.offset + index + 1
              }}
              sort={session.sort}
              onSortChange={(sort) => void setSort(tab, sort)}
              editable={editable && !session.submitting}
              readOnlyColumns={locked}
              onCellEdit={onCellEdit}
              onCellsEdit={onCellsEdit}
              onPasteRows={onPasteRows}
              onFilterByValue={filterByValue}
              foreignKeyColumns={foreignKeyColumns}
              columnStateKey={`table:${tableKeyOf(tab)}`}
              getRowState={(row) => rowStateOf(changes, model.info[row])}
              isCellModified={(row, col) => isCellModifiedIn(changes, model.info[row], page.columns[col]?.name)}
              getCellPlaceholder={(row, col) => cellPlaceholderIn(changes, model.info[row], page.columns[col]?.name)}
              contextMenuItems={contextMenuItems}
              onSelectionChange={setSelection}
              tableName={qualified}
              dialect={dialect}
              nullDisplay={nullDisplay}
              showRowNumbers={showRowNumbers}
              primaryKeyColumns={primaryKeyColumns}
              aria-label={`Rows of ${qualified}`}
              className="h-full"
              emptyState={
                session.where ? (
                  <EmptyState
                    icon={SearchX}
                    title="No rows match this filter"
                    description={<SqlText code={session.where} className="text-xs text-muted" />}
                    action={
                      <Button size="sm" variant="primary" onClick={clearFilter}>
                        Clear filter
                      </Button>
                    }
                  />
                ) : offset > 0 ? (
                  <EmptyState
                    icon={Rows3}
                    title="No rows on this page"
                    description="The table has fewer rows than this page starts at."
                    action={
                      <Button size="sm" variant="primary" onClick={() => void goToOffset(tab, 0)}>
                        First page
                      </Button>
                    }
                  />
                ) : (
                  <EmptyState
                    icon={Rows3}
                    title="This table is empty"
                    description={editable ? 'Add a row, then submit to insert it.' : 'There are no rows to show.'}
                    action={
                      editable ? (
                        <Button size="sm" variant="primary" leadingIcon={Plus} onClick={addRow}>
                          Add row
                        </Button>
                      ) : undefined
                    }
                  />
                )
              }
            />
          </div>
        ) : (
          <GridSkeleton />
        )}
      </div>

      {page && !session.error && (
        <PagerBar
          window={{ offset, shown, hasMore: page.hasMore, pageSize: session.pageSize, total, estimate }}
          loading={session.loading}
          counting={session.counting}
          canCount
          durationMs={page.durationMs}
          pendingLabel={pending > 0 ? `${pluralize(pending, 'pending change')}` : undefined}
          disabled={busy}
          onPrev={() => void goToOffset(tab, offset - session.pageSize)}
          onNext={() => void goToOffset(tab, offset + session.pageSize)}
          onPageSize={(size) => void setPageSize(tab, size)}
          onCount={() => void countRows(tab)}
        />
      )}

      {editable && (
        <PreviewChangesDialog
          tab={tab}
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          summary={summary}
          count={pending}
          submitting={session.submitting}
          onSubmit={() => void submitChanges(tab)}
        />
      )}
    </div>
  )
}

/** After a second of loading (or counting): say so and offer to stop it. */
function SlowLoadNotice({ onCancel, counting }: { onCancel: () => void; counting: boolean }) {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 1000)
    return () => clearTimeout(timer)
  }, [])
  if (!visible) return null
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center">
      <div className="pointer-events-auto flex animate-fade-in items-center gap-2 rounded-lg border border-line bg-elevated py-1 pl-3 pr-1 text-xs text-muted shadow-popover">
        <Spinner size={12} />
        {counting ? 'Counting rows…' : 'Loading rows…'}
        <Button size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

function LoadError({
  error,
  filtered,
  onRetry,
  onClearFilter,
  onEditFilter,
}: {
  error: DbErrorInfo
  filtered: boolean
  onRetry: () => void
  onClearFilter: () => void
  onEditFilter: () => void
}) {
  const filterProblem = filtered && error.kind === 'database'
  return (
    <EmptyState
      tone="danger"
      icon={TriangleAlert}
      title={filterProblem ? 'The filter could not be applied' : 'Could not load rows'}
      description={error.message}
      action={
        filterProblem ? (
          // re-running the same invalid filter would fail again: fixing it comes first
          <>
            <Button size="sm" variant="primary" onClick={onEditFilter}>
              Edit filter
            </Button>
            <Button size="sm" onClick={onClearFilter}>
              Clear filter
            </Button>
            <Button size="sm" variant="ghost" leadingIcon={RotateCcw} onClick={onRetry}>
              Retry
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="primary" leadingIcon={RotateCcw} onClick={onRetry}>
              Retry
            </Button>
            {filtered && (
              <>
                <Button size="sm" onClick={onEditFilter}>
                  Edit filter
                </Button>
                <Button size="sm" variant="ghost" onClick={onClearFilter}>
                  Clear filter
                </Button>
              </>
            )}
          </>
        )
      }
    >
      {(error.detail || error.hint || error.code) && (
        <div className="max-w-lg text-left text-xs text-muted">
          {/* the server position counts from the start of the generated SELECT, not the filter */}
          <ErrorDetail error={error} showMessage={false} showPosition={false} />
        </div>
      )}
    </EmptyState>
  )
}
