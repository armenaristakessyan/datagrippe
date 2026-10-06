// Query history sheet (driven by useUi().historyOpen). Entries can be inserted into the active
// console or opened in a new one; nothing is ever re-run from here.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Check, CircleCheck, CircleX, Copy, History, MoreHorizontal, RefreshCw, Search, SquareTerminal, TextCursorInput, Trash2 } from 'lucide-react'
import type { ConnectionConfig, HistoryEntry } from '@shared/types'
import {
  Button,
  Callout,
  ColorTag,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  IconButton,
  Input,
  Kbd,
  ProgressBar,
  Sheet,
  Skeleton,
  SqlText,
  Switch,
  toast,
  Tooltip,
} from '@/components/ui'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { getEditor } from '@/lib/editor-registry'
import { formatCount, formatDuration, formatRelativeTime, formatTimestamp, pluralize } from '@/lib/format'
import { useConnections } from '@/stores/connections'
import { activeTab, useTabs } from '@/stores/tabs'
import { useUi } from '@/stores/ui'
import { HISTORY_PAGE, useHistoryEntries } from './useHistoryEntries'
import { previewSql, sqlSummary } from './preview'

const SHEET_WIDTH = 480
const ROW_ESTIMATE = 92

export function HistoryPanel() {
  const open = useUi((s) => s.historyOpen)
  const setOpen = useUi((s) => s.setHistoryOpen)
  return (
    <Sheet
      open={open}
      onOpenChange={setOpen}
      title="Query history"
      width={SHEET_WIDTH}
      bodyClassName="flex flex-col overflow-hidden"
    >
      {open && <HistoryBody onClose={() => setOpen(false)} />}
    </Sheet>
  )
}

/** Connection of the active tab (any kind). */
function useCurrentConnection(): ConnectionConfig | undefined {
  const connectionId = useTabs((s) => s.tabs.find((t) => t.id === s.activeTabId)?.connectionId)
  return useConnections((s) => s.connections.find((c) => c.id === connectionId))
}

function insertIntoActiveConsole(entry: HistoryEntry, close: () => void): void {
  const tab = activeTab()
  const editor = tab?.kind === 'console' ? getEditor(tab.id) : undefined
  if (!editor) {
    openInNewConsole(entry, close)
    return
  }
  editor.insertText(entry.sql)
  close()
  requestAnimationFrame(() => editor.focus())
}

function openInNewConsole(entry: HistoryEntry, close: () => void): void {
  if (!useConnections.getState().connections.some((c) => c.id === entry.connectionId)) {
    toast.error('This connection no longer exists', undefined, { description: 'Copy the query and paste it into a console instead.' })
    return
  }
  // The schema it ran in, so unqualified names resolve the same way again.
  useTabs.getState().openConsole({ connectionId: entry.connectionId, database: entry.database, schema: entry.schema, content: entry.sql })
  close()
}

