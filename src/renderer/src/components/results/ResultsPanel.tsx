// Results area under the editor: result tabs, the active result (grid / command summary / error),
// server messages and the query plan, with running / cancelled / failure states.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowDownUp, Ban, CircleSlash, Copy, Gauge, OctagonAlert, Pencil, Pin, PinOff, RotateCw, Rows3, TerminalSquare, Undo2, Upload, X } from 'lucide-react'
import { classifyStatement } from '@shared/sql'
import type { ConnectionConfig, DbErrorInfo, Dialect, SortSpec, StatementResult } from '@shared/types'
import { DataGrid, type GridMenuContext, type GridMenuItem } from '@/components/grid/DataGrid'
import { sortRowsForView } from '@/components/grid/sort'
import { ExplainView } from '@/components/explain/ExplainView'
import { ErrorDetail } from '@/components/table/ErrorDetail'
import { isCellModifiedIn, rowStateOf } from '@/components/table/grid-model'
import { rowsHaveChanges } from '@/components/table/pending-changes'
import { Button, Callout, EmptyState, IconButton, Kbd, ProgressBar, Spinner, SqlText, toast, Tooltip } from '@/components/ui'
import { registerCommands } from '@/lib/commands'
import { copyText } from '@/lib/clipboard'
import { getEditor } from '@/lib/editor-registry'
import { cn } from '@/lib/cn'
import { formatCount, formatDuration, pluralize } from '@/lib/format'
import { useConnections } from '@/stores/connections'
import { useConsoles, type ConsoleRuntime } from '@/stores/consoles'
import { useSettings } from '@/stores/settings'
import { useTabs, type ConsoleTab } from '@/stores/tabs'
import { noteExecution, pinResult, pinTime, showPinned, syncPinned, unpinResult, usePinned, usePinnedResults, type PinnedResult } from './pinned-results'
import { CommandResultView } from './CommandResultView'
import { ErrorResultView } from './ErrorResultView'
import { ExportMenu } from './ExportMenu'
import { copyMessages, LiveMessagesView, MessagesView } from './MessagesView'
import { ResultTabs, type ResultTabId } from './ResultTabs'
import {
  canFetchMore,
  dropResultView,
  fetchMoreRows,
  loadAllLimit,
  loadAllRows,
  pruneResultViews,
  resultViewKey,
  stopLoadAll,
  useResultView,
  useResultViews,
} from './result-view-state'
import { useResultEditing } from './use-result-editing'
import { describeChanges, submitResultChanges } from './result-editing'
import { errorReport, inferTableName, isCancelledResult, locateStatement, rowCountLabel, shortName } from './result-meta'

const IDLE: ConsoleRuntime = useConsoles.getState().runtime('')

