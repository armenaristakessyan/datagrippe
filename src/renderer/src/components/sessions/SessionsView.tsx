// Server sessions tab: who is connected, what runs, what waits on whom — with Cancel query and
// Terminate session (always confirmed, never on this view's own session).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Activity, Ban, OctagonX, RefreshCw, Search, SearchX, SquareTerminal } from 'lucide-react'
import type { ColumnMeta, DbErrorInfo, CellValue } from '@shared/types'
import { DataGrid, type GridMenuItem, type GridSelection } from '@/components/grid/DataGrid'
import {
  Button,
  Callout,
  EmptyState,
  IconButton,
  Input,
  SkeletonLines,
  Switch,
  Toolbar,
  ToolbarGroup,
  ToolbarSeparator,
  ToolbarSpacer,
  Tooltip,
  toast,
} from '@/components/ui'
import { errorInfo } from '@/lib/api'
import { registerCommands } from '@/lib/commands'
import { formatCount, formatDuration, pluralize } from '@/lib/format'
import { useConnections } from '@/stores/connections'
import { useTabs, type SessionsTab } from '@/stores/tabs'
import { useUi } from '@/stores/ui'
import {
  actionSucceeded,
  filterSessions,
  isActive,
  parseSessions,
  sessionActionSql,
  SESSIONS_SQL,
  supportsCancel,
  type ServerSession,
  type SessionAction,
} from './queries'
import { runOnSessionsTab } from './session-runner'

const REFRESH_MS = 3000

// The query comes early: with many columns the grid scrolls horizontally, and it is what people scan.
const COLUMNS: ColumnMeta[] = [
  { name: 'PID', dataType: 'int4' },
  { name: 'User', dataType: 'text' },
  { name: 'Database', dataType: 'text' },
  { name: 'State', dataType: 'text' },
  { name: 'In state', dataType: 'interval' },
  { name: 'Query', dataType: 'text' },
  { name: 'Wait', dataType: 'text' },
  { name: 'Blocked by', dataType: 'text' },
  { name: 'Transaction', dataType: 'interval' },
  { name: 'Application', dataType: 'text' },
  { name: 'Client', dataType: 'text' },
]

function toRow(s: ServerSession): CellValue[] {
  return [
    s.pid,
    s.user,
    s.database,
    s.self ? `${s.state ?? '—'} (this view)` : s.state,
    s.stateMs === null ? null : formatDuration(s.stateMs),
    s.query,
    s.wait,
    s.blockedBy,
    s.transactionMs === null ? (s.inTransaction ? 'open' : null) : formatDuration(s.transactionMs),
    s.application,
    s.client,
  ]
}

// Remembered while the app runs.
// Auto-refresh starts off: every refresh is a query, and the main process records console queries in
// the history unless it honours `history: false` (see session-runner.ts).
let autoRefreshPreference = false
let hideIdlePreference = false

interface LoadState {
  sessions: ServerSession[]
  loading: boolean
  loadedAt?: number
  error?: DbErrorInfo
}

