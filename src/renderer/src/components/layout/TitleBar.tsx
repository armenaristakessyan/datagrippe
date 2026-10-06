import { ChevronRight, History, PanelLeft, Search, Settings2 } from 'lucide-react'
import { ColorTag, IconButton, Kbd } from '@/components/ui'
import { cn } from '@/lib/cn'
import { isMac } from '@/lib/platform'
import { MENU_ACCELERATORS } from '@/lib/shortcuts'
import { useConnections } from '@/stores/connections'
import { useTabs } from '@/stores/tabs'
import { useUi } from '@/stores/ui'
import { tabCrumbs } from './tab-meta'

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
      <Breadcrumb />

      {/* centered search trigger; absolutely placed so the breadcrumb width never shifts it */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <button
          type="button"
          onClick={() => openPalette('commands')}
          className={cn(
            'no-drag pointer-events-auto flex h-[26px] w-[min(420px,36vw)] items-center gap-2 rounded-md border border-line bg-input px-2.5 text-left text-xs text-subtle shadow-inset outline-none',
            'transition-[border-color,background-color,color] duration-100 hover:border-line-strong hover:bg-hover hover:text-muted',
            'focus-visible:ring-2 focus-visible:ring-focus',
          )}
        >
          <Search size={13} strokeWidth={1.75} className="shrink-0" />
          <span className="flex-1 truncate">Search or run a command…</span>
          <Kbd shortcut={MENU_ACCELERATORS['command-palette']} />
        </button>
      </div>

      <div className="no-drag relative ml-auto flex items-center gap-0.5">
        <IconButton icon={History} label="Query history" shortcut={MENU_ACCELERATORS['open-history']} onClick={() => setHistoryOpen(true)} />
        <IconButton icon={Settings2} label="Settings" shortcut={MENU_ACCELERATORS['open-settings']} onClick={() => setSettingsOpen(true)} />
      </div>
    </header>
  )
}

/**
 * connection › database › … › object. Space is capped so the centred search never overlaps it; when
 * short, the middle crumbs collapse to "…" first and the last crumb (what is open) shrinks last.
 */
function Breadcrumb() {
  const tab = useTabs((s) => s.tabs.find((t) => t.id === s.activeTabId))
  const connection = useConnections((s) => (tab ? s.connections.find((c) => c.id === tab.connectionId) : undefined))
  if (!tab) return null
  const crumbs = tabCrumbs(tab, connection)
  const last = crumbs[crumbs.length - 1]
  const middle = crumbs.slice(0, -1)
  const separator = <ChevronRight size={12} strokeWidth={2} className="shrink-0 text-faint" aria-hidden />
  return (
    <nav aria-label="Location" className="@container relative ml-1.5 flex min-w-0 max-w-[calc(50%-300px)] flex-1">
      <div className="flex min-w-0 items-center gap-1 text-xs text-subtle @max-[120px]:hidden">
        <span className="flex min-w-10 shrink items-center gap-1.5 text-muted">
          <ColorTag color={connection?.color} />
          <span className="max-w-40 truncate font-medium">{connection?.name ?? 'Unknown connection'}</span>
        </span>
        {middle.map((crumb, i) => (
          <span key={i} className="flex min-w-0 shrink-[4] items-center gap-1 @max-[280px]:hidden">
            {separator}
            <span className="truncate">{crumb}</span>
          </span>
        ))}
        {middle.length > 0 && (
          <span className="hidden shrink-0 items-center gap-1 @max-[280px]:flex" title={middle.join(' › ')}>
            {separator}
            <span aria-hidden>…</span>
          </span>
        )}
        {last !== undefined && (
          <span className="flex min-w-0 max-w-[min(12rem,65%)] shrink-0 items-center gap-1">
            {separator}
            <span className="truncate text-fg">{last}</span>
          </span>
        )}
      </div>
    </nav>
  )
}