export function ResultsPanel({ tabId }: { tabId: string }) {
  const runtime = useConsoles((s) => s.runtimes[tabId]) ?? IDLE
  const tab = useTabs((s) => s.tabs.find((t): t is ConsoleTab => t.id === tabId && t.kind === 'console'))
  const connection = useConnections((s) => s.connections.find((c) => c.id === tab?.connectionId))
  const nullDisplay = useSettings((s) => s.settings.nullDisplay)
  const showRowNumbers = useSettings((s) => s.settings.gridRowNumbers)
  const dialect = connection?.dialect

  const { execution, explain, explaining, status } = runtime
  const showPlan = !!explain || explaining
  const results = execution?.results ?? []
  const executionId = execution?.executionId

  // Pinned results: those of older runs get their own tabs, those of this run a pin glyph.
  const pinnedAll = usePinned(tabId)
  const activePinId = usePinnedResults((s) => s.active[tabId])
  const olderPinned = useMemo(() => pinnedAll.filter((p) => p.executionId !== executionId), [pinnedAll, executionId])
  const pinnedIndices = useMemo(() => new Set(pinnedAll.filter((p) => p.executionId === executionId).map((p) => p.index)), [pinnedAll, executionId])
  const pinnedTabs = useMemo(() => olderPinned.map((p) => ({ id: p.id, result: p.result, time: pinTime(p.pinnedAt) })), [olderPinned])
  // Nothing live to show (a plan was cleared, the console never ran since): the latest pinned result.
  const shownPin = olderPinned.find((p) => p.id === activePinId) ?? (!execution && !showPlan ? olderPinned[olderPinned.length - 1] : undefined)

  const activeIndex = Math.min(Math.max(runtime.activeResult, 0), Math.max(results.length - 1, 0))
  const current: ResultTabId = shownPin
    ? { view: 'pinned', id: shownPin.id }
    : runtime.resultView === 'explain' && showPlan
      ? { view: 'explain' }
      : runtime.resultView === 'messages' && execution
        ? { view: 'messages' }
        : { view: 'results', index: activeIndex }
  const result = current.view === 'results' ? results[activeIndex] : undefined

  const select = (t: ResultTabId) => {
    if (t.view === 'pinned') {
      showPinned(tabId, t.id)
      return
    }
    showPinned(tabId, undefined)
    const store = useConsoles.getState()
    if (t.view === 'results') store.setActiveResult(tabId, t.index)
    else store.setResultView(tabId, t.view)
  }

  // A new run (or a plan) brings the live output back to the front; snapshots of this run's pinned
  // results follow the rows fetched later.
  useEffect(() => noteExecution(tabId, executionId), [tabId, executionId])
  useEffect(() => syncPinned(tabId, execution), [tabId, execution])

  const pinned = !!result && pinnedIndices.has(result.index)
  const togglePin = useCallback(() => {
    if (!execution || !result) return
    if (pinned) unpinResult(tabId, { executionId: execution.executionId, index: result.index })
    else pinResult(tabId, execution, result.index)
  }, [tabId, execution, result, pinned])
  useEffect(
    () =>
      setPanelHandle(tabId, {
        canPin: () => !!result && !pinned,
        canUnpin: () => pinned || current.view === 'pinned',
        pin: () => {
          if (!pinned) togglePin()
        },
        unpin: () => {
          if (shownPin) unpinPinned(tabId, shownPin)
          else if (pinned) togglePin()
        },
      }),
    [tabId, result, pinned, togglePin, current.view, shownPin],
  )

  const rerun = (r: StatementResult) => void useConsoles.getState().execute(tabId, r.sql, runtime.executionOffset + r.offset)

  const running = status === 'running'
  const busy = running || status === 'connecting'
  const hasContent = !!execution || showPlan || olderPinned.length > 0
  const activeView = useResultView(resultViewKey(tabId, execution?.executionId, result?.index ?? -1))
  // The banner error comes from fetching more rows of the shown result (not from the connection).
  const fetchFailed = !!runtime.error && activeView.fetchError === runtime.error

  // a new execution: drop the view state (sort, failed fetch) of the previous ones
  useEffect(() => pruneResultViews(tabId, executionId), [tabId, executionId])

  let body: ReactNode
  if (running && runtime.liveMessages && runtime.liveMessages.length > 0 && !shownPin) {
    // Notices / PRINT of the script in progress: the previous run's output would read as this one's.
    body = <LiveMessagesView messages={runtime.liveMessages} />
  } else if (!hasContent) {
    if (busy) body = <BusyState runtime={runtime} tabId={tabId} />
    else if (runtime.error) body = <FailureView tabId={tabId} error={runtime.error} dialect={dialect} />
    else body = <IdleState />
  } else if (shownPin) {
    body = (
      <PinnedResultView
        key={shownPin.id}
        pin={shownPin}
        viewKey={pinnedViewKey(tabId, shownPin.id)}
        dialect={dialect}
        nullDisplay={nullDisplay}
        showRowNumbers={showRowNumbers}
      />
    )
  } else if (current.view === 'explain') {
    body = explain ? (
      <div className={cn('h-full min-h-0', explaining && 'opacity-50')}>
        <ExplainView result={explain} sql={runtime.explainSql} />
      </div>
    ) : (
      <div className="flex h-full items-center justify-center gap-2 text-xs text-subtle">
        <Spinner size={13} /> Building the plan…
      </div>
    )
  } else if (current.view === 'messages' && execution) {
    body = <MessagesView execution={execution} dialect={dialect} onOpenResult={(index) => select({ view: 'results', index })} />
  } else if (!result) {
    body = (
      <EmptyState
        size="compact"
        icon={CircleSlash}
        title="Nothing to show"
        description="The script ran without producing a result."
        action={
          execution && execution.messages.length > 0 ? (
            <Button size="xs" onClick={() => select({ view: 'messages' })}>
              View messages
            </Button>
          ) : undefined
        }
      />
    )
  } else if (result.kind === 'rows') {
    body = (
      <RowsResult
        key={`${execution?.executionId}:${result.index}`}
        tabId={tabId}
        result={result}
        viewKey={resultViewKey(tabId, execution?.executionId, result.index)}
        dialect={dialect}
        nullDisplay={nullDisplay}
        showRowNumbers={showRowNumbers}
        loadingMore={runtime.loadingMore}
      />
    )
  } else if (result.kind === 'command') {
    body = <CommandResultView result={result} dialect={dialect} />
  } else if (isCancelledResult(result, execution)) {
    body = (
      <EmptyState
        size="compact"
        icon={Ban}
        title="Query cancelled"
        description={`Stopped after ${formatDuration(result.durationMs)}.`}
        action={
          <Button size="xs" leadingIcon={RotateCw} onClick={() => rerun(result)}>
            Run again
          </Button>
        }
      >
        <SqlText code={result.sql.replace(/\s+/g, ' ').slice(0, 160)} className="max-w-lg truncate text-2xs text-subtle" />
      </EmptyState>
    )
  } else {
    const expected = runtime.executionOffset + result.offset
    // Offered only while the statement can still be found in the console (it may have been edited).
    const findable = !!getEditor(tabId) && locateStatement(tab?.content ?? '', result.sql, expected) !== null
    body = (
      <ErrorResultView
        error={result.error ?? { message: 'The statement failed.' }}
        sql={result.sql}
        dialect={dialect}
        onShowInEditor={findable ? (start, end) => showInEditor(tabId, result.sql, expected, start, end, result.error?.message) : undefined}
        onRetry={() => rerun(result)}
      />
    )
  }

  return (
    <section aria-label="Results" className="flex h-full min-h-0 flex-col bg-surface">
      <header className="flex h-8 shrink-0 items-stretch border-b border-line bg-panel">
        {hasContent ? (
          <ResultTabs
            execution={execution}
            dialect={dialect}
            current={current}
            showPlan={showPlan}
            planLoading={explaining}
            pinned={pinnedTabs}
            pinnedIndices={pinnedIndices}
            onSelect={select}
          />
        ) : (
          <div className="flex min-w-0 flex-1 items-center px-3 text-xs font-medium text-subtle">Results</div>
        )}
        <div className="flex shrink-0 items-center gap-1 pl-2 pr-1.5">
          {running && hasContent && <RunningControls runtime={runtime} tabId={tabId} />}
          {!running && current.view === 'results' && result && (
            <ResultActions
              tabId={tabId}
              result={result}
              viewKey={resultViewKey(tabId, execution?.executionId, result.index)}
              connection={connection}
              database={tab?.database}
              schema={tab?.schema ?? runtime.sessionSchema}
              loadingMore={runtime.loadingMore}
              pinned={pinned}
              onTogglePin={togglePin}
              onRerun={() => rerun(result)}
            />
          )}
          {!running && shownPin && (
            <PinnedActions
              pin={shownPin}
              viewKey={pinnedViewKey(tabId, shownPin.id)}
              dialect={dialect}
              onUnpin={() => unpinPinned(tabId, shownPin)}
            />
          )}
          {!running && current.view === 'messages' && execution && (
            <Button size="xs" variant="ghost" leadingIcon={Copy} className="text-muted" onClick={() => void copyMessages(execution, dialect)}>
              Copy all
            </Button>
          )}
          {current.view === 'explain' && <ExplainActions tabId={tabId} busy={busy || explaining} />}
        </div>
      </header>

      {execution?.cancelled && !running && current.view === 'results' && result && !isCancelledResult(result, execution) && (
        <Notice icon={<Ban size={13} strokeWidth={2} className="text-muted" />}>Query cancelled. Results received before the cancellation are shown.</Notice>
      )}
      {runtime.error && hasContent && !busy && (
        <ErrorBanner
          tabId={tabId}
          error={runtime.error}
          dialect={dialect}
          onRerun={fetchFailed && result ? () => rerun(result) : undefined}
        />
      )}

      <div className="relative min-h-0 flex-1">
        {(busy || explaining) && <ProgressBar className="absolute inset-x-0 top-0 z-40" label={running ? 'Running query' : 'Working'} />}
        <div className={cn('h-full min-h-0 transition-opacity duration-150', busy && hasContent && 'pointer-events-none opacity-45')} aria-busy={busy || undefined}>
          {body}
        </div>
      </div>
    </section>
  )
}

