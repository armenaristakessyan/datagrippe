// Console toolbar: run split-button (Cancel in place while running / connecting), connection / database /
// schema pickers, transaction mode, and view actions.
import { useMemo } from 'react'
import {
  ChevronDown,
  CircleStop,
  Database,
  Gauge,
  History,
  Layers,
  ListTree,
  Lock,
  PanelBottomClose,
  PanelBottomOpen,
  Play,
  RefreshCw,
  ScrollText,
  ShieldAlert,
  Undo2,
  WandSparkles,
  Check,
} from 'lucide-react'
import type { ConnectionConfig, Dialect } from '@shared/types'
import {
  Badge,
  Button,
  ColorTag,
  Combobox,
  DialectIcon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  SegmentedControl,
  Toolbar,
  ToolbarGroup,
  ToolbarSeparator,
  ToolbarSpacer,
  Tooltip,
  type ComboboxOption,
} from '@/components/ui'
import { cn } from '@/lib/cn'
import { getEditor } from '@/lib/editor-registry'
import { formatBytes } from '@/lib/format'
import { formatShortcut } from '@/lib/shortcuts'
import { useCatalog } from '@/stores/catalog'
import { useConnections } from '@/stores/connections'
import { displayedAutoCommit, useConsoles, wantsManualCommit, type ConsoleRuntime } from '@/stores/consoles'
import { dbKey, useExplorer } from '@/stores/explorer'
import { useTabs, type ConsoleTab } from '@/stores/tabs'
import { useUi } from '@/stores/ui'
import { explainConsole, formatConsole, runConsole } from './console-actions'
import { CONSOLE_SHORTCUTS } from './console-commands'

export interface ConsoleToolbarProps {
  tab: ConsoleTab
  connection: ConnectionConfig | undefined
  runtime: ConsoleRuntime
  dialect: Dialect
  database: string | undefined
  resultsCollapsed: boolean
  onToggleResults: () => void
}

const focusEditor = (tabId: string) => getEditor(tabId)?.focus()
/** After a popover / toggle closes and Radix restores focus to its trigger, hand focus back to the editor. */
const refocusEditor = (tabId: string) => requestAnimationFrame(() => focusEditor(tabId))

export function ConsoleToolbar({ tab, connection, runtime, dialect, database, resultsCollapsed, onToggleResults }: ConsoleToolbarProps) {
  const running = runtime.status === 'running'
  const busy = running || runtime.status === 'connecting' || runtime.explaining

  return (
    // A size container: the badges collapse to icons when the toolbar is narrow.
    <Toolbar aria-label="Console toolbar" className="@container gap-1 overflow-hidden">
      <ToolbarGroup className="shrink-0 gap-1.5">
        <RunButton tabId={tab.id} runtime={runtime} />
      </ToolbarGroup>

      <ToolbarSeparator />

      {/* While a statement runs (or the session connects) the target cannot change: switching would
          silently cancel it, or run it somewhere else than the toolbar says. */}
      <ToolbarGroup className="min-w-0 gap-0.5">
        <ConnectionPicker tab={tab} connection={connection} runtime={runtime} disabled={busy} />
        {connection && <DatabasePicker tab={tab} connection={connection} runtime={runtime} database={database} dialect={dialect} disabled={busy} />}
        {connection && database && <SchemaPicker tab={tab} runtime={runtime} database={database} dialect={dialect} disabled={busy} />}
      </ToolbarGroup>

      {connection && (
        <>
          <ToolbarSeparator />
          <TransactionControls tabId={tab.id} runtime={runtime} />
        </>
      )}

      <ToolbarSpacer />

      <ToolbarGroup className="shrink-0 gap-1">
        {connection?.productionGuard && (
          <Tooltip content="Production: destructive statements ask for confirmation">
            <Badge tone="danger" icon={ShieldAlert} aria-label="Production">
              <span className="@max-[880px]:hidden">Production</span>
            </Badge>
          </Tooltip>
        )}
        {connection?.readOnly && (
          <Tooltip content="Read-only: statements that modify data or schema are blocked">
            <Badge tone="warning" icon={Lock} aria-label="Read-only">
              <span className="@max-[880px]:hidden">Read-only</span>
            </Badge>
          </Tooltip>
        )}
        {(connection?.productionGuard || connection?.readOnly) && <span className="w-1" />}
        <IconButton
          icon={WandSparkles}
          label="Format SQL"
          shortcut={CONSOLE_SHORTCUTS.format}
          size="xs"
          onClick={() => {
            formatConsole(tab.id)
            focusEditor(tab.id)
          }}
        />
        <IconButton icon={History} label="Query history" shortcut={CONSOLE_SHORTCUTS.history} size="xs" onClick={() => useUi.getState().setHistoryOpen(true)} />
        <IconButton
          icon={resultsCollapsed ? PanelBottomOpen : PanelBottomClose}
          label={resultsCollapsed ? 'Show results' : 'Hide results'}
          shortcut={CONSOLE_SHORTCUTS.toggleResults}
          size="xs"
          active={!resultsCollapsed}
          onClick={onToggleResults}
        />
      </ToolbarGroup>
    </Toolbar>
  )
}