export function SessionsView({ tab }: { tab: SessionsTab }) {
  const connection = useConnections((s) => s.connections.find((c) => c.id === tab.connectionId))
  const dialect = connection?.dialect ?? 'postgres'
  const [state, setState] = useState<LoadState>({ sessions: [], loading: true })
  const [filter, setFilter] = useState('')
  const [hideIdle, setHideIdle] = useState(hideIdlePreference)
  const [auto, setAuto] = useState(autoRefreshPreference)
  const [selectedPid, setSelectedPid] = useState<number | null>(null)
  const inflight = useRef(false)
  // Paused while a confirmation is open, so the list does not move under the decision.
  const paused = useRef(false)
  const alive = useRef(true)

  const refresh = useCallback(async () => {
    if (inflight.current) return
    inflight.current = true
    setState((s) => ({ ...s, loading: true }))
    try {
      const execution = await runOnSessionsTab(tab, SESSIONS_SQL[dialect])
      const result = execution.results[0]
      if (!result || result.kind === 'error') throw result?.error ?? new Error('The server returned no session list')
      if (alive.current) setState({ sessions: parseSessions(result), loading: false, loadedAt: Date.now() })
    } catch (error) {
      const info = toInfo(error)
      if (alive.current) setState((s) => ({ ...s, loading: false, error: info }))
    } finally {
      inflight.current = false
    }
  }, [tab, dialect])

  useEffect(() => {
    alive.current = true
    void refresh()
    return () => {
      alive.current = false
    }
  }, [refresh])

  useEffect(() => {
    if (!auto) return
    const timer = setInterval(() => {
      if (!document.hidden && !paused.current) void refresh()
    }, REFRESH_MS)
    return () => clearInterval(timer)
  }, [auto, refresh])

  const visible = useMemo(() => filterSessions(state.sessions, filter, hideIdle), [state.sessions, filter, hideIdle])
  const rows = useMemo(() => visible.map(toRow), [visible])
  const selected = selectedPid === null ? undefined : state.sessions.find((s) => s.pid === selectedPid)

  const act = useCallback(
    async (action: SessionAction, targets: ServerSession[]) => {
      const list = targets.filter((s) => !s.self)
      if (list.length === 0) {
        toast.info('This is the session of this view', { description: 'Pick another session.' })
        return
      }
      const cancel = action === 'cancel'
      const subject = list.length === 1 ? `session ${list[0]!.pid}` : pluralize(list.length, 'session')
      const who = list.length === 1 ? describeSession(list[0]!) : undefined
      const production = connection?.productionGuard ? ` “${connection.name}” is a production connection.` : ''
      paused.current = true
      try {
        const ok = await useUi.getState().confirm({
          title: cancel ? `Cancel the running query of ${subject}?` : `Terminate ${subject}?`,
          message: `${who ? `${who}. ` : ''}${
            cancel
              ? 'The statement stops with an error; the session stays connected.'
              : 'The connection is closed and its open transaction is rolled back.'
          }${production}`,
          detail: list
            .map((s) => s.query?.trim())
            .filter((q): q is string => Boolean(q))
            .join(';\n\n') || undefined,
          confirmLabel: cancel ? 'Cancel query' : 'Terminate',
          cancelLabel: cancel ? 'Keep running' : 'Keep session',
          danger: true,
        })
        if (!ok) return
        const failed: number[] = []
        for (const s of list) {
          try {
            const execution = await runOnSessionsTab(tab, sessionActionSql(dialect, action, s.pid))
            const result = execution.results[0]
            if (result?.kind === 'error') throw result.error ?? new Error('Failed')
            if (!actionSucceeded(dialect, result)) failed.push(s.pid)
          } catch (error) {
            toast.error(`Could not ${cancel ? 'cancel the query of' : 'terminate'} session ${s.pid}`, undefined, { description: toInfo(error).message })
            return
          }
        }
        if (failed.length > 0) {
          toast.warning(`${failed.length === 1 ? `Session ${failed[0]}` : pluralize(failed.length, 'session')} not signalled`, {
            description: 'It may have ended already, or your role lacks the permission to signal it.',
          })
        } else {
          toast.success(cancel ? `Cancelled the query of ${subject}` : `Terminated ${subject}`)
        }
      } finally {
        paused.current = false
        void refresh()
      }
    },
    [connection, dialect, refresh, tab],
  )

  const openQuery = useCallback(
    (s: ServerSession) => {
      if (!s.query) return
      useTabs.getState().openConsole({ connectionId: tab.connectionId, database: s.database ?? undefined, content: `${s.query.trim()}\n`, title: `Session ${s.pid}` })
    },
    [tab.connectionId],
  )

  const canCancel = (s: ServerSession | undefined) => Boolean(s && !s.self && supportsCancel(dialect) && isActive(s))
  const canTerminate = (s: ServerSession | undefined) => Boolean(s && !s.self)

  // Palette entries while the view is open.
  useEffect(
    () =>
      registerCommands([
        { id: 'sessions.refresh', title: 'Refresh sessions', group: 'Sessions', icon: RefreshCw, keywords: ['reload', 'activity'], run: () => refresh() },
        {
          id: 'sessions.toggle-auto-refresh',
          title: auto ? 'Stop auto-refreshing sessions' : 'Auto-refresh sessions',
          group: 'Sessions',
          icon: Activity,
          run: () => {
            autoRefreshPreference = !auto
            setAuto(!auto)
          },
        },
        ...(canCancel(selected)
          ? [{ id: 'sessions.cancel', title: `Cancel query of session ${selected!.pid}…`, group: 'Sessions', icon: Ban, run: () => act('cancel', [selected!]) }]
          : []),
        ...(canTerminate(selected)
          ? [{ id: 'sessions.terminate', title: `Terminate session ${selected!.pid}…`, group: 'Sessions', icon: OctagonX, keywords: ['kill'], run: () => act('terminate', [selected!]) }]
          : []),
      ]),
    // canCancel / canTerminate depend on `selected` and `dialect` only.
    [refresh, auto, selected, act, dialect],
  )

  const onSelectionChange = (selection: GridSelection | null) => {
    const row = selection?.focus.row
    setSelectedPid(row === undefined ? null : (visible[row]?.pid ?? null))
  }

  const contextMenuItems = ({ rows: picked }: { rows: number[] }): GridMenuItem[] => {
    const targets = picked.map((i) => visible[i]).filter((s): s is ServerSession => s !== undefined)
    const others = targets.filter((s) => !s.self)
    const one = targets.length === 1 ? targets[0] : undefined
    const items: GridMenuItem[] = [{ separator: true }]
    if (supportsCancel(dialect)) {
      items.push({ label: others.length > 1 ? `Cancel ${others.length} queries…` : 'Cancel query…', disabled: !others.some(isActive), onSelect: () => void act('cancel', others.filter(isActive)) })
    }
    items.push({ label: others.length > 1 ? `Terminate ${others.length} sessions…` : 'Terminate session…', danger: true, disabled: others.length === 0, onSelect: () => void act('terminate', others) })
    if (one?.query) items.push({ separator: true }, { label: 'Open query in console', onSelect: () => openQuery(one) })
    return items
  }

  const active = state.sessions.filter(isActive).length
  const blocked = state.sessions.filter((s) => s.blockedBy).length
  const first = state.loadedAt === undefined

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <Toolbar aria-label="Sessions">
        <ToolbarGroup className="gap-2">
          <Input
            size="sm"
            leadingIcon={Search}
            value={filter}
            placeholder="Filter by user, database, application or query"
            aria-label="Filter sessions"
            wrapperClassName="w-72"
            onChange={(e) => setFilter(e.target.value)}
            onClear={() => setFilter('')}
          />
          <label className="flex cursor-default select-none items-center gap-1.5 text-xs text-muted">
            <Switch
              size="sm"
              checked={hideIdle}
              aria-label="Hide idle sessions"
              onCheckedChange={(v) => {
                hideIdlePreference = v
                setHideIdle(v)
              }}
            />
            Hide idle
          </label>
        </ToolbarGroup>
        <ToolbarSpacer />
        <ToolbarGroup className="gap-1.5">
          {supportsCancel(dialect) && (
            <Button size="xs" variant="secondary" leadingIcon={Ban} disabled={!canCancel(selected)} onClick={() => selected && void act('cancel', [selected])}>
              Cancel query
            </Button>
          )}
          <Button size="xs" variant="secondary" leadingIcon={OctagonX} disabled={!canTerminate(selected)} onClick={() => selected && void act('terminate', [selected])}>
            Terminate
          </Button>
        </ToolbarGroup>
        <ToolbarSeparator />
        <ToolbarGroup className="gap-1.5">
          <label className="flex cursor-default select-none items-center gap-1.5 text-xs text-muted">
            <Switch
              size="sm"
              checked={auto}
              aria-label="Auto-refresh every 3 seconds"
              onCheckedChange={(v) => {
                autoRefreshPreference = v
                setAuto(v)
              }}
            />
            Auto-refresh
          </label>
          <IconButton size="xs" icon={RefreshCw} label="Refresh" loading={state.loading && !auto} onClick={() => void refresh()} />
        </ToolbarGroup>
      </Toolbar>

      {state.error && (
        <div className="shrink-0 border-b border-line p-3">
          <Callout
            tone="danger"
            title={state.error.message}
            actions={
              <Button size="xs" leadingIcon={RefreshCw} onClick={() => void refresh()}>
                Retry
              </Button>
            }
          >
            {state.error.detail ?? state.error.hint ?? (dialect === 'mssql' ? 'Seeing other sessions needs the VIEW SERVER STATE permission.' : undefined)}
          </Callout>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {first && state.loading ? (
          <SkeletonLines count={6} className="p-3" />
        ) : first && state.error ? null : (
          <DataGrid
            aria-label="Server sessions"
            columns={COLUMNS}
            rows={rows}
            rowKey={(i) => String(visible[i]?.pid ?? i)}
            dialect={dialect}
            onSelectionChange={onSelectionChange}
            contextMenuItems={contextMenuItems}
            emptyState={
              <EmptyState
                size="compact"
                icon={filter || hideIdle ? SearchX : Activity}
                title={filter || hideIdle ? 'No matching sessions' : 'No sessions'}
                description={filter || hideIdle ? 'Clear the filter or show idle sessions.' : 'Nobody else is connected.'}
                action={
                  filter || hideIdle ? (
                    <Button
                      size="xs"
                      onClick={() => {
                        setFilter('')
                        setHideIdle(false)
                      }}
                    >
                      Show all
                    </Button>
                  ) : undefined
                }
              />
            }
          />
        )}
      </div>

      <div className="flex h-7 shrink-0 items-center gap-3 border-t border-line bg-panel px-3 text-2xs text-subtle">
        <span className="tabular">
          {pluralize(state.sessions.length, 'session')}
          {active > 0 && ` · ${formatCount(active)} active`}
          {blocked > 0 && <span className="text-warning"> · {formatCount(blocked)} waiting on a lock</span>}
          {visible.length !== state.sessions.length && ` · ${formatCount(visible.length)} shown`}
        </span>
        <span className="flex-1" />
        <span className="hidden items-center gap-1 sm:flex">
          <SquareTerminal size={11} strokeWidth={1.75} aria-hidden />
          Right-click a session to cancel or terminate it
        </span>
        {state.loadedAt !== undefined && (
          <Tooltip content={auto ? `Refreshes every ${REFRESH_MS / 1000} seconds` : 'Auto-refresh is off'} side="top">
            <span className="tabular">Updated {new Date(state.loadedAt).toLocaleTimeString()}</span>
          </Tooltip>
        )}
      </div>
    </div>
  )
}

/** Errors arrive as exceptions (ApiError) or as a failed statement's DbErrorInfo. */
function toInfo(error: unknown): DbErrorInfo {
  if (error instanceof Error) return errorInfo(error)
  if (error && typeof error === 'object' && typeof (error as DbErrorInfo).message === 'string') return error as DbErrorInfo
  return errorInfo(error)
}

function describeSession(s: ServerSession): string {
  const parts = [s.user ? `${s.user}` : undefined, s.database ? `on ${s.database}` : undefined, s.application ? `(${s.application})` : undefined]
  return parts.filter(Boolean).join(' ') || `Session ${s.pid}`
}