/**
 * Mark an error range (offsets inside `sql`) in the console. The statement is located again in the
 * current text, so edits made after the run (lines added above it…) do not shift the marker.
 */
function showInEditor(tabId: string, sql: string, expected: number, start: number, end: number, message?: string) {
  const editor = getEditor(tabId)
  if (!editor) return
  const base = locateStatement(editor.getText(), sql, expected)
  if (base === null) {
    toast.info('Statement not found in the editor', { description: 'It was changed after the run. Run it again to locate the error.' })
    return
  }
  editor.markError(base + start, base + end, message ?? 'Error')
  editor.focus()
}

// --- rows ------------------------------------------------------------------------------------

interface RowsResultProps {
  tabId: string
  result: StatementResult
  viewKey: string
  dialect?: Dialect
  nullDisplay: string
  showRowNumbers: boolean
  loadingMore: boolean
}

function RowsResult({ tabId, result, viewKey, dialect, nullDisplay, showRowNumbers, loadingMore }: RowsResultProps) {
  const tableName = useMemo(() => inferTableName(result), [result])
  const view = useResultView(viewKey)
  const editing = useResultEditing(tabId, result, viewKey, dialect)
  const connection = useConnections((s) => s.connections.find((c) => c.id === editing.table?.connectionId))
  const index = result.index
  const onLoadMore = useCallback(() => void fetchMoreRows(tabId, index, viewKey), [tabId, index, viewKey])
  const onSortChange = useCallback((sort: SortSpec[]) => useResultViews.getState().patch(viewKey, { sort }), [viewKey])
  const more = canFetchMore(result, view)
  const partialSort = view.sort.length > 0 && more
  const { model, target, table, changes, pending } = editing
  const qualified = table ? `${table.schema}.${table.name}` : ''

  const submit = () => {
    if (table) void submitResultChanges(viewKey, table, connection)
  }
  // Palette entries while this result has pending edits (every console stays mounted: the entries
  // act on the active console's shown result).
  const latest = useRef({ submit, revert: () => editing.revert([]), pending })
  latest.current = { submit, revert: () => editing.revert([]), pending }
  useEffect(() => {
    if (!target) return
    return setEditHandle(tabId, {
      pending: () => latest.current.pending,
      submit: () => latest.current.submit(),
      revert: () => latest.current.revert(),
    })
  }, [tabId, target])

  const contextMenuItems = ({ rows }: GridMenuContext): GridMenuItem[] => {
    if (!model) return []
    const refs = editing.refsOf(rows)
    const n = rows.length
    const allDeleted = refs.length > 0 && refs.every((r) => r.kind === 'existing' && r.rowKey in changes.deletes)
    return [
      allDeleted
        ? { label: n > 1 ? `Restore ${n} rows` : 'Restore row', onSelect: () => editing.revert(rows) }
        : { label: n > 1 ? `Delete ${n} rows` : 'Delete row', danger: true, disabled: n === 0, onSelect: () => editing.remove(rows) },
      { label: n > 1 ? 'Revert rows' : 'Revert row', disabled: !rowsHaveChanges(changes, refs), onSelect: () => editing.revert(rows) },
    ]
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {partialSort && (
        <Notice icon={<ArrowDownUp size={13} strokeWidth={2} className="text-warning" />}>
          <span className="truncate">
            Sorted the {formatCount(result.rows.length)} loaded rows only. More rows are available.
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <Button size="xs" variant="ghost" className="text-accent" loading={view.loadingAll} onClick={() => void loadAllRows(tabId, index, viewKey)}>
              Load all rows
            </Button>
            <Button size="xs" variant="ghost" className="text-muted" onClick={() => onSortChange([])}>
              Clear sort
            </Button>
          </span>
        </Notice>
      )}
      {target && (pending > 0 || view.submitting) && (
        <Notice icon={<Pencil size={13} strokeWidth={2} className="text-warning" />}>
          <span className="truncate">
            <span className="text-fg">{pluralize(pending, 'pending change')}</span> to <span className="font-mono text-fg">{qualified}</span>
            <span className="text-subtle"> · {describeChanges(changes)} · running the console again discards them</span>
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <Button size="xs" variant="ghost" className="text-muted" leadingIcon={Undo2} disabled={view.submitting} onClick={() => editing.revert([])}>
              Revert
            </Button>
            <Button size="xs" variant="primary" leadingIcon={Upload} loading={view.submitting} onClick={submit}>
              Submit
            </Button>
          </span>
        </Notice>
      )}
      {target && view.submitError && (
        <div className="shrink-0 border-b border-line bg-panel px-3 py-2">
          <Callout
            tone="danger"
            title="Changes were not applied"
            actions={
              <Button size="xs" variant="ghost" onClick={() => useResultViews.getState().patch(viewKey, { submitError: undefined })}>
                Dismiss
              </Button>
            }
          >
            <ErrorDetail error={view.submitError} showPosition={false} />
            <p className="pt-1 text-subtle">The transaction was rolled back; your edits are still pending.</p>
          </Callout>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <DataGrid
          columns={result.columns}
          rows={model ? model.rows : editing.rows}
          rowKey={model ? (row) => model.info[row]?.key ?? String(row) : undefined}
          sort={view.sort}
          onSortChange={onSortChange}
          clientSort
          hasMore={more}
          loadingMore={loadingMore}
          onLoadMore={onLoadMore}
          editable={!!model && !view.submitting}
          readOnlyColumns={target?.readOnlyColumns}
          onCellEdit={model ? (row, col, value) => editing.edit([{ row, col, value }]) : undefined}
          onCellsEdit={model ? editing.edit : undefined}
          getRowState={model ? (row) => rowStateOf(changes, model.info[row]) : undefined}
          isCellModified={model ? (row, col) => isCellModifiedIn(changes, model.info[row], result.columns[col]?.name) : undefined}
          contextMenuItems={model ? contextMenuItems : undefined}
          primaryKeyColumns={target ? primaryKeyIndices(result.columns, target.primaryKey) : undefined}
          tableName={tableName}
          dialect={dialect}
          nullDisplay={nullDisplay}
          showRowNumbers={showRowNumbers}
          aria-label={tableName ? `Rows of ${tableName}` : `Result ${index + 1}`}
          emptyState={<EmptyState size="compact" icon={Rows3} title="No rows" description="The query returned an empty result set." />}
        />
      </div>
    </div>
  )
}

function primaryKeyIndices(columns: readonly { name: string }[], key: readonly string[]): Set<number> {
  return new Set(columns.flatMap((c, i) => (key.includes(c.name) ? [i] : [])))
}

interface ResultActionsProps {
  tabId: string
  result: StatementResult
  viewKey: string
  connection?: ConnectionConfig
  database?: string
  /** Console schema: the export session resolves unqualified names the same way. */
  schema?: string
  loadingMore: boolean
  pinned: boolean
  onTogglePin: () => void
  onRerun: () => void
}

function PinButton({ pinned, onToggle }: { pinned: boolean; onToggle: () => void }) {
  return (
    <IconButton
      icon={pinned ? PinOff : Pin}
      size="xs"
      label={pinned ? 'Unpin result' : 'Pin result (keep it when the console runs again)'}
      active={pinned}
      className={pinned ? 'text-accent' : 'text-muted'}
      onClick={onToggle}
    />
  )
}

function ResultActions({ tabId, result, viewKey, connection, database, schema, loadingMore, pinned, onTogglePin, onRerun }: ResultActionsProps) {
  const dialect = connection?.dialect ?? 'postgres'
  const tableName = useMemo(() => inferTableName(result), [result])
  const view = useResultView(viewKey)
  const editing = useResultEditing(tabId, result, viewKey, dialect)
  const readOnly = useMemo(() => {
    try {
      return classifyStatement(result.sql, dialect).readOnly
    } catch {
      return false
    }
  }, [result.sql, dialect])
  // Copy / Save follow the order shown in the grid.
  const shownRows = useMemo(
    () => (result.kind === 'rows' && view.sort.length > 0 ? sortRowsForView(result.columns, editing.rows, view.sort, dialect) : editing.rows),
    [result.kind, result.columns, editing.rows, view.sort, dialect],
  )

  const rerun = (
    <IconButton icon={RotateCw} size="xs" label="Run statement again" className="text-muted" onClick={onRerun} />
  )
  const duration = <span className="px-1 text-2xs text-subtle tabular">{formatDuration(result.durationMs)}</span>

  const pin = <PinButton pinned={pinned} onToggle={onTogglePin} />

  if (result.kind !== 'rows') {
    return (
      <>
        {duration}
        {pin}
        {rerun}
      </>
    )
  }

  const count = rowCountLabel(result)
  const more = canFetchMore(result, view)
  const editable = editing.table && (
    <Tooltip content={`Rows of ${editing.table.schema}.${editing.table.name} can be edited: double-click a cell, or right-click to delete rows. Changes are submitted together.`}>
      <span className="flex items-center gap-1 rounded-[4px] px-1 text-2xs text-subtle">
        <Pencil size={11} strokeWidth={2} aria-hidden /> Editable
      </span>
    </Tooltip>
  )
  const limit = loadAllLimit(result.columns.length)
  const baseName = tableName ? shortName(tableName) : `result-${result.index + 1}`
  return (
    <>
      {view.fetchError && result.hasMore ? (
        <Tooltip content="The rest of this result is no longer available (its cursor was closed). Run the statement again to fetch more rows.">
          <span className="flex items-center gap-1 px-1 text-2xs text-warning tabular">
            {formatCount(result.rows.length)} rows <span className="text-subtle">(more unavailable)</span>
          </span>
        </Tooltip>
      ) : count.truncated ? (
        <Tooltip content="The result was cut at the row limit (Settings ▸ Max rows). Export all rows to get everything.">
          <span className="flex items-center gap-1 px-1 text-2xs text-warning tabular">
            {count.text} <span className="text-subtle">(truncated)</span>
          </span>
        </Tooltip>
      ) : (
        <span className="px-1 text-2xs text-muted tabular">{count.text}</span>
      )}
      {more && view.loadingAll && (
        <>
          <span className="flex items-center gap-1.5 px-1 text-2xs text-muted">
            <Spinner size={11} /> Loading all rows…
          </span>
          <Button size="xs" variant="ghost" className="text-muted" onClick={() => stopLoadAll(viewKey)}>
            Stop
          </Button>
        </>
      )}
      {more && !view.loadingAll && (
        <>
          <Button size="xs" variant="ghost" loading={loadingMore} className="text-accent" onClick={() => void fetchMoreRows(tabId, result.index, viewKey)}>
            Load more
          </Button>
          {result.rows.length < limit && (
            <Tooltip content={`Fetch the remaining rows, up to ${formatCount(limit)} in total`}>
              <Button size="xs" variant="ghost" className="text-accent" disabled={loadingMore} onClick={() => void loadAllRows(tabId, result.index, viewKey)}>
                Load all
              </Button>
            </Tooltip>
          )}
        </>
      )}
      {editable}
      <span className="text-faint" aria-hidden>
        ·
      </span>
      {duration}
      <span className="mx-0.5 h-4 w-px bg-line" aria-hidden />
      <ExportMenu
        partial={result.hasMore}
        sorted={view.sort.length > 0}
        source={{ columns: result.columns, rows: shownRows, dialect, tableName, baseName }}
        exportAll={connection && readOnly ? { connectionId: connection.id, database, schema, sql: result.sql, tableName, baseName } : undefined}
      />
      {pin}
      {rerun}
    </>
  )
}

// --- pinned results --------------------------------------------------------------------------

function pinnedViewKey(tabId: string, pinId: string): string {
  return `pin\u0000${tabId}\u0000${pinId}`
}

function unpinPinned(tabId: string, pin: PinnedResult) {
  unpinResult(tabId, { id: pin.id })
  dropResultView(pinnedViewKey(tabId, pin.id))
}

interface PinnedResultViewProps {
  pin: PinnedResult
  viewKey: string
  dialect?: Dialect
  nullDisplay: string
  showRowNumbers: boolean
}

/** A result pinned from an earlier run: a read-only snapshot of the rows loaded at the time. */
function PinnedResultView({ pin, viewKey, dialect, nullDisplay, showRowNumbers }: PinnedResultViewProps) {
  const { result } = pin
  const view = useResultView(viewKey)
  const tableName = useMemo(() => inferTableName(result), [result])
  const onSortChange = useCallback((sort: SortSpec[]) => useResultViews.getState().patch(viewKey, { sort }), [viewKey])
  let content: ReactNode
  if (result.kind === 'rows') {
    content = (
      <DataGrid
        columns={result.columns}
        rows={result.rows}
        sort={view.sort}
        onSortChange={onSortChange}
        clientSort
        tableName={tableName}
        dialect={dialect}
        nullDisplay={nullDisplay}
        showRowNumbers={showRowNumbers}
        aria-label={`Pinned result from ${pinTime(pin.pinnedAt)}`}
        emptyState={<EmptyState size="compact" icon={Rows3} title="No rows" description="The query returned an empty result set." />}
      />
    )
  } else if (result.kind === 'command') {
    content = <CommandResultView result={result} dialect={dialect} />
  } else {
    content = <ErrorResultView error={result.error ?? { message: 'The statement failed.' }} sql={result.sql} dialect={dialect} />
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Notice icon={<Pin size={13} strokeWidth={2} className="text-accent" />}>
        <span className="min-w-0 truncate">
          Pinned at {pinTime(pin.pinnedAt)} from an earlier run
          {result.kind === 'rows' && result.hasMore && <span className="text-subtle"> · only the {formatCount(result.rows.length)} rows loaded then</span>}
        </span>
        <SqlText code={result.sql.replace(/\s+/g, ' ').slice(0, 200)} className="ml-auto min-w-0 max-w-[45%] truncate text-2xs text-subtle" />
      </Notice>
      <div className="min-h-0 flex-1">{content}</div>
    </div>
  )
}

function PinnedActions({ pin, viewKey, dialect = 'postgres', onUnpin }: { pin: PinnedResult; viewKey: string; dialect?: Dialect; onUnpin: () => void }) {
  const { result } = pin
  const view = useResultView(viewKey)
  const tableName = useMemo(() => inferTableName(result), [result])
  const shownRows = useMemo(
    () => (result.kind === 'rows' && view.sort.length > 0 ? sortRowsForView(result.columns, result.rows, view.sort, dialect) : result.rows),
    [result, view.sort, dialect],
  )
  const unpin = <PinButton pinned onToggle={onUnpin} />
  if (result.kind !== 'rows') return unpin
  const n = result.rows.length
  return (
    <>
      <span className="px-1 text-2xs text-muted tabular">
        {formatCount(n)} {n === 1 ? 'row' : 'rows'}
        {result.hasMore && <span className="text-subtle"> (partial)</span>}
      </span>
      <span className="mx-0.5 h-4 w-px bg-line" aria-hidden />
      <ExportMenu
        partial={result.hasMore}
        sorted={view.sort.length > 0}
        source={{ columns: result.columns, rows: shownRows, dialect, tableName, baseName: tableName ? shortName(tableName) : `pinned-result-${result.index + 1}` }}
        exportAll={undefined}
      />
      {unpin}
    </>
  )
}

// --- palette commands --------------------------------------------------------------------------
// Every console stays mounted, so the commands are registered once and act on the active console.

interface EditHandle {
  pending: () => number
  submit: () => void
  revert: () => void
}
interface PanelHandle {
  canPin: () => boolean
  canUnpin: () => boolean
  pin: () => void
  unpin: () => void
}

const editHandles = new Map<string, EditHandle>()
const panelHandles = new Map<string, PanelHandle>()

function setEditHandle(tabId: string, handle: EditHandle): () => void {
  ensureResultCommands()
  editHandles.set(tabId, handle)
  return () => {
    if (editHandles.get(tabId) === handle) editHandles.delete(tabId)
  }
}

function setPanelHandle(tabId: string, handle: PanelHandle): () => void {
  ensureResultCommands()
  panelHandles.set(tabId, handle)
  return () => {
    if (panelHandles.get(tabId) === handle) panelHandles.delete(tabId)
  }
}

function activeConsoleId(): string | null {
  return useTabs.getState().activeTabId
}

let commandsRegistered = false
function ensureResultCommands() {
  if (commandsRegistered) return
  commandsRegistered = true
  const edit = () => {
    const id = activeConsoleId()
    return id ? editHandles.get(id) : undefined
  }
  const panel = () => {
    const id = activeConsoleId()
    return id ? panelHandles.get(id) : undefined
  }
  registerCommands([
    {
      id: 'results-submit-changes',
      title: 'Submit result changes',
      group: 'Results',
      icon: Upload,
      keywords: ['save', 'commit', 'apply', 'edit'],
      when: () => (edit()?.pending() ?? 0) > 0,
      run: () => edit()?.submit(),
    },
    {
      id: 'results-revert-changes',
      title: 'Revert result changes',
      group: 'Results',
      icon: Undo2,
      keywords: ['discard', 'undo', 'edit'],
      when: () => (edit()?.pending() ?? 0) > 0,
      run: () => edit()?.revert(),
    },
    {
      id: 'results-pin',
      title: 'Pin result',
      group: 'Results',
      icon: Pin,
      keywords: ['keep', 'compare', 'tab'],
      when: () => !!panel()?.canPin(),
      run: () => panel()?.pin(),
    },
    {
      id: 'results-unpin',
      title: 'Unpin result',
      group: 'Results',
      icon: PinOff,
      keywords: ['remove', 'close', 'pinned'],
      when: () => !!panel()?.canUnpin(),
      run: () => panel()?.unpin(),
    },
  ])
}

function ExplainActions({ tabId, busy }: { tabId: string; busy: boolean }) {
  const run = (analyze: boolean) => {
    const target = getEditor(tabId)?.getRunTarget()
    if (!target) {
      toast.info('Nothing to explain', { description: 'Place the cursor on a statement in the editor.' })
      return
    }
    void useConsoles.getState().explain(tabId, target.sql, analyze)
  }
  return (
    <>
      <Button size="xs" variant="ghost" leadingIcon={RotateCw} className="text-muted" disabled={busy} onClick={() => run(false)}>
        Explain
      </Button>
      <Button size="xs" variant="ghost" leadingIcon={Gauge} className="text-muted" disabled={busy} onClick={() => run(true)}>
        Explain analyze
      </Button>
    </>
  )
}

// --- states ----------------------------------------------------------------------------------

function IdleState() {
  return (
    <EmptyState
      size="compact"
      icon={TerminalSquare}
      title="No results yet"
      description={
        <span className="inline-flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1">
          Run a statement with <Kbd shortcut="CmdOrCtrl+Enter" /> <span className="text-faint">·</span> Run script with <Kbd shortcut="CmdOrCtrl+Shift+Enter" />
        </span>
      }
    />
  )
}

function useElapsed(since: number | undefined): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (since === undefined) return
    const id = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(id)
  }, [since])
  return since === undefined ? 0 : Math.max(0, now - since)
}

