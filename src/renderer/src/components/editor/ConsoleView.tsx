// Console tab: toolbar + SQL editor + results panel.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { PlugZap } from 'lucide-react'
import { ResultsPanel } from '@/components/results/ResultsPanel'
import { Button, Spinner, SplitGroup, SplitHandle, SplitPanel, StatusDot, usePanelRef, type SplitLayout } from '@/components/ui'
import { getEditor } from '@/lib/editor-registry'
import { useCatalog } from '@/stores/catalog'
import { useConnections } from '@/stores/connections'
import { useConsoles } from '@/stores/consoles'
import { dbKey, useExplorer } from '@/stores/explorer'
import { firstUserDatabase, tabDatabase } from '@/components/layout/tab-meta'
import { useTabs, type ConsoleTab } from '@/stores/tabs'
import { explainConsole, registerResultsController, runConsole } from './console-actions'
import { retainConsoleCommands } from './console-commands'
import { ConsoleDialogs } from './ConsoleDialogs'
import { ConsoleToolbar } from './ConsoleToolbar'
import { executionErrorRange } from './error-mapping'
import { SqlEditor, type SqlEditorActions } from './SqlEditor'

const LAYOUT_KEY = 'console.split'
const EDITOR_PANEL = 'editor'
const RESULTS_PANEL = 'results'

function storedLayout(): SplitLayout | undefined {
  const value = useTabs.getState().layout[LAYOUT_KEY]
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const editor = record[EDITOR_PANEL]
  const results = record[RESULTS_PANEL]
  if (typeof editor !== 'number' || typeof results !== 'number' || editor < 20 || results < 0) return undefined
  return { [EDITOR_PANEL]: editor, [RESULTS_PANEL]: results }
}

export function ConsoleView({ tab }: { tab: ConsoleTab }) {
  const connection = useConnections((s) => s.connections.find((c) => c.id === tab.connectionId))
  const connectionStatus = useConnections((s) => s.runtime[tab.connectionId]?.status ?? 'disconnected')
  const runtime = useConsoles((s) => s.runtime(tab.id))
  const firstDatabase = useExplorer((s) => firstUserDatabase(s.databases[tab.connectionId]?.data))
  const dialect = connection?.dialect ?? 'postgres'
  const database = tabDatabase(tab, connection, firstDatabase)

  useEffect(() => retainConsoleCommands(), [])

  // Completion catalog: load once the connection is up (session open, database switch), and again
  // after something dropped it (explorer refresh invalidates the connection's catalogs).
  const catalogMissing = useCatalog((s) => (database ? !s.catalogs[dbKey(tab.connectionId, database)] : false))
  useEffect(() => {
    if (!database || !connection) return
    if (connectionStatus === 'connected' || runtime.sessionId) void useCatalog.getState().load(tab.connectionId, database)
  }, [tab.connectionId, database, connection, connectionStatus, runtime.sessionId, catalogMissing])

  // Error location → editor marker, once per execution.
  const executionId = runtime.execution?.executionId
  useEffect(() => {
    const { execution, executionOffset } = useConsoles.getState().runtime(tab.id)
    if (!execution || !executionId) return
    const editor = getEditor(tab.id)
    if (!editor) return
    const mapped = executionErrorRange(editor.getText(), executionOffset, execution)
    if (mapped) editor.markError(mapped.start, mapped.end, mapped.message)
  }, [tab.id, executionId])

  const actions = useMemo<SqlEditorActions>(
    () => ({
      runStatement: () => runConsole(tab.id, 'statement'),
      runScript: () => runConsole(tab.id, 'script'),
      explain: (analyze) => explainConsole(tab.id, analyze),
    }),
    [tab.id],
  )

  // Results panel: collapsible, ratio persisted (shared by all consoles).
  const resultsRef = usePanelRef()
  const [collapsed, setCollapsed] = useState(false)
  const defaultLayout = useMemo(storedLayout, [])
  const toggleResults = useCallback(() => {
    const panel = resultsRef.current
    if (!panel) return
    if (panel.isCollapsed()) panel.expand()
    else panel.collapse()
  }, [resultsRef])
  useEffect(
    () =>
      registerResultsController(tab.id, {
        toggle: toggleResults,
        expand: () => {
          const panel = resultsRef.current
          if (panel?.isCollapsed()) panel.expand()
        },
      }),
    [tab.id, toggleResults, resultsRef],
  )

  return (
    // Two panels: the tab strip, toolbar and editor on top, the results below (the frame shows between them).
    <div className="flex h-full min-h-0 flex-col">
      <ConsoleToolbar
        tab={tab}
        connection={connection}
        runtime={runtime}
        dialect={dialect}
        database={database}
        resultsCollapsed={collapsed}
        onToggleResults={toggleResults}
      />
      <div className="relative min-h-0 flex-1">
        <SplitGroup
          orientation="vertical"
          defaultLayout={defaultLayout}
          onLayoutChanged={(layout, meta) => {
            if (meta.isUserInteraction) useTabs.getState().setLayout(LAYOUT_KEY, meta.requestedLayout ?? layout)
          }}
        >
          <SplitPanel id={EDITOR_PANEL} minSize="20" className="relative overflow-hidden rounded-b-lg bg-surface">
            <SqlEditor tab={tab} dialect={dialect} database={database} actions={actions} />
            {connection && (
              <ConnectionChip
                status={runtime.sessionId ? 'connected' : runtime.status === 'connecting' ? 'connecting' : connectionStatus}
                onConnect={() => void useConsoles.getState().ensureSession(tab.id)}
              />
            )}
          </SplitPanel>
          <SplitHandle direction="horizontal" variant="gap" />
          <SplitPanel
            id={RESULTS_PANEL}
            defaultSize="40"
            minSize="12"
            collapsible
            collapsedSize={0}
            panelRef={resultsRef}
            onResize={(size) => setCollapsed(size.inPixels < 1)}
          >
            {/* The results panel owns runtime.error (banner over results, or the failure view). */}
            <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg bg-surface">
              <div className="min-h-0 flex-1">
                <ResultsPanel tabId={tab.id} />
              </div>
            </div>
          </SplitPanel>
        </SplitGroup>
      </div>
      <ConsoleDialogs tabId={tab.id} />
    </div>
  )
}

function ConnectionChip({ status, onConnect }: { status: 'connected' | 'connecting' | 'disconnected' | 'error'; onConnect: () => void }) {
  if (status === 'connected') return null
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center">
      <div className="pointer-events-auto flex h-7 animate-fade-in items-center gap-2 rounded-full border border-line bg-elevated pl-2.5 pr-1 text-xs text-muted shadow-popover">
        {status === 'connecting' ? (
          <>
            <Spinner size={12} className="text-subtle" />
            <span className="pr-2">Connecting…</span>
          </>
        ) : (
          <>
            <StatusDot status={status === 'error' ? 'error' : 'disconnected'} size={6} />
            <span>{status === 'error' ? 'Connection failed' : 'Not connected'}</span>
            <Button size="xs" variant="ghost" leadingIcon={PlugZap} className="h-5 rounded-full px-2 text-fg" onClick={onConnect}>
              {status === 'error' ? 'Retry' : 'Connect'}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
