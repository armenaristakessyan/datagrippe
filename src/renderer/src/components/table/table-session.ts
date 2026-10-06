// Per-tab state of the table data editor, kept outside React: table tabs unmount while inactive,
// and switching away must not lose the filter, the page or pending edits.
import { create } from 'zustand'
import type { DbErrorInfo, SortSpec, TableDataPage } from '@shared/types'
import { EMPTY_CHANGES, type PendingChanges } from './pending-changes'

export const PAGE_SIZES = [100, 200, 500, 1000] as const
export const DEFAULT_PAGE_SIZE = 500
const MAX_RECENT_FILTERS = 10

export interface TableSession {
  /** Text in the filter box. */
  draftWhere: string
  /** Predicate of the current page. */
  where: string
  sort: SortSpec[]
  pageSize: number
  offset: number
  page?: TableDataPage
  loading: boolean
  /** Fetch failure of the current request (the page is cleared). */
  error?: DbErrorInfo
  /** Exact row count for `where`, once requested. */
  exactCount?: number
  counting: boolean
  countError?: string
  changes: PendingChanges
  submitting: boolean
  submitError?: DbErrorInfo
}

export function initialSession(pageSize = DEFAULT_PAGE_SIZE): TableSession {
  return {
    draftWhere: '',
    where: '',
    sort: [],
    pageSize,
    offset: 0,
    loading: false,
    counting: false,
    changes: EMPTY_CHANGES,
    submitting: false,
  }
}

interface TableSessionsState {
  sessions: Record<string, TableSession>
  /** Table key → applied filters, most recent first (memory only). */
  recentFilters: Record<string, string[]>
}

export const useTableSessions = create<TableSessionsState>(() => ({ sessions: {}, recentFilters: {} }))

export function getSession(tabId: string): TableSession {
  return useTableSessions.getState().sessions[tabId] ?? initialSession()
}

export function patchSession(tabId: string, patch: Partial<TableSession> | ((s: TableSession) => Partial<TableSession>)): void {
  const { sessions } = useTableSessions.getState()
  const current = sessions[tabId] ?? initialSession()
  const next = { ...current, ...(typeof patch === 'function' ? patch(current) : patch) }
  useTableSessions.setState({ sessions: { ...sessions, [tabId]: next } })
}

export function dropSession(tabId: string): void {
  const { sessions } = useTableSessions.getState()
  if (!(tabId in sessions)) return
  const next = { ...sessions }
  delete next[tabId]
  useTableSessions.setState({ sessions: next })
}

/** Re-key a session (a closed tab restored under a new id). */
export function moveSession(fromTabId: string, toTabId: string): void {
  const { sessions } = useTableSessions.getState()
  const session = sessions[fromTabId]
  if (!session) return
  const next = { ...sessions, [toTabId]: session }
  delete next[fromTabId]
  useTableSessions.setState({ sessions: next })
}

export function tableKey(connectionId: string, database: string, schema: string, name: string): string {
  return `${connectionId}|${database}|${schema}|${name}`
}

export function pushRecentFilter(key: string, where: string): void {
  const value = where.trim()
  if (!value) return
  const { recentFilters } = useTableSessions.getState()
  const list = [value, ...(recentFilters[key] ?? []).filter((f) => f !== value)].slice(0, MAX_RECENT_FILTERS)
  useTableSessions.setState({ recentFilters: { ...recentFilters, [key]: list } })
}

export function clearRecentFilters(key: string): void {
  const { recentFilters } = useTableSessions.getState()
  const next = { ...recentFilters }
  delete next[key]
  useTableSessions.setState({ recentFilters: next })
}

/** ORDER BY chip helpers. */
export function removeSort(sort: readonly SortSpec[], column: string): SortSpec[] {
  return sort.filter((s) => s.column !== column)
}

export function flipSort(sort: readonly SortSpec[], column: string): SortSpec[] {
  return sort.map((s) => (s.column === column ? { ...s, direction: s.direction === 'asc' ? 'desc' : 'asc' } : s))
}