function Elapsed({ since }: { since?: number }) {
  const ms = useElapsed(since)
  return <span className="tabular">{ms < 1000 ? `${(ms / 1000).toFixed(1)} s` : formatDuration(ms)}</span>
}

function BusyState({ runtime, tabId }: { runtime: ConsoleRuntime; tabId: string }) {
  const running = runtime.status === 'running'
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <span className="flex size-9 items-center justify-center rounded-xl border border-line bg-panel text-subtle shadow-inset">
        <Spinner size={16} />
      </span>
      <div className="flex flex-col gap-0.5">
        <p className="text-xs font-medium text-fg">{running ? 'Running…' : 'Connecting…'}</p>
        {running && (
          <p className="text-2xs text-subtle">
            <Elapsed since={runtime.runningSince} /> elapsed
          </p>
        )}
      </div>
      {running && (
        <Button size="xs" variant="secondary" leadingIcon={Ban} onClick={() => void useConsoles.getState().cancel(tabId)}>
          Cancel
        </Button>
      )}
    </div>
  )
}

function RunningControls({ runtime, tabId }: { runtime: ConsoleRuntime; tabId: string }) {
  return (
    <>
      <span className="flex items-center gap-1.5 px-1 text-2xs text-muted">
        <Spinner size={11} />
        Running <Elapsed since={runtime.runningSince} />
      </span>
      <Button size="xs" variant="ghost" leadingIcon={Ban} className="text-muted" onClick={() => void useConsoles.getState().cancel(tabId)}>
        Cancel
      </Button>
    </>
  )
}

