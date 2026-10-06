// Data-editor actions on a table tab's session: paging, filtering, sorting, counting, submitting.
// Every action that would replace the page asks before discarding pending changes.
import type { DbErrorInfo, SortSpec, TableRef } from '@shared/types'
import { commitOpenCellEditor } from '@/components/grid/edit-session'
import { toast } from '@/components/ui'
import { api, errorInfo, errorMessage } from '@/lib/api'
import { pluralize } from '@/lib/format'
import { uid } from '@/lib/id'
import { connectionById, useConnections } from '@/stores/connections'
import { useExplorer } from '@/stores/explorer'
import { useSettings } from '@/stores/settings'
import { onTabClosed, registerCloseGuard, useTabs, type TableTab } from '@/stores/tabs'
import { useUi } from '@/stores/ui'
import { EMPTY_CHANGES, changeCount, describeSummary, hasChanges, summarize, toRowChanges } from './pending-changes'
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZES,
  dropSession,
  getSession,
  initialSession,
  patchSession,
  pushRecentFilter,
  tableKey,
  useTableSessions,
  type TableSession,
} from './table-session'

export function tableRefOf(tab: TableTab): TableRef {
  return { connectionId: tab.connectionId, database: tab.database, schema: tab.table.schema, name: tab.table.name }
}

export function tableKeyOf(tab: TableTab): string {
  return tableKey(tab.connectionId, tab.database, tab.table.schema, tab.table.name)
}

const qualified = (tab: TableTab) => `${tab.table.schema}.${tab.table.name}`

/** Latest request per tab; older responses are ignored. */
const sequence = new Map<string, number>()
/** Running data:fetch / data:count per tab (main can cancel them by id). */
const runningFetch = new Map<string, string>()
const runningCount = new Map<string, string>()

/** Stop the page load and the row count running for the tab (the current page stays). */
export function cancelLoad(tab: TableTab): void {
  for (const running of [runningFetch, runningCount]) {
    const requestId = running.get(tab.id)
    if (requestId) void api.data.cancel(requestId).catch(() => undefined)
  }
}

type PageParams = Partial<Pick<TableSession, 'where' | 'sort' | 'offset' | 'pageSize'>>

async function ensureConnected(connectionId: string): Promise<DbErrorInfo | undefined> {
  const ok = await useConnections.getState().ensureConnected(connectionId)
  if (ok) return undefined
  const runtime = useConnections.getState().runtime[connectionId]
  return { message: runtime?.error ?? 'Not connected', kind: 'connection' }
}

/** Fetch the page described by the session (after applying `params`). Resolves to true on success. */
export async function loadPage(tab: TableTab, params: PageParams = {}, resetCount = false): Promise<boolean> {
  const seq = (sequence.get(tab.id) ?? 0) + 1
  sequence.set(tab.id, seq)
  patchSession(tab.id, (s) => ({
    ...params,
    loading: true,
    error: undefined,
    ...(resetCount || (params.where !== undefined && params.where !== s.where) ? { exactCount: undefined, countError: undefined } : {}),
  }))
  const s = getSession(tab.id)
  const connectionError = await ensureConnected(tab.connectionId)
  if (connectionError) {
    if (sequence.get(tab.id) === seq) patchSession(tab.id, { loading: false, error: connectionError })
    return false
  }
  const requestId = uid('fetch')
  runningFetch.set(tab.id, requestId)
  try {
    const page = await api.data.fetch({
      table: tableRefOf(tab),
      offset: s.offset,
      limit: s.pageSize,
      where: s.where.trim() || undefined,
      orderBy: s.sort.length > 0 ? s.sort : undefined,
      requestId,
    })
    if (sequence.get(tab.id) !== seq) return false
    patchSession(tab.id, { page, loading: false, error: undefined })
    if (s.where.trim()) pushRecentFilter(tableKeyOf(tab), s.where)
    return true
  } catch (error) {
    if (sequence.get(tab.id) !== seq) return false
    const info = errorInfo(error)
    // Cancelled by the user: keep showing the previous page (if any) instead of an error.
    if (info.kind === 'cancelled' && getSession(tab.id).page) patchSession(tab.id, { loading: false })
    else patchSession(tab.id, { loading: false, error: info.kind === 'cancelled' ? { ...info, message: 'Loading was cancelled' } : info })
    return false
  } finally {
    if (runningFetch.get(tab.id) === requestId) runningFetch.delete(tab.id)
  }
}

