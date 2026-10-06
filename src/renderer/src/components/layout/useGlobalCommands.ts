// App-level commands (palette entries + native menu targets). Shortcuts are display-only: the
// native menu owns the accelerators and sends `event:menu`.
import { useEffect } from 'react'
import {
  Activity,
  ArrowLeftToLine,
  FolderTree,
  Table2,
  TextCursorInput,
  ArrowRightToLine,
  Command as CommandIcon,
  History,
  PanelLeft,
  Plus,
  Search,
  Settings2,
  SquareTerminal,
  SunMoon,
  X,
  XSquare,
} from 'lucide-react'
import { connectionIdOf } from '@/components/explorer/tree'
import { toast } from '@/components/ui'
import { registerCommands, type Command } from '@/lib/commands'
import { closeTopmostOverlay, focusActiveEditor, focusExplorerTree, focusResults } from '@/lib/focus'
import { lastRegion } from '@/lib/recency'
import { MENU_ACCELERATORS } from '@/lib/shortcuts'
import { toggleTheme } from '@/lib/theme'
import { useConnections } from '@/stores/connections'
import { useExplorer } from '@/stores/explorer'
import { activeTab, useTabs } from '@/stores/tabs'
import { useUi } from '@/stores/ui'

/**
 * Connection for a new console: the explorer selection when the explorer was used after the tabs
 * (e.g. a connection just picked or created there), else the active tab's → explorer selection →
 * first connected → first saved.
 */
export function pickConsoleConnection(): string | undefined {
  const { connections, runtime } = useConnections.getState()
  const known = (id: string | undefined) => (id && connections.some((c) => c.id === id) ? id : undefined)
  const selected = useExplorer.getState().selectedNode
  const fromSelection = selected ? known(connectionIdOf(selected)) : undefined
  if (fromSelection && lastRegion() === 'explorer') return fromSelection
  const fromTab = known(activeTab()?.connectionId)
  if (fromTab) return fromTab
  if (fromSelection) return fromSelection
  const connected = connections.find((c) => runtime[c.id]?.status === 'connected')
  if (connected) return connected.id
  return connections[0]?.id
}

export function newConsole(connectionId?: string): void {
  const id = connectionId ?? pickConsoleConnection()
  if (!id) {
    useUi.getState().openConnectionDialog()
    return
  }
  useTabs.getState().openConsole({ connectionId: id })
}

function cycleTab(direction: 1 | -1): void {
  const { tabs, activeTabId, setActive } = useTabs.getState()
  if (tabs.length < 2) return
  const index = tabs.findIndex((t) => t.id === activeTabId)
  const next = tabs[(index + direction + tabs.length) % tabs.length]
  if (next) setActive(next.id)
}

const hasTabs = () => useTabs.getState().tabs.length > 0

/** Accelerator of a native menu item, once the menu defines one for the command. */
function menuShortcut(command: string): string | undefined {
  return (MENU_ACCELERATORS as Partial<Record<string, string>>)[command]
}