function Notice({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div role="status" className="flex h-7 shrink-0 items-center gap-2 border-b border-line bg-panel px-3 text-xs text-muted">
      {icon}
      {typeof children === 'string' ? <span className="truncate">{children}</span> : children}
    </div>
  )
}

function isConnectionProblem(error: DbErrorInfo): boolean {
  return error.kind === 'connection' || error.kind === 'needs-password' || error.kind === 'not-found'
}

function ErrorBanner({ tabId, error, dialect, onRerun }: { tabId: string; error: DbErrorInfo; dialect?: Dialect; onRerun?: () => void }) {
  return (
    <div role="alert" className="flex min-h-7 shrink-0 items-center gap-2 border-b border-danger/20 bg-danger-soft px-3 py-1 text-xs">
      <OctagonAlert size={13} strokeWidth={2} className="shrink-0 text-danger" />
      <span className="selectable min-w-0 flex-1 truncate text-fg" title={error.detail ?? error.message}>
        {error.message}
      </span>
      {onRerun ? (
        // fetching more rows failed: the statement must run again (reconnecting would not help)
        <Button size="xs" variant="ghost" leadingIcon={RotateCw} className="text-muted" onClick={onRerun}>
          Run again
        </Button>
      ) : (
        isConnectionProblem(error) && (
          <Button size="xs" variant="ghost" leadingIcon={RotateCw} className="text-muted" onClick={() => void useConsoles.getState().ensureSession(tabId)}>
            Reconnect
          </Button>
        )
      )}
      <Button
        size="xs"
        variant="ghost"
        leadingIcon={Copy}
        className="text-muted"
        onClick={() => void copyText(errorReport(error, undefined, dialect)).catch((e: unknown) => toast.error('Could not copy', e))}
      >
        Copy
      </Button>
      <IconButton icon={X} size="xs" label="Dismiss" className="text-muted" onClick={() => useConsoles.getState().dismissError(tabId)} />
    </div>
  )
}

function FailureView({ tabId, error, dialect }: { tabId: string; error: DbErrorInfo; dialect?: Dialect }) {
  return (
    <ErrorResultView
      error={error}
      dialect={dialect}
      onRetry={isConnectionProblem(error) ? () => void useConsoles.getState().ensureSession(tabId) : undefined}
      retryLabel="Reconnect"
    />
  )
}
