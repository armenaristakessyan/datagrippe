import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { ChevronDown, Copy, Pencil, Pin, PinOff, Plus, X, XSquare } from 'lucide-react'
import type { ConnectionConfig } from '@shared/types'
import {
  Button,
  ColorTag,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  IconButton,
  connectionColorVar,
  renderIcon,
  toast,
  Tooltip,
} from '@/components/ui'
import { cn } from '@/lib/cn'
import { MENU_ACCELERATORS } from '@/lib/shortcuts'
import { useConnections } from '@/stores/connections'
import { useTabs, type Tab } from '@/stores/tabs'
import { useUi } from '@/stores/ui'
import { TAB_KIND_ICON, TAB_KIND_LABEL, tabCopyName, tabHint } from './tab-meta'
import { newConsole } from './useGlobalCommands'

const DRAG_MIME = 'application/x-datagrippe-tab'

export async function renameConsoleTab(tab: Tab): Promise<void> {
  if (tab.kind !== 'console') return
  const title = await useUi.getState().prompt({
    title: 'Rename console',
    label: 'Name',
    defaultValue: tab.title,
    confirmLabel: 'Rename',
  })
  if (title) useTabs.getState().rename(tab.id, title)
}

/** Tabs whose visible part is narrower than this count as hidden (overflow list badge). */
const VISIBLE_MIN_PX = 24

export function TabBar() {
  const tabs = useTabs((s) => s.tabs)
  const activeTabId = useTabs((s) => s.activeTabId)
  const connections = useConnections((s) => s.connections)
  const scroller = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState({ left: false, right: false, hidden: 0 })
  const [drop, setDrop] = useState<{ index: number; side: 'before' | 'after' } | null>(null)
  const dragIndex = useRef<number | null>(null)
  const activeRef = useRef(activeTabId)
  activeRef.current = activeTabId

  const measure = useCallback(() => {
    const el = scroller.current
    if (!el) return
    const box = el.getBoundingClientRect()
    let hidden = 0
    for (const tab of el.querySelectorAll<HTMLElement>('[data-tab-id]')) {
      const r = tab.getBoundingClientRect()
      if (Math.min(r.right, box.right) - Math.max(r.left, box.left) < VISIBLE_MIN_PX) hidden++
    }
    const next = { left: el.scrollLeft > 1, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1, hidden }
    setOverflow((prev) => (prev.left === next.left && prev.right === next.right && prev.hidden === next.hidden ? prev : next))
  }, [])

  const revealActive = useCallback(() => {
    const id = activeRef.current
    if (!id) return
    scroller.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [])

  useLayoutEffect(measure, [tabs, measure])
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    // A narrower strip (window resize, sidebar, overflow controls appearing) keeps the active tab in view.
    const ro = new ResizeObserver(() => {
      revealActive()
      measure()
    })
    ro.observe(el)
    // Vertical wheel scrolls the strip horizontally.
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
      e.preventDefault()
      el.scrollLeft += e.deltaY
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      ro.disconnect()
      el.removeEventListener('wheel', onWheel)
    }
  }, [measure, revealActive])

  // Keep the active tab visible.
  useEffect(() => {
    revealActive()
    measure()
  }, [activeTabId, revealActive, measure])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return
    const index = tabs.findIndex((t) => t.id === activeTabId)
    let next = index
    if (e.key === 'ArrowLeft') next = Math.max(0, index - 1)
    if (e.key === 'ArrowRight') next = Math.min(tabs.length - 1, index + 1)
    if (e.key === 'Home') next = 0
    if (e.key === 'End') next = tabs.length - 1
    const tab = tabs[next]
    if (!tab) return
    e.preventDefault()
    useTabs.getState().setActive(tab.id)
    requestAnimationFrame(() => scroller.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(tab.id)}"]`)?.focus())
  }

  const onDragOver = (e: DragEvent<HTMLDivElement>, index: number) => {
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = e.currentTarget.getBoundingClientRect()
    const side = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
    setDrop((d) => (d?.index === index && d.side === side ? d : { index, side }))
  }

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    const from = dragIndex.current
    const target = drop
    setDrop(null)
    dragIndex.current = null
    if (from === null || !target) return
    let to = target.side === 'before' ? target.index : target.index + 1
    if (from < to) to -= 1
    if (to !== from) useTabs.getState().move(from, to)
  }

  // Once tabs overflow, "+" and the tab list move to a fixed slot so they never scroll away.
  const overflowing = overflow.left || overflow.right
  const newButton = (
    <IconButton icon={Plus} size="xs" label="New console" shortcut={MENU_ACCELERATORS['new-console']} onClick={() => newConsole()} />
  )

  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-line bg-panel">
      <div className="relative flex min-w-0 flex-1">
        <div
          ref={scroller}
          role="tablist"
          aria-label="Open tabs"
          onScroll={measure}
          onKeyDown={onKeyDown}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null)
          }}
          className="scrollbar-none flex min-w-0 flex-1 items-stretch overflow-x-auto"
        >
          {tabs.map((tab, index) => (
            <TabItem
              key={tab.id}
              tab={tab}
              active={tab.id === activeTabId}
              dropSide={drop?.index === index ? drop.side : undefined}
              onDragStart={(e) => {
                dragIndex.current = index
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData(DRAG_MIME, tab.id)
              }}
              onDragEnd={() => {
                dragIndex.current = null
                setDrop(null)
              }}
              onDragOver={(e) => onDragOver(e, index)}
              onDrop={onDrop}
            />
          ))}
          {!overflowing && <div className="flex shrink-0 items-center px-1">{newButton}</div>}
          <div className="min-w-4 flex-1" onDoubleClick={() => newConsole()} />
        </div>
        {/* overflow cues: a fade plus a hairline edge, so a tab cut exactly at the border still reads as "more" */}
        <div
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-y-0 left-0 w-8 border-l border-line-strong bg-gradient-to-r from-panel to-transparent transition-opacity duration-150',
            overflow.left ? 'opacity-100' : 'opacity-0',
          )}
        />
        <div
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-y-0 right-0 w-10 border-r border-line-strong bg-gradient-to-l from-panel to-transparent transition-opacity duration-150',
            overflow.right ? 'opacity-100' : 'opacity-0',
          )}
        />
      </div>
      {overflowing && (
        <div className="flex shrink-0 items-center gap-0.5 border-l border-line px-1">
          <TabListMenu tabs={tabs} activeTabId={activeTabId} hidden={overflow.hidden} connections={connections} />
          {newButton}
        </div>
      )}
    </div>
  )
}

