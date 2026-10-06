// Command palette (⌘K) and "Go to object" (⌘P), driven by useUi().paletteOpen / paletteMode.
// Typing ">" at the start of the query switches between the two modes.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Command } from 'cmdk'
import { Dialog as RadixDialog, VisuallyHidden } from 'radix-ui'
import { ChevronRight, CircleDot, Clock, Command as CommandIcon, Database, Plus, RefreshCw, Search, TriangleAlert } from 'lucide-react'
import { ColorTag, DialectIcon, Kbd, overlayClass, renderIcon, SegmentedControl, Spinner, StatusDot } from '@/components/ui'
import { useCommands } from '@/lib/commands'
import { cn } from '@/lib/cn'
import { useReturnFocus } from '@/lib/focus'
import { useCatalog } from '@/stores/catalog'
import { useConnections } from '@/stores/connections'
import { defaultDatabase, useExplorer } from '@/stores/explorer'
import { useUi, type PaletteMode } from '@/stores/ui'
import { entryActions, runEntry } from './actions'
import { highlightRuns } from './fuzzy'
import {
  collectObjects,
  commandEntries,
  connectionEntries,
  groupCommands,
  KIND_LABEL,
  rankEntries,
  recentEntries,
  recordRecent,
  splitKey,
  type PaletteEntry,
  type PaletteGroup,
  type Ranked,
} from './items'
import { OBJECT_KIND_ICON } from './kind-icons'

const OBJECT_LIMIT = 60
const CONNECTION_LIMIT = 8
const EMPTY_QUERY_OBJECTS = 40

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen)
  const closePalette = useUi((s) => s.closePalette)
  // Set when an entry ran: its target (new tab, dialog) keeps the focus instead of the old element,
  // and when the entry moved focus nowhere (Format SQL, Run statement) the editor gets it back.
  const ranAction = useRef(false)
  const returnFocus = useReturnFocus(open)

  return (
    <RadixDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) closePalette()
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={overlayClass} />
        <div className="pointer-events-none fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]">
          <RadixDialog.Content
            onOpenAutoFocus={() => {
              ranAction.current = false
            }}
            onCloseAutoFocus={(e) => returnFocus(e, ranAction.current)}
            className={cn(
              'pointer-events-auto flex w-[640px] max-w-full flex-col overflow-hidden rounded-xl border border-line bg-elevated text-fg shadow-dialog outline-none',
              'data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out',
            )}
          >
            <VisuallyHidden.Root>
              <RadixDialog.Title>Command palette</RadixDialog.Title>
              <RadixDialog.Description>Search commands, connections and database objects</RadixDialog.Description>
            </VisuallyHidden.Root>
            {open && (
              <PaletteBody
                onRun={(entry, alt) => {
                  ranAction.current = true
                  closePalette()
                  // Let the dialog start closing so the target can take focus.
                  requestAnimationFrame(() => runEntry(entry, alt))
                }}
              />
            )}
          </RadixDialog.Content>
        </div>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

/** Load the default database's catalog of every connected connection (once per open). */
function useBackgroundObjects(): boolean {
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    let cancelled = false
    const { connections, runtime } = useConnections.getState()
    const targets = connections.filter((c) => runtime[c.id]?.status === 'connected')
    if (targets.length === 0) return
    setLoading(true)
    void Promise.allSettled(
      targets.map(async (c) => {
        let database = defaultDatabase(c.id)
        if (!database) {
          await useExplorer.getState().loadDatabases(c.id)
          database = defaultDatabase(c.id)
        }
        if (database) await useCatalog.getState().load(c.id, database)
      }),
    ).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return loading
}

interface CatalogProblem {
  key: string
  connectionId: string
  connectionName: string
  database: string
  error: string
}

