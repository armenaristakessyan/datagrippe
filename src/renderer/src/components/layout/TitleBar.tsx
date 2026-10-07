import { ChevronRight, Database, History, Lock, PanelLeft, Search, Settings2, ShieldAlert } from 'lucide-react'
import { ColorTag, DialectIcon, IconButton, Kbd } from '@/components/ui'
import { cn } from '@/lib/cn'
import { isMac } from '@/lib/platform'
import { MENU_ACCELERATORS } from '@/lib/shortcuts'
import { useConnections } from '@/stores/connections'
import { useExplorer } from '@/stores/explorer'
import { useTabs } from '@/stores/tabs'
import { useUi } from '@/stores/ui'
import { firstUserDatabase, tabDatabase } from './tab-meta'

/** Width reserved for the macOS traffic lights (hiddenInset title bar). */
const MAC_TRAFFIC_LIGHTS = 78

export function TitleBar() {
  const mac = isMac()
  const sidebarVisible = useUi((s) => s.sidebarVisible)
  const toggleSidebar = useUi((s) => s.toggleSidebar)
  const openPalette = useUi((s) => s.openPalette)
  const setHistoryOpen = useUi((s) => s.setHistoryOpen)
  const setSettingsOpen = useUi((s) => s.setSettingsOpen)

  return (
    // The bar drags the window. Every descendant inherits `drag` and adds its own box to the drag area, in tree
    // order: a box spanning the bar placed after a no-drag control would make that control drag the window instead
    // of taking clicks. Keep each child to its own box.
    <header
      className="drag-region relative flex h-10 shrink-0 items-center border-b border-line bg-panel pr-2"
      style={{ paddingLeft: mac ? MAC_TRAFFIC_LIGHTS : 8 }}
    >
      <div className="no-drag flex items-center">
        <IconButton
          icon={PanelLeft}
          label={sidebarVisible ? 'Hide sidebar' : 'Show sidebar'}
          shortcut={MENU_ACCELERATORS['toggle-sidebar']}
          onClick={toggleSidebar}
        />
      </div>
      <Location />

      {/* centered search trigger; absolutely placed so the location width never shifts it */}
      <button
        type="button"
        onClick={() => openPalette('commands')}
        className={cn(
          'no-drag absolute top-1/2 left-1/2 flex h-[26px] w-[min(420px,36vw)] -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-md border border-line bg-input px-2.5 text-left text-xs text-subtle shadow-inset outline-none',
          'transition-[border-color,background-color,color] duration-100 hover:border-line-strong hover:bg-hover hover:text-muted',
          'focus-visible:ring-2 focus-visible:ring-focus',
        )}
      >
        <Search size={13} strokeWidth={1.75} className="shrink-0" />
        <span className="flex-1 truncate">Search or run a command…</span>
        <Kbd shortcut={MENU_ACCELERATORS['command-palette']} />
      </button>

      <div className="no-drag relative ml-auto flex items-center gap-0.5">
        <IconButton icon={History} label="Query history" shortcut={MENU_ACCELERATORS['open-history']} onClick={() => setHistoryOpen(true)} />
        <IconButton icon={Settings2} label="Settings" shortcut={MENU_ACCELERATORS['open-settings']} onClick={() => setSettingsOpen(true)} />
      </div>
    </header>
  )
}

/**
 * Where the active tab works, readable at a glance: connection › database in a chip, tinted red for a production
 * connection. Space is capped so the centred search never overlaps it; the "Production" label gives way first.
 */
function Location() {
  const tab = useTabs((s) => s.tabs.find((t) => t.id === s.activeTabId))
  const connection = useConnections((s) => (tab ? s.connections.find((c) => c.id === tab.connectionId) : undefined))
  const firstDatabase = useExplorer((s) => (tab ? firstUserDatabase(s.databases[tab.connectionId]?.data) : undefined))
  if (!tab) return null
  const database = tabDatabase(tab, connection, firstDatabase)
  const production = connection?.productionGuard === true
  return (
    <nav aria-label="Location" className="@container ml-1.5 flex min-w-0 max-w-[calc(50%-300px)] flex-1 items-center">
      <div
        className={cn(
          'flex h-[26px] min-w-0 items-center gap-1.5 rounded-md border px-2 text-xs @max-[120px]:hidden',
          production ? 'border-danger/40 bg-danger-soft' : 'border-line bg-elevated',
        )}
      >
        {connection && <DialectIcon dialect={connection.dialect} size={14} />}
        <span className="min-w-8 max-w-40 shrink truncate font-medium text-fg">{connection?.name ?? 'Unknown connection'}</span>
        <ColorTag color={connection?.color} size={7} />
        {database && (
          <>
            <ChevronRight size={12} strokeWidth={2} className="shrink-0 text-faint" aria-hidden />
            <Database size={13} strokeWidth={1.75} className="shrink-0 text-muted" aria-hidden />
            <span className="min-w-8 shrink-[2] truncate font-mono font-medium text-fg">{database}</span>
          </>
        )}
        {production && (
          <span className="flex shrink-0 items-center gap-1 pl-0.5 font-medium text-danger">
            <ShieldAlert size={12} strokeWidth={2} aria-label="Production" />
            <span className="@max-[300px]:hidden" aria-hidden>
              Production
            </span>
          </span>
        )}
        {connection?.readOnly && <Lock size={12} strokeWidth={2} className="shrink-0 text-warning" aria-label="Read-only" />}
      </div>
    </nav>
  )
}