/** Resolves to true when there is nothing pending or the user agreed to discard it. */
export async function confirmDiscard(tab: TableTab, action: string): Promise<boolean> {
  // A value still being typed in a cell counts as a pending change.
  commitOpenCellEditor()
  const { changes } = getSession(tab.id)
  if (!hasChanges(changes)) return true
  const count = changeCount(changes)
  const ok = await useUi.getState().confirm({
    title: `Discard ${pluralize(count, 'pending change')}?`,
    message: `${action} reloads ${qualified(tab)}. Unsubmitted edits (${describeSummary(summarize(changes))}) will be lost.`,
    confirmLabel: 'Discard changes',
    danger: true,
  })
  if (ok) patchSession(tab.id, { changes: EMPTY_CHANGES, submitError: undefined })
  return ok
}

export async function applyFilter(tab: TableTab, where: string): Promise<void> {
  const trimmed = where.trim()
  const s = getSession(tab.id)
  if (!(await confirmDiscard(tab, 'Applying the filter'))) return
  patchSession(tab.id, { draftWhere: trimmed })
  await loadPage(tab, { where: trimmed, offset: 0 }, trimmed !== s.where)
}

export async function setSort(tab: TableTab, sort: SortSpec[]): Promise<void> {
  if (!(await confirmDiscard(tab, 'Sorting'))) return
  await loadPage(tab, { sort, offset: 0 })
}

export async function goToOffset(tab: TableTab, offset: number): Promise<void> {
  if (!(await confirmDiscard(tab, 'Changing page'))) return
  await loadPage(tab, { offset: Math.max(0, offset) })
}

export async function setPageSize(tab: TableTab, pageSize: number): Promise<void> {
  if (!(await confirmDiscard(tab, 'Changing the page size'))) return
  await loadPage(tab, { pageSize, offset: 0 })
}

export async function refresh(tab: TableTab): Promise<void> {
  if (!(await confirmDiscard(tab, 'Refreshing'))) return
  // Row estimate and identity/generated flags come from the table details.
  void useExplorer.getState().loadDetails(tab.connectionId, tab.database, tab.table.schema, tab.table.name, true)
  await loadPage(tab, {}, true)
}

export async function countRows(tab: TableTab): Promise<void> {
  const { where } = getSession(tab.id)
  patchSession(tab.id, { counting: true, countError: undefined })
  try {
    const connectionError = await ensureConnected(tab.connectionId)
    if (connectionError) throw new Error(connectionError.message)
    const requestId = uid('count')
    runningCount.set(tab.id, requestId)
    let exactCount: number
    try {
      exactCount = await api.data.count({ table: tableRefOf(tab), where: where.trim() || undefined, requestId })
    } finally {
      if (runningCount.get(tab.id) === requestId) runningCount.delete(tab.id)
    }
    // Ignore a count for a filter that changed meanwhile.
    if (getSession(tab.id).where === where) patchSession(tab.id, { exactCount, counting: false })
    else patchSession(tab.id, { counting: false })
  } catch (error) {
    if (errorInfo(error).kind === 'cancelled') {
      patchSession(tab.id, { counting: false })
      return
    }
    patchSession(tab.id, { counting: false, countError: errorMessage(error) })
    toast.error('Could not count rows', error)
  }
}

export async function previewChanges(tab: TableTab): Promise<string[]> {
  const changes = toRowChanges(getSession(tab.id).changes)
  if (changes.length === 0) return []
  return api.data.previewChanges(tableRefOf(tab), changes)
}