function PaletteBody({ onRun }: { onRun: (entry: PaletteEntry, alt: boolean) => void }) {
  const mode = useUi((s) => s.paletteMode)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // Mode the user came from with ">" (Backspace on an empty query goes back).
  const cameFrom = useRef<PaletteMode | null>(null)

  const commands = useCommands()
  const connections = useConnections((s) => s.connections)
  const runtime = useConnections((s) => s.runtime)
  const objects = useExplorer((s) => s.objects)
  const catalogs = useCatalog((s) => s.catalogs)
  const backgroundLoading = useBackgroundObjects()

  const setMode = (next: PaletteMode) => {
    if (next !== mode) useUi.getState().openPalette(next)
  }

  const onQueryChange = (value: string) => {
    if (value.startsWith('>')) {
      const next: PaletteMode = mode === 'objects' ? 'commands' : 'objects'
      cameFrom.current = mode
      setMode(next)
      setQuery(value.slice(1).trimStart())
      return
    }
    setQuery(value)
  }

  const catalogLoading = useMemo(
    () =>
      Object.entries(catalogs).some(
        ([key, c]) => c.status === 'loading' && runtime[splitKey(key).connectionId]?.status === 'connected',
      ),
    [catalogs, runtime],
  )
  const loading = mode === 'objects' && (backgroundLoading || catalogLoading)

  const problems = useMemo<CatalogProblem[]>(() => {
    const out: CatalogProblem[] = []
    for (const [key, c] of Object.entries(catalogs)) {
      if (c.status !== 'error' || c.data) continue
      const { connectionId, rest } = splitKey(key)
      const connection = connections.find((x) => x.id === connectionId)
      if (!connection || runtime[connectionId]?.status !== 'connected') continue
      out.push({ key: `problem|${key}`, connectionId, connectionName: connection.name, database: rest, error: c.error ?? 'Unknown error' })
    }
    return out
  }, [catalogs, connections, runtime])

  const { groups, entries } = useMemo(() => {
    const trimmed = query.trim()
    const live = new Map<string, PaletteEntry>()
    const groups: PaletteGroup[] = []
    if (mode === 'commands') {
      const all = commandEntries(commands)
      for (const e of all) live.set(e.key, e)
      if (!trimmed) {
        const recent = recentEntries('commands', live)
        const recentKeys = new Set(recent.map((e) => e.key))
        if (recent.length > 0) groups.push({ heading: 'Recent', items: recent.map((entry) => ({ entry, score: 0, positions: [] })) })
        groups.push(...groupCommands(rankEntries('', all.filter((e) => !recentKeys.has(e.key))), false))
      } else {
        groups.push(...groupCommands(rankEntries(trimmed, all), true))
      }
    } else {
      const conns = connectionEntries(connections, runtime)
      const objs = collectObjects({ connections, runtime, objects, catalogs })
      for (const e of conns) live.set(e.key, e)
      for (const e of objs) live.set(e.key, e)
      if (!trimmed) {
        const recent = recentEntries('objects', live)
        const recentKeys = new Set(recent.map((e) => e.key))
        if (recent.length > 0) groups.push({ heading: 'Recent', items: recent.map((entry) => ({ entry, score: 0, positions: [] })) })
        const restConns = conns.filter((e) => !recentKeys.has(e.key)).map((entry) => ({ entry, score: 0, positions: [] }))
        if (restConns.length > 0) groups.push({ heading: 'Connections', items: restConns })
        const restObjs = rankEntries('', objs.filter((e) => !recentKeys.has(e.key)), EMPTY_QUERY_OBJECTS)
        if (restObjs.length > 0) groups.push({ heading: 'Objects', items: restObjs })
      } else {
        const rc: Ranked<PaletteEntry>[] = rankEntries(trimmed, conns, CONNECTION_LIMIT)
        const ro: Ranked<PaletteEntry>[] = rankEntries(trimmed, objs, OBJECT_LIMIT)
        const found = [
          { heading: 'Connections', items: rc },
          { heading: 'Objects', items: ro },
        ].filter((g) => g.items.length > 0)
        found.sort((a, b) => (b.items[0]?.score ?? 0) - (a.items[0]?.score ?? 0))
        groups.push(...found)
      }
    }
    const entries = new Map<string, PaletteEntry>()
    for (const g of groups) for (const item of g.items) entries.set(item.entry.key, item.entry)
    return { groups, entries }
  }, [mode, query, commands, connections, runtime, objects, catalogs])

  // Keep the selection on an existing row (first row after the list changes).
  const firstKey = groups[0]?.items[0]?.entry.key ?? ''
  // cmdk may scroll a reused row into view while the list reorders; settle at the top afterwards.
  useEffect(() => {
    setSelected(firstKey)
    const frame = requestAnimationFrame(() => listRef.current?.scrollTo({ top: 0 }))
    return () => cancelAnimationFrame(frame)
  }, [firstKey, mode, query])

  const current = entries.get(selected)
  const actions = entryActions(current, mode)

  const pick = (entry: PaletteEntry, alt: boolean) => {
    recordRecent(mode, entry)
    onRun(entry, alt)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' && e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      if (current) pick(current, true)
      return
    }
    if (e.key === 'Backspace' && query === '' && cameFrom.current && cameFrom.current !== mode) {
      e.preventDefault()
      const back = cameFrom.current
      cameFrom.current = null
      setMode(back)
    }
  }

  const retry = (problem: CatalogProblem) => {
    void useCatalog.getState().load(problem.connectionId, problem.database, true)
  }

  const showProblems = mode === 'objects' && problems.length > 0
  const nothing = groups.length === 0 && !showProblems

  return (
    <Command
      shouldFilter={false}
      loop
      value={selected}
      onValueChange={setSelected}
      onKeyDown={onKeyDown}
      label={mode === 'commands' ? 'Commands' : 'Go to object'}
      className="flex min-h-0 flex-col"
    >
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line pl-4 pr-2.5">
        <span className="flex shrink-0 text-subtle">{mode === 'commands' ? <CommandIcon size={16} strokeWidth={1.75} /> : <Search size={16} strokeWidth={1.75} />}</span>
        <Command.Input
          ref={inputRef}
          autoFocus
          value={query}
          onValueChange={onQueryChange}
          placeholder={mode === 'commands' ? 'Type a command…' : 'Go to a table, view, routine or connection…'}
          className="h-full min-w-0 flex-1 bg-transparent text-[14px] text-fg outline-none placeholder:text-faint"
        />
        {loading && <Spinner size={13} className="shrink-0 text-subtle" label="Loading objects" />}
        <SegmentedControl<PaletteMode>
          size="xs"
          aria-label="Palette mode"
          value={mode}
          onValueChange={(next) => {
            cameFrom.current = null
            setMode(next)
            inputRef.current?.focus()
          }}
          options={[
            { value: 'objects', label: 'Go to' },
            { value: 'commands', label: 'Commands' },
          ]}
        />
      </div>

      <Command.List ref={listRef} className="max-h-[min(56vh,440px)] min-h-0 overflow-y-auto overscroll-contain p-1.5">
        {nothing ? (
          <PaletteEmpty mode={mode} query={query.trim()} loading={loading} hasConnections={connections.length > 0} onRun={onRun} />
        ) : (
          <>
            {groups.map((group) => (
              <Command.Group key={group.heading} heading={<GroupHeading heading={group.heading} />} className={groupClass}>
                {group.items.map((item) => (
                  <PaletteItem key={item.entry.key} item={item} onPick={pick} />
                ))}
              </Command.Group>
            ))}
            {showProblems && (
              <Command.Group heading={<GroupHeading heading="Problems" />} className={groupClass}>
                {problems.map((p) => (
                  <Command.Item key={p.key} value={p.key} onSelect={() => retry(p)} className={itemClass}>
                    <TriangleAlert size={15} strokeWidth={1.75} className="shrink-0 text-warning" />
                    <span className="min-w-0 flex-1 truncate text-fg">
                      Couldn’t load objects from {p.connectionName}
                      <span className="ml-2 text-xs text-subtle">{p.error}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1 text-xs text-muted">
                      <RefreshCw size={12} strokeWidth={1.75} />
                      Retry
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}
            {mode === 'objects' && loading && (
              <div className="flex items-center gap-2 px-2.5 pb-1 pt-2 text-2xs text-subtle">
                <Spinner size={11} />
                Loading objects of connected databases…
              </div>
            )}
          </>
        )}
      </Command.List>

      <PaletteFooter mode={mode} primary={actions.primary} alt={actions.alt} />
    </Command>
  )
}

const groupClass = cn(
  '[&:not(:first-child)]:mt-1.5',
  '[&_[cmdk-group-heading]]:flex [&_[cmdk-group-heading]]:h-7 [&_[cmdk-group-heading]]:items-center [&_[cmdk-group-heading]]:px-2.5',
)

const itemClass = cn(
  'group flex h-8 cursor-default select-none items-center gap-2.5 rounded-md px-2.5 text-sm outline-none',
  'data-[selected=true]:bg-active data-[disabled=true]:opacity-40',
)

function GroupHeading({ heading }: { heading: string }) {
  return (
    <span className="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wider text-subtle">
      {heading === 'Recent' && <Clock size={11} strokeWidth={2} />}
      {heading}
    </span>
  )
}

function Highlight({ text, positions, className }: { text: string; positions: number[]; className?: string }) {
  return (
    <span className={cn('truncate', className)}>
      {highlightRuns(text, positions).map((run, i) =>
        run.match ? (
          <span key={i} className="font-semibold text-accent">
            {run.text}
          </span>
        ) : (
          <span key={i}>{run.text}</span>
        ),
      )}
    </span>
  )
}

function PaletteItem({ item, onPick }: { item: Ranked<PaletteEntry>; onPick: (entry: PaletteEntry, alt: boolean) => void }) {
  const { entry, positions } = item
  return (
    <Command.Item value={entry.key} onSelect={() => onPick(entry, false)} className={itemClass}>
      <ItemContent entry={entry} positions={positions} />
    </Command.Item>
  )
}

function ItemContent({ entry, positions }: { entry: PaletteEntry; positions: number[] }): ReactNode {
  switch (entry.type) {
    case 'command': {
      const c = entry.command
      const Icon = c.icon ?? CircleDot
      return (
        <>
          <span className="flex w-4 shrink-0 justify-center text-muted group-data-[selected=true]:text-fg [&>svg]:[stroke-width:1.75]">
            <Icon size={15} className="shrink-0" />
          </span>
          <Highlight text={c.title} positions={positions} className="min-w-0 flex-1 text-fg" />
          {c.shortcut && <Kbd shortcut={c.shortcut} className="shrink-0" />}
        </>
      )
    }
    case 'connection': {
      const c = entry.connection
      const status = useConnections.getState().runtime[c.id]?.status ?? 'disconnected'
      return (
        <>
          <DialectIcon dialect={c.dialect} size={16} title="" />
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <Highlight text={c.name} positions={positions} className="min-w-0 text-fg" />
            <ColorTag color={c.color} />
            <span className="min-w-0 truncate font-mono text-2xs text-subtle">
              {c.host}:{c.port}
              {c.database ? `/${c.database}` : ''}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5 text-2xs text-subtle">
            <StatusDot status={status} size={6} />
            {status === 'connected' ? 'Connected' : status === 'connecting' ? 'Connecting…' : status === 'error' ? 'Error' : 'Not connected'}
          </span>
        </>
      )
    }
    case 'object': {
      const connection = useConnections.getState().connections.find((c) => c.id === entry.connectionId)
      return (
        <>
          <span className="flex w-4 shrink-0 justify-center text-muted group-data-[selected=true]:text-fg" title={KIND_LABEL[entry.kind]}>
            {renderIcon(OBJECT_KIND_ICON[entry.kind], 15)}
          </span>
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
            <Highlight text={entry.name} positions={positions} className="min-w-0 max-w-[75%] shrink-0 text-fg" />
            <span className="shrink-0 font-mono text-2xs text-subtle">{entry.schema}</span>
            {entry.signature && <span className="min-w-0 flex-1 truncate font-mono text-2xs text-subtle">{entry.signature}</span>}
          </span>
          <span className="flex min-w-0 max-w-[40%] shrink-0 items-center gap-1.5 text-2xs text-subtle">
            <ColorTag color={connection?.color} size={6} />
            <span className="truncate">{entry.connectionName}</span>
            <ChevronRight size={10} strokeWidth={2} className="shrink-0 text-faint" />
            <span className="truncate">{entry.database}</span>
          </span>
        </>
      )
    }
  }
}

function PaletteEmpty({
  mode,
  query,
  loading,
  hasConnections,
  onRun,
}: {
  mode: PaletteMode
  query: string
  loading: boolean
  hasConnections: boolean
  onRun: (entry: PaletteEntry, alt: boolean) => void
}) {
  if (mode === 'objects' && loading) {
    return (
      <div aria-busy className="space-y-1 p-1">
        {[72, 54, 64, 46].map((w) => (
          <div key={w} className="flex h-8 items-center gap-2.5 px-1.5">
            <div className="skeleton size-4 rounded" />
            <div className="skeleton h-3 rounded" style={{ width: `${w}%` }} />
          </div>
        ))}
      </div>
    )
  }
  if (mode === 'objects' && !hasConnections) {
    return (
      <EmptyRow
        icon={<Database size={18} strokeWidth={1.75} />}
        title="No connections yet"
        description="Add a PostgreSQL or SQL Server connection to browse its objects."
        action={
          <Command.Item
            value="action|new-connection"
            onSelect={() =>
              onRun({ type: 'command', key: 'cmd|new-connection', command: { id: 'new-connection', title: 'New connection…', run: () => undefined } }, false)
            }
            className="mt-1 inline-flex h-7 cursor-default items-center gap-1.5 rounded-md bg-accent px-2.5 text-xs font-medium text-accent-fg outline-none data-[selected=true]:bg-accent-hover"
          >
            <Plus size={13} strokeWidth={2} />
            New connection
          </Command.Item>
        }
      />
    )
  }
  if (mode === 'objects') {
    return (
      <EmptyRow
        icon={<Search size={18} strokeWidth={1.75} />}
        title={query ? `No objects match “${query}”` : 'Nothing to show yet'}
        description="Searches connections and the loaded objects of connected databases. Type > for commands."
      />
    )
  }
  return (
    <EmptyRow
      icon={<CommandIcon size={18} strokeWidth={1.75} />}
      title={`No commands match “${query}”`}
      description="Try another word, or type > to go to an object."
    />
  )
}

function EmptyRow({ icon, title, description, action }: { icon: ReactNode; title: string; description: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1 px-6 py-8 text-center">
      <span className="mb-1.5 flex size-9 items-center justify-center rounded-lg border border-line bg-panel text-subtle shadow-inset">{icon}</span>
      <p className="text-sm font-medium text-fg">{title}</p>
      <p className="max-w-sm text-xs leading-[18px] text-subtle">{description}</p>
      {action}
    </div>
  )
}

function Hint({ keys, label }: { keys: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <Kbd shortcut={keys} />
      <span>{label}</span>
    </span>
  )
}

function PaletteFooter({ mode, primary, alt }: { mode: PaletteMode; primary: string; alt?: string }) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-4 border-t border-line bg-panel/60 px-3.5 text-2xs text-subtle">
      <span className="flex items-center gap-1.5">
        <span className="inline-flex items-center gap-0.5">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
        </span>
        <span>Navigate</span>
      </span>
      <Hint keys="Enter" label={primary} />
      {alt && <Hint keys="Alt+Enter" label={alt} />}
      <span className="flex-1" />
      <span className="flex items-center gap-1.5">
        <Kbd>&gt;</Kbd>
        <span>{mode === 'objects' ? 'Commands' : 'Go to object'}</span>
      </span>
      <span className="flex items-center gap-1.5">
        <Kbd>esc</Kbd>
        <span>Close</span>
      </span>
    </div>
  )
}