export function buildGlobalCommands(): Command[] {
  return [
    {
      id: 'new-console',
      title: 'New console',
      group: 'Query',
      icon: SquareTerminal,
      shortcut: MENU_ACCELERATORS['new-console'],
      keywords: ['query', 'editor', 'sql', 'tab'],
      run: () => newConsole(),
    },
    {
      id: 'new-connection',
      title: 'New connection…',
      group: 'Connection',
      icon: Plus,
      shortcut: MENU_ACCELERATORS['new-connection'],
      keywords: ['add', 'database', 'server', 'postgres', 'sql server'],
      run: () => useUi.getState().openConnectionDialog(),
    },
    {
      id: 'show-sessions',
      title: 'Show server sessions…',
      group: 'Connection',
      icon: Activity,
      keywords: ['activity', 'processes', 'pg_stat_activity', 'sp_who', 'kill', 'cancel', 'terminate', 'locks', 'blocking'],
      when: () => useConnections.getState().connections.length > 0,
      run: () => {
        const id = pickConsoleConnection()
        if (id) useTabs.getState().openSessions(id)
      },
    },
    {
      id: 'close-tab',
      title: 'Close tab',
      group: 'Navigation',
      icon: X,
      shortcut: MENU_ACCELERATORS['close-tab'],
      when: hasTabs,
      run: () => {
        // ⌘W with a dialog, sheet or menu open closes that, never the tab hidden behind it.
        if (closeTopmostOverlay()) return
        const tab = activeTab()
        if (tab) void useTabs.getState().closeTab(tab.id)
      },
    },
    {
      id: 'close-other-tabs',
      title: 'Close other tabs',
      group: 'Navigation',
      icon: XSquare,
      when: () => useTabs.getState().tabs.length > 1,
      run: () => {
        const tab = activeTab()
        if (tab) useTabs.getState().closeOthers(tab.id)
      },
    },
    {
      id: 'next-tab',
      title: 'Next tab',
      group: 'Navigation',
      icon: ArrowRightToLine,
      shortcut: MENU_ACCELERATORS['next-tab'],
      when: () => useTabs.getState().tabs.length > 1,
      run: () => cycleTab(1),
    },
    {
      id: 'previous-tab',
      title: 'Previous tab',
      group: 'Navigation',
      icon: ArrowLeftToLine,
      shortcut: MENU_ACCELERATORS['previous-tab'],
      when: () => useTabs.getState().tabs.length > 1,
      run: () => cycleTab(-1),
    },
    {
      id: 'command-palette',
      title: 'Command palette',
      group: 'Navigation',
      icon: CommandIcon,
      shortcut: MENU_ACCELERATORS['command-palette'],
      keywords: ['actions', 'search'],
      run: () => useUi.getState().openPalette('commands'),
    },
    {
      id: 'go-to-object',
      title: 'Go to table, view or routine…',
      group: 'Navigation',
      icon: Search,
      shortcut: MENU_ACCELERATORS['go-to-object'],
      keywords: ['find', 'open', 'object', 'navigate'],
      run: () => useUi.getState().openPalette('objects'),
    },
    {
      id: 'focus-editor',
      title: 'Focus editor',
      group: 'Navigation',
      icon: TextCursorInput,
      shortcut: menuShortcut('focus-editor'),
      keywords: ['keyboard', 'move', 'console', 'sql', 'caret'],
      when: hasTabs,
      run: () => {
        if (focusActiveEditor()) return
        // Table tabs have no editor: their grid is the main surface.
        if (!focusResults()) toast.info('Nothing to focus in this tab')
      },
    },
    {
      id: 'focus-results',
      title: 'Focus results',
      group: 'Navigation',
      icon: Table2,
      shortcut: menuShortcut('focus-results'),
      keywords: ['keyboard', 'move', 'grid', 'rows', 'output'],
      when: hasTabs,
      run: () => {
        if (!focusResults()) toast.info('No results to focus', { description: 'Run a statement first.' })
      },
    },
    {
      id: 'focus-explorer',
      title: 'Focus explorer',
      group: 'Navigation',
      icon: FolderTree,
      shortcut: menuShortcut('focus-explorer'),
      keywords: ['keyboard', 'move', 'tree', 'sidebar', 'connections'],
      run: () => {
        const ui = useUi.getState()
        const wasVisible = ui.sidebarVisible
        ui.setSidebarVisible(true)
        const focus = () => focusExplorerTree((id) => useExplorer.getState().select(id), useExplorer.getState().selectedNode !== null)
        // A collapsed sidebar needs a frame to lay out before it can take the focus.
        if (wasVisible) focus()
        else requestAnimationFrame(() => requestAnimationFrame(focus))
      },
    },
    {
      id: 'toggle-sidebar',
      title: 'Toggle sidebar',
      group: 'View',
      icon: PanelLeft,
      shortcut: MENU_ACCELERATORS['toggle-sidebar'],
      keywords: ['explorer', 'hide', 'show'],
      run: () => useUi.getState().toggleSidebar(),
    },
    {
      id: 'toggle-theme',
      title: 'Toggle light / dark theme',
      group: 'View',
      icon: SunMoon,
      keywords: ['appearance', 'dark mode', 'light mode'],
      run: () => toggleTheme(),
    },
    {
      id: 'open-history',
      title: 'Query history',
      group: 'View',
      icon: History,
      shortcut: MENU_ACCELERATORS['open-history'],
      keywords: ['recent', 'past', 'executed'],
      run: () => useUi.getState().setHistoryOpen(true),
    },
    {
      id: 'open-settings',
      title: 'Settings…',
      group: 'View',
      icon: Settings2,
      shortcut: MENU_ACCELERATORS['open-settings'],
      keywords: ['preferences', 'options'],
      run: () => useUi.getState().setSettingsOpen(true),
    },
  ]
}

/** Register the global commands (their shortcuts are native menu accelerators). */
export function useGlobalCommands(): void {
  useEffect(() => registerCommands(buildGlobalCommands()), [])
}