export async function submitChanges(tab: TableTab): Promise<void> {
  // ⌘S comes from a menu accelerator (no blur): commit the value being typed first.
  commitOpenCellEditor()
  const s = getSession(tab.id)
  if (s.submitting) return
  const count = changeCount(s.changes)
  if (count === 0) {
    toast.message('Nothing to submit', { description: 'Edit, add or delete rows first.' })
    return
  }
  if (s.page && !s.page.editable) return
  const summary = summarize(s.changes)
  const connection = connectionById(tab.connectionId)
  if (summary.deletes > 0 && connection?.productionGuard && useSettings.getState().settings.confirmDestructive) {
    const statements = await previewChanges(tab).catch(() => [])
    const ok = await useUi.getState().confirm({
      title: `Delete ${pluralize(summary.deletes, 'row')} from ${qualified(tab)}?`,
      message: `${connection.name} is flagged as production. The changes run in a single transaction.`,
      detail: statements.length > 0 ? statements.join('\n') : undefined,
      confirmLabel: `Submit ${pluralize(count, 'change')}`,
      danger: true,
    })
    if (!ok) return
  }

  const changes = toRowChanges(s.changes)
  patchSession(tab.id, { submitting: true, submitError: undefined })
  try {
    const result = await api.data.applyChanges(tableRefOf(tab), changes)
    patchSession(tab.id, { submitting: false, changes: EMPTY_CHANGES })
    toast.success(`${pluralize(count, 'change')} applied`, {
      description: `${pluralize(result.affected, 'row')} affected in ${qualified(tab)}`,
    })
    await loadPage(tab, {}, true)
  } catch (error) {
    patchSession(tab.id, { submitting: false, submitError: errorInfo(error) })
  }
}

export function openSqlInConsole(tab: TableTab, sql: string): void {
  useTabs.getState().openConsole({ connectionId: tab.connectionId, database: tab.database, schema: tab.table.schema, content: sql })
}

/**
 * Open (or focus) the data tab of a table filtered by `where` — foreign-key navigation. A new tab
 * starts directly on the filter; an open one applies it (asking before discarding pending edits).
 */
export async function openTableFiltered(target: { connectionId: string; database: string; schema: string; name: string }, where: string): Promise<void> {
  const id = useTabs.getState().openTable({ ...target, kind: 'table' }, 'table')
  const tab = useTabs.getState().tabs.find((t): t is TableTab => t.id === id && t.kind === 'table')
  if (!tab) return
  if (!useTableSessions.getState().sessions[id]) {
    // the view loads the first page on mount, with this filter
    const maxRows = useSettings.getState().settings.maxRows
    const size = PAGE_SIZES.find((n) => n === maxRows) ?? DEFAULT_PAGE_SIZE
    patchSession(id, { ...initialSession(size), where, draftWhere: where })
    return
  }
  patchSession(id, { draftWhere: where })
  await applyFilter(tab, where)
}

export function openSibling(tab: TableTab, view: 'table' | 'structure'): void {
  useTabs.getState().openTable(
    { connectionId: tab.connectionId, database: tab.database, schema: tab.table.schema, name: tab.table.name, kind: tab.table.kind },
    view,
  )
}

// Closing a table tab with pending edits asks first; once closed, its session is dropped.
registerCloseGuard((tab) => {
  if (tab.kind !== 'table') return true
  const session = useTableSessions.getState().sessions[tab.id]
  if (!session || !hasChanges(session.changes)) return true
  useTabs.getState().setActive(tab.id)
  const count = changeCount(session.changes)
  return useUi.getState().confirm({
    title: `Close ${tab.table.name} and discard ${pluralize(count, 'pending change')}?`,
    message: `Unsubmitted edits to ${qualified(tab)} (${describeSummary(summarize(session.changes))}) will be lost.`,
    confirmLabel: 'Discard and close',
    cancelLabel: 'Keep editing',
    danger: true,
  })
})

onTabClosed((closed) => {
  if (closed.kind !== 'table') return
  dropSession(closed.id)
  sequence.delete(closed.id)
})