/** "All tabs" menu of an overflowing strip; its badge counts the tabs scrolled out of view. */
function TabListMenu({
  tabs,
  activeTabId,
  hidden,
  connections,
}: {
  tabs: Tab[]
  activeTabId: string | null
  hidden: number
  connections: ConnectionConfig[]
}) {
  const label = hidden > 0 ? `All tabs (${hidden} hidden)` : 'All tabs'
  return (
    <DropdownMenu>
      <Tooltip content={label}>
        <DropdownMenuTrigger asChild>
          {hidden > 0 ? (
            <Button variant="ghost" size="xs" aria-label={label} trailingIcon={ChevronDown} className="gap-0.5 px-1.5 text-2xs font-medium tabular">
              {hidden}
            </Button>
          ) : (
            <Button variant="ghost" size="xs" aria-label={label} icon={ChevronDown} />
          )}
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="end" className="max-h-[min(420px,70vh)] w-72 overflow-y-auto">
        <DropdownMenuLabel>Open tabs</DropdownMenuLabel>
        {tabs.map((tab) => {
          const connection = connections.find((c) => c.id === tab.connectionId)
          const hint = tabHint(tab, tabs, connections)
          return (
            <DropdownMenuItem
              key={tab.id}
              icon={TAB_KIND_ICON[tab.kind]}
              onSelect={() => useTabs.getState().setActive(tab.id)}
              className={cn(tab.id === activeTabId && 'bg-active')}
            >
              <span className="flex w-full min-w-0 items-center gap-1.5">
                <span className={cn('truncate', tab.id === activeTabId && 'font-medium')}>{tab.title}</span>
                {hint && <span className="shrink-0 text-xs text-subtle">{hint}</span>}
                <span className="ml-auto flex min-w-0 shrink items-center gap-1 pl-2 text-2xs text-subtle">
                  <ColorTag color={connection?.color} size={6} />
                  <span className="truncate">{connection?.name}</span>
                </span>
              </span>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface TabItemProps {
  tab: Tab
  active: boolean
  dropSide?: 'before' | 'after'
  onDragStart: (e: DragEvent<HTMLDivElement>) => void
  onDragEnd: () => void
  onDragOver: (e: DragEvent<HTMLDivElement>) => void
  onDrop: (e: DragEvent<HTMLDivElement>) => void
}

function TabItem({ tab, active, dropSide, onDragStart, onDragEnd, onDragOver, onDrop }: TabItemProps) {
  const connection = useConnections((s) => s.connections.find((c) => c.id === tab.connectionId))
  const tabCount = useTabs((s) => s.tabs.length)
  const connections = useConnections((s) => s.connections)
  const hint = useTabs((s) => tabHint(tab, s.tabs, connections))
  const { setActive, closeTab, closeOthers, closeAll, togglePin } = useTabs.getState()
  const color = connectionColorVar(connection?.color)
  const label = `${tab.title} — ${TAB_KIND_LABEL[tab.kind]}${connection ? ` · ${connection.name}` : ''}`

  const copyName = async () => {
    try {
      await navigator.clipboard.writeText(tabCopyName(tab))
      toast.success('Copied to clipboard', { description: tabCopyName(tab), duration: 2000 })
    } catch (error) {
      toast.error('Could not copy', error)
    }
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="tab"
          data-tab-id={tab.id}
          aria-selected={active}
          aria-label={label}
          title={label}
          tabIndex={active ? 0 : -1}
          draggable
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onMouseDown={(e) => {
            if (e.button === 1) e.preventDefault() // no autoscroll on middle click
            if (e.button === 0) setActive(tab.id)
          }}
          onAuxClick={(e) => {
            if (e.button === 1) {
              e.preventDefault()
              closeTab(tab.id)
            }
          }}
          onDoubleClick={() => void renameConsoleTab(tab)}
          onKeyDown={(e) => {
            if (e.key === 'Delete' || e.key === 'Backspace') {
              e.preventDefault()
              closeTab(tab.id)
            }
          }}
          className={cn(
            'group relative flex h-full min-w-[104px] max-w-[220px] shrink-0 cursor-default select-none items-center gap-1.5 border-r border-line pl-3 pr-1.5 text-xs outline-none',
            'transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus',
            active ? 'bg-surface text-fg' : 'text-subtle hover:bg-hover hover:text-muted',
          )}
        >
          {/* active: cover the strip's bottom hairline so the tab merges into the content */}
          {active && <span aria-hidden className="absolute inset-x-0 -bottom-px h-px bg-surface" />}
          {/* connection colour stripe */}
          {(active || color) && (
            <span
              aria-hidden
              className={cn('absolute inset-x-0 top-0 h-[2px]', !active && 'opacity-55')}
              style={{ background: color ?? 'var(--c-accent)' }}
            />
          )}
          {dropSide && (
            <span aria-hidden className={cn('absolute inset-y-1.5 z-10 w-[2px] rounded-full bg-accent', dropSide === 'before' ? '-left-px' : '-right-px')} />
          )}
          <span className={cn('flex shrink-0', active ? 'text-muted' : 'text-faint group-hover:text-subtle')}>
            {renderIcon(TAB_KIND_ICON[tab.kind], 14)}
          </span>
          <span className="min-w-0 flex-1 truncate">
            <span className="font-medium">{tab.title}</span>
            {hint && <span className="ml-1.5 font-normal text-subtle">{hint}</span>}
          </span>
          {tab.pinned ? (
            <button
              type="button"
              tabIndex={-1}
              aria-label="Unpin tab"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => togglePin(tab.id)}
              className="flex size-5 shrink-0 items-center justify-center rounded text-subtle hover:bg-active hover:text-fg"
            >
              <Pin size={11} strokeWidth={2} className="rotate-45" />
            </button>
          ) : (
            <button
              type="button"
              tabIndex={-1}
              aria-label={`Close ${tab.title}`}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => closeTab(tab.id)}
              className={cn(
                'flex size-5 shrink-0 items-center justify-center rounded text-subtle transition-opacity hover:bg-active hover:text-fg',
                active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
              )}
            >
              <X size={12} strokeWidth={2} />
            </button>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem icon={X} shortcut={active ? MENU_ACCELERATORS['close-tab'] : undefined} onSelect={() => closeTab(tab.id)}>
          Close
        </ContextMenuItem>
        <ContextMenuItem icon={XSquare} disabled={tabCount < 2} onSelect={() => closeOthers(tab.id)}>
          Close others
        </ContextMenuItem>
        <ContextMenuItem inset onSelect={() => closeAll()}>
          Close all
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem icon={tab.pinned ? PinOff : Pin} onSelect={() => togglePin(tab.id)}>
          {tab.pinned ? 'Unpin' : 'Pin'}
        </ContextMenuItem>
        {tab.kind === 'console' && (
          <ContextMenuItem icon={Pencil} onSelect={() => void renameConsoleTab(tab)}>
            Rename…
          </ContextMenuItem>
        )}
        <ContextMenuItem icon={Copy} onSelect={() => void copyName()}>
          Copy name
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