function RunButton({ tabId, runtime }: { tabId: string; runtime: ConsoleRuntime }) {
  const running = runtime.status === 'running'
  const connecting = runtime.status === 'connecting'
  return (
    <div className="flex items-center">
      {/* Run turns into Cancel in place (same width): nothing in the toolbar moves while a query runs.
          The elapsed time is in the results header and the status bar. */}
      {running || connecting ? (
        <Tooltip content={running ? 'Cancel query' : 'Stop connecting'} shortcut={running ? CONSOLE_SHORTCUTS.cancel : undefined}>
          <Button
            variant="secondary"
            size="xs"
            leadingIcon={CircleStop}
            className="w-[88px] justify-start rounded-r-none pl-1.5 pr-2 text-danger hover:text-danger"
            onClick={() => {
              void useConsoles.getState().cancel(tabId)
              focusEditor(tabId)
            }}
          >
            Cancel
          </Button>
        </Tooltip>
      ) : (
        <Tooltip content="Run statement at caret, or the selection" shortcut={CONSOLE_SHORTCUTS.runStatement}>
          <Button
            variant="primary"
            size="xs"
            leadingIcon={Play}
            loading={runtime.explaining}
            disabled={runtime.explaining}
            className="w-[88px] justify-start rounded-r-none pl-1.5 pr-2"
            onClick={() => {
              runConsole(tabId, 'statement')
              focusEditor(tabId)
            }}
          >
            Run
            <span className="ml-1.5 text-2xs font-normal opacity-65">{formatShortcut(CONSOLE_SHORTCUTS.runStatement)}</span>
          </Button>
        </Tooltip>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={running || connecting || runtime.explaining}>
          <Button
            variant={running || connecting ? 'secondary' : 'primary'}
            size="xs"
            icon={<ChevronDown size={12} strokeWidth={2.25} />}
            aria-label="More run options"
            className="w-[18px] rounded-l-none shadow-[inset_1px_0_0_rgb(0_0_0/0.18)]"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="min-w-[220px]"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            focusEditor(tabId)
          }}
        >
          <DropdownMenuItem icon={Play} shortcut={CONSOLE_SHORTCUTS.runStatement} onSelect={() => runConsole(tabId, 'statement')}>
            Run statement
          </DropdownMenuItem>
          <DropdownMenuItem icon={ScrollText} shortcut={CONSOLE_SHORTCUTS.runScript} onSelect={() => runConsole(tabId, 'script')}>
            Run script
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem icon={ListTree} onSelect={() => explainConsole(tabId, false)}>
            Explain plan
          </DropdownMenuItem>
          <DropdownMenuItem icon={Gauge} onSelect={() => explainConsole(tabId, true)}>
            Explain analyze
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Pickers
// ---------------------------------------------------------------------------

async function confirmDiscardTransaction(runtime: ConsoleRuntime, action: string): Promise<boolean> {
  if (!runtime.transaction.inTransaction) return true
  return useUi.getState().confirm({
    title: 'Discard the open transaction?',
    message: `${action} rolls back the uncommitted changes of this console.`,
    confirmLabel: 'Roll back and continue',
    danger: true,
  })
}

function ConnectionPicker({
  tab,
  connection,
  runtime,
  disabled,
}: {
  tab: ConsoleTab
  connection: ConnectionConfig | undefined
  runtime: ConsoleRuntime
  disabled: boolean
}) {
  const connections = useConnections((s) => s.connections)
  const options = useMemo<ComboboxOption[]>(
    () =>
      connections.map((c) => ({
        value: c.id,
        label: c.name,
        icon: <DialectIcon dialect={c.dialect} size={14} title="" />,
        render: (
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate">{c.name}</span>
            <ColorTag color={c.color} size={7} />
          </span>
        ),
        hint: <span className="font-mono text-2xs">{c.host}</span>,
        group: c.group,
        keywords: [c.host, c.database, c.group ?? ''],
      })),
    [connections],
  )
  return (
    <Combobox
      aria-label="Connection"
      variant="ghost"
      size="sm"
      width={300}
      value={connection?.id}
      options={options}
      placeholder="Choose connection"
      searchPlaceholder="Search connections…"
      emptyText="No connections"
      icon={
        connection ? (
          <span className="flex items-center gap-1.5">
            <ColorTag color={connection.color} size={7} />
            <DialectIcon dialect={connection.dialect} size={14} title="" />
          </span>
        ) : undefined
      }
      disabled={disabled}
      // Shrinks first when the toolbar is narrow: the schema and database names matter more.
      className="min-w-[72px] max-w-[200px] shrink-[3] text-fg"
      onValueChange={async (id) => {
        if (id === tab.connectionId) return
        if (!(await confirmDiscardTransaction(runtime, 'Switching connection'))) return
        await useConsoles.getState().switchConnection(tab.id, id)
        refocusEditor(tab.id)
      }}
    />
  )
}

function DatabasePicker({
  tab,
  connection,
  runtime,
  database,
  dialect,
  disabled,
}: {
  tab: ConsoleTab
  connection: ConnectionConfig
  runtime: ConsoleRuntime
  database: string | undefined
  dialect: Dialect
  disabled: boolean
}) {
  const loadable = useExplorer((s) => s.databases[connection.id])
  const options = useMemo<ComboboxOption[]>(() => {
    const list = loadable?.data ?? []
    const opts: ComboboxOption[] = list.map((d) => ({
      value: d.name,
      label: d.name,
      hint: d.sizeBytes !== undefined ? formatBytes(d.sizeBytes) : undefined,
      group: d.isSystem ? 'System' : undefined,
    }))
    if (database && !list.some((d) => d.name === database)) opts.unshift({ value: database, label: database })
    return opts
  }, [loadable?.data, database])
  return (
    <Combobox
      aria-label="Database"
      variant="ghost"
      size="sm"
      icon={Database}
      value={database}
      options={options}
      placeholder="Database"
      searchPlaceholder="Search databases…"
      emptyText="No databases"
      loading={loadable?.status === 'loading'}
      error={loadable?.status === 'error' ? loadable.error : undefined}
      disabled={disabled}
      className="min-w-[80px] max-w-[170px] shrink-[2]"
      onOpen={() => void useExplorer.getState().loadDatabases(connection.id)}
      footer={
        <Button
          variant="ghost"
          size="xs"
          leadingIcon={RefreshCw}
          className="w-full justify-start text-subtle"
          onClick={() => void useExplorer.getState().loadDatabases(connection.id, true)}
        >
          Refresh
        </Button>
      }
      onValueChange={async (name) => {
        if (name === database) return
        // PostgreSQL reconnects the session to switch database; SQL Server issues USE.
        if (dialect === 'postgres' && !(await confirmDiscardTransaction(runtime, 'Switching database'))) return
        refocusEditor(tab.id)
        // The user confirmed above when a transaction was open (PostgreSQL reconnects to switch).
        await useConsoles.getState().setDatabase(tab.id, name, { discardTransaction: dialect === 'postgres' })
      }}
    />
  )
}

function SchemaPicker({
  tab,
  runtime,
  database,
  dialect,
  disabled,
}: {
  tab: ConsoleTab
  runtime: ConsoleRuntime
  database: string
  dialect: Dialect
  disabled: boolean
}) {
  const key = dbKey(tab.connectionId, database)
  const loadable = useExplorer((s) => s.schemas[key])
  const catalogDefault = useCatalog((s) => s.catalogs[key]?.data?.defaultSchema)
  // The catalog can be dropped (explorer refresh) while the session keeps its schema: the session's
  // own schema comes first, the catalog default covers a console that has no session yet.
  const value = tab.schema ?? runtime.sessionSchema ?? catalogDefault
  const options = useMemo<ComboboxOption[]>(() => {
    const list = loadable?.data ?? []
    const opts: ComboboxOption[] = list.map((s) => ({ value: s.name, label: s.name, group: s.isSystem ? 'System' : undefined, hint: s.owner }))
    if (value && !list.some((s) => s.name === value)) opts.unshift({ value, label: value })
    return opts
  }, [loadable?.data, value])
  // SQL Server has no session default schema: the picker only ranks autocompletion (objects of the
  // chosen schema come first, inserted schema-qualified). Unqualified names still resolve in the
  // login's default schema, and the tooltip says so.
  const picker = (
    <Combobox
      aria-label={dialect === 'mssql' ? 'Completion schema' : 'Schema'}
      variant="ghost"
      size="sm"
      icon={Layers}
      value={value}
      options={options}
      placeholder="Schema"
      searchPlaceholder="Search schemas…"
      emptyText="No schemas"
      loading={loadable?.status === 'loading'}
      error={loadable?.status === 'error' ? loadable.error : undefined}
      disabled={disabled}
      className="min-w-[88px] max-w-[150px] shrink-0"
      onOpen={() => void useExplorer.getState().loadSchemas(tab.connectionId, database)}
      onValueChange={(name) => {
        refocusEditor(tab.id)
        if (name !== tab.schema) void useConsoles.getState().setSchema(tab.id, name)
      }}
    />
  )
  if (dialect !== 'mssql') return picker
  const resolves = catalogDefault ?? 'dbo'
  return (
    <Tooltip content={`Completion schema: its objects are suggested first, schema-qualified. Unqualified names resolve in ${resolves}.`}>
      <span className="flex min-w-0 shrink-0">{picker}</span>
    </Tooltip>
  )
}

// ---------------------------------------------------------------------------
// Transaction
// ---------------------------------------------------------------------------

function TransactionControls({ tabId, runtime }: { tabId: string; runtime: ConsoleRuntime }) {
  const manual = useTabs((s) => wantsManualCommit(tabId, s.layout))
  const autoCommit = displayedAutoCommit(runtime, manual)
  const { inTransaction } = runtime.transaction
  const disabled = runtime.status === 'running'
  return (
    <ToolbarGroup className="gap-1.5">
      <Tooltip content={autoCommit ? 'Each statement commits on its own' : 'Statements run in a transaction until you commit'}>
        <span>
          <SegmentedControl
            aria-label="Transaction mode"
            size="xs"
            value={autoCommit ? 'auto' : 'manual'}
            options={[
              { value: 'auto', label: 'Auto', disabled: disabled && !autoCommit },
              { value: 'manual', label: 'Manual', disabled },
            ]}
            onValueChange={(mode) => {
              refocusEditor(tabId)
              void useConsoles.getState().setAutoCommit(tabId, mode === 'auto')
            }}
          />
        </span>
      </Tooltip>
      {inTransaction && (
        <>
          <Tooltip content="A transaction is open with uncommitted changes">
            <span className="flex items-center gap-1.5 pl-0.5 text-xs text-warning" role="status">
              <span data-essential-motion="" className="size-1.5 animate-pulse-soft rounded-full bg-warning" />
              Pending
            </span>
          </Tooltip>
          <Button
            variant="ghost"
            size="xs"
            leadingIcon={Check}
            disabled={disabled}
            className={cn('text-success hover:bg-success-soft hover:text-success')}
            onClick={() => {
              focusEditor(tabId)
              void useConsoles.getState().commit(tabId)
            }}
          >
            Commit
          </Button>
          <Button
            variant="ghost"
            size="xs"
            leadingIcon={Undo2}
            disabled={disabled}
            onClick={() => {
              focusEditor(tabId)
              void useConsoles.getState().rollback(tabId)
            }}
          >
            Rollback
          </Button>
        </>
      )}
    </ToolbarGroup>
  )
}