function HistoryBody({ onClose }: { onClose: () => void }) {
  const current = useCurrentConnection()
  const [search, setSearch] = useState('')
  const [currentOnly, setCurrentOnly] = useState(() => activeTab()?.kind === 'console')
  const filterId = currentOnly ? current?.id : undefined
  const { state, reload, searching } = useHistoryEntries(true, filterId, search)
  const connections = useConnections((s) => s.connections)
  const byId = useMemo(() => new Map(connections.map((c) => [c.id, c])), [connections])
  const [selected, setSelected] = useState(0)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const now = useNow(30_000)

  const entries = state.entries
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE,
    overscan: 6,
    getItemKey: (index) => entries[index]?.id ?? index,
  })

  // New result set → select the newest entry.
  useEffect(() => {
    setSelected(0)
    virtualizer.scrollToOffset(0)
  }, [entries, virtualizer])

  const move = (delta: number) => {
    if (entries.length === 0) return
    const next = Math.max(0, Math.min(entries.length - 1, selected + delta))
    setSelected(next)
    virtualizer.scrollToIndex(next, { align: 'auto' })
  }

  const copy = async (entry: HistoryEntry) => {
    try {
      await navigator.clipboard.writeText(entry.sql)
      setCopiedId(entry.id)
      setTimeout(() => setCopiedId((id) => (id === entry.id ? null : id)), 1200)
    } catch (error) {
      toast.error('Could not copy to the clipboard', error)
    }
  }

  const onKeyDown = (e: KeyboardEvent) => {
    const entry = entries[selected]
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      move(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      move(-1)
    } else if (e.key === 'PageDown') {
      e.preventDefault()
      move(8)
    } else if (e.key === 'PageUp') {
      e.preventDefault()
      move(-8)
    } else if (e.key === 'Enter' && entry) {
      // Also keeps ⌘↵ away from the native "Run statement" accelerator.
      e.preventDefault()
      if (e.metaKey || e.ctrlKey) openInNewConsole(entry, onClose)
      else insertIntoActiveConsole(entry, onClose)
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c' && entry && e.target === scrollRef.current) {
      e.preventDefault()
      void copy(entry)
    }
  }

  const clear = async (connection: ConnectionConfig | undefined) => {
    const ok = await useUi.getState().confirm({
      title: connection ? `Clear the history of “${connection.name}”?` : 'Clear all query history?',
      message: connection
        ? 'Every query run on this connection is removed from the history. This cannot be undone.'
        : 'Every query of every connection is removed from the history. This cannot be undone.',
      confirmLabel: 'Clear history',
      danger: true,
    })
    if (!ok) return
    try {
      await api.history.clear(connection?.id)
      toast.success(connection ? `History of ${connection.name} cleared` : 'History cleared')
      void reload()
    } catch (error) {
      toast.error('Could not clear the history', error)
    }
  }

  const firstLoad = state.status === 'loading' && entries.length === 0
  const truncated = entries.length >= HISTORY_PAGE

  return (
    <>
      <div className="flex shrink-0 flex-col gap-2.5 border-b border-line px-3 pb-3 pt-3">
        <div className="flex items-center gap-1.5">
          <Input
            ref={searchRef}
            autoFocus
            leadingIcon={Search}
            placeholder="Search SQL…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onClear={() => setSearch('')}
            onKeyDown={onKeyDown}
            aria-label="Search history"
            aria-controls="history-list"
            wrapperClassName="flex-1"
          />
          <IconButton icon={RefreshCw} label="Refresh" onClick={() => void reload()} loading={state.status === 'loading' && entries.length > 0} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton icon={MoreHorizontal} label="More" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Clear history</DropdownMenuLabel>
              {current && (
                <DropdownMenuItem icon={<ColorTag color={current.color} showNone />} onSelect={() => void clear(current)}>
                  Clear “{current.name}”…
                </DropdownMenuItem>
              )}
              {current && <DropdownMenuSeparator />}
              <DropdownMenuItem icon={Trash2} danger onSelect={() => void clear(undefined)}>
                Clear all history…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="flex h-5 items-center justify-between gap-3">
          <Switch
            size="sm"
            checked={currentOnly && !!current}
            disabled={!current}
            onCheckedChange={setCurrentOnly}
            label={
              <span className="flex items-center gap-1.5 text-xs text-muted">
                Current connection only
                {current && (
                  <span className="flex min-w-0 items-center gap-1 text-subtle">
                    <ColorTag color={current.color} size={6} />
                    <span className="max-w-[140px] truncate">{current.name}</span>
                  </span>
                )}
              </span>
            }
            className="flex-row-reverse items-center gap-2"
          />
          {!firstLoad && entries.length > 0 && (
            <span className="shrink-0 text-2xs text-subtle tabular">
              {truncated ? `Latest ${formatCount(entries.length)}` : pluralize(entries.length, 'query', 'queries')}
            </span>
          )}
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
        {state.status === 'loading' && entries.length > 0 && <ProgressBar className="absolute inset-x-0 top-0 z-10" />}
        {state.status === 'error' && (
          <div className="shrink-0 p-3">
            <Callout
              tone="danger"
              title="Could not load the history"
              actions={
                <Button size="xs" leadingIcon={RefreshCw} onClick={() => void reload()}>
                  Retry
                </Button>
              }
            >
              {state.error}
            </Callout>
          </div>
        )}
        {firstLoad ? (
          <HistorySkeleton />
        ) : entries.length === 0 && state.status !== 'error' ? (
          <EmptyState
            icon={searching ? Search : History}
            title={searching ? 'No matching queries' : 'No queries yet'}
            description={
              searching
                ? `Nothing in the history contains “${search.trim()}”.`
                : currentOnly && current
                  ? `Queries you run on ${current.name} will show up here.`
                  : 'Queries you run in a console will show up here.'
            }
            action={
              searching ? (
                <Button size="sm" onClick={() => setSearch('')}>
                  Clear search
                </Button>
              ) : currentOnly && current ? (
                <Button size="sm" onClick={() => setCurrentOnly(false)}>
                  Show all connections
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div
            id="history-list"
            ref={scrollRef}
            role="listbox"
            aria-label="Query history"
            aria-activedescendant={entries[selected] ? `history-${entries[selected].id}` : undefined}
            tabIndex={0}
            onKeyDown={onKeyDown}
            className="min-h-0 flex-1 overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
          >
            <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((item) => {
                const entry = entries[item.index]
                if (!entry) return null
                return (
                  <div
                    key={item.key}
                    data-index={item.index}
                    ref={virtualizer.measureElement}
                    className="absolute inset-x-0 top-0"
                    style={{ transform: `translateY(${item.start}px)` }}
                  >
                    <HistoryRow
                      entry={entry}
                      connection={byId.get(entry.connectionId)}
                      selected={item.index === selected}
                      copied={copiedId === entry.id}
                      now={now}
                      onSelect={() => setSelected(item.index)}
                      onInsert={() => insertIntoActiveConsole(entry, onClose)}
                      onOpen={() => openInNewConsole(entry, onClose)}
                      onCopy={() => void copy(entry)}
                    />
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      <div className="flex h-9 shrink-0 items-center gap-4 border-t border-line bg-panel/60 px-3.5 text-2xs text-subtle">
        <span className="flex items-center gap-1.5">
          <span className="inline-flex items-center gap-0.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
          </span>
          Select
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd shortcut="Enter" />
          Insert
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd shortcut="CmdOrCtrl+Enter" />
          Open in new console
        </span>
      </div>
    </>
  )
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

interface HistoryRowProps {
  entry: HistoryEntry
  connection: ConnectionConfig | undefined
  selected: boolean
  copied: boolean
  now: number
  onSelect: () => void
  onInsert: () => void
  onOpen: () => void
  onCopy: () => void
}

function HistoryRow({ entry, connection, selected, copied, now, onSelect, onInsert, onOpen, onCopy }: HistoryRowProps) {
  const preview = useMemo(() => previewSql(entry.sql), [entry.sql])
  const rows = entry.rowCount
  return (
    <div
      id={`history-${entry.id}`}
      role="option"
      aria-selected={selected}
      aria-label={sqlSummary(entry.sql)}
      onMouseDown={onSelect}
      onDoubleClick={onInsert}
      className={cn(
        'group relative border-b border-line px-3.5 pb-2.5 pt-2.5 transition-colors duration-75',
        selected ? 'bg-active' : 'hover:bg-hover',
      )}
    >
      {selected && <span aria-hidden className="absolute inset-y-0 left-0 w-[2px] bg-accent" />}
      <div className="flex h-4 items-center gap-1.5 text-2xs">
        <ColorTag color={connection?.color} size={6} showNone />
        <span className={cn('min-w-0 truncate font-medium', connection ? 'text-muted' : 'text-subtle italic')}>
          {connection?.name ?? 'Deleted connection'}
        </span>
        {entry.database && (
          <>
            <span className="text-faint">›</span>
            <span className="min-w-0 truncate text-subtle">{entry.database}</span>
          </>
        )}
        {entry.schema && (
          <>
            <span className="text-faint">›</span>
            <span className="min-w-0 truncate text-subtle">{entry.schema}</span>
          </>
        )}
        <span className="flex-1" />
        <Tooltip content={formatTimestamp(entry.executedAt)} side="left">
          <time dateTime={entry.executedAt} className="shrink-0 text-subtle tabular">
            {formatRelativeTime(entry.executedAt, now)}
          </time>
        </Tooltip>
      </div>

      <div className="selectable mt-1.5 line-clamp-3 whitespace-pre-wrap font-mono text-xs leading-[18px] text-fg [overflow-wrap:anywhere]">
        <SqlText code={preview} />
      </div>

      <div className="mt-1.5 flex h-5 items-center gap-2 text-2xs text-subtle tabular">
        {entry.success ? (
          <CircleCheck size={12} strokeWidth={2} className="shrink-0 text-success" aria-label="Succeeded" />
        ) : (
          <Tooltip content={entry.error ?? 'The query failed'} side="top" align="start">
            <span className="flex min-w-0 items-center gap-1 text-danger">
              <CircleX size={12} strokeWidth={2} className="shrink-0" aria-label="Failed" />
              <span className="max-w-[180px] truncate">{entry.error ?? 'Failed'}</span>
            </span>
          </Tooltip>
        )}
        <span>{formatDuration(entry.durationMs)}</span>
        {entry.truncated && (
          <Tooltip content="Only the first 64 KB of this script were kept: running it will not run the full original." side="top">
            <span className="rounded-[4px] border border-line px-1 text-2xs leading-4 text-subtle">truncated</span>
          </Tooltip>
        )}
        {rows !== null && rows !== undefined && entry.success && (
          <>
            <span className="text-faint">·</span>
            <span>{pluralize(rows, 'row')}</span>
          </>
        )}
        <span className="flex-1" />
        <div
          className={cn(
            'flex items-center gap-0.5 transition-opacity duration-100',
            selected ? 'opacity-100' : 'opacity-0 focus-within:opacity-100 group-hover:opacity-100',
          )}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <IconButton size="xs" icon={TextCursorInput} label="Insert into console" shortcut="Enter" tooltipSide="top" onClick={onInsert} tabIndex={-1} />
          <IconButton
            size="xs"
            icon={SquareTerminal}
            label="Open in new console"
            shortcut="CmdOrCtrl+Enter"
            tooltipSide="top"
            disabled={!connection}
            onClick={onOpen}
            tabIndex={-1}
          />
          <IconButton
            size="xs"
            icon={copied ? <Check size={13} strokeWidth={2.25} className="text-success" /> : Copy}
            label={copied ? 'Copied' : 'Copy SQL'}
            tooltipSide="top"
            onClick={onCopy}
            tabIndex={-1}
          />
        </div>
      </div>
    </div>
  )
}

function HistorySkeleton() {
  return (
    <div aria-busy className="flex flex-col">
      {[78, 56, 88, 64, 70].map((w, i) => (
        <div key={i} className="space-y-2 border-b border-line px-3.5 py-3">
          <div className="flex items-center justify-between">
            <Skeleton width={120} height={10} />
            <Skeleton width={48} height={10} />
          </div>
          <Skeleton width={`${w}%`} height={12} />
          <Skeleton width={`${w - 24}%`} height={12} />
          <Skeleton width={90} height={10} />
        </div>
      ))}
    </div>
  )
}
