// Sidebar database explorer: toolbar (filter, refresh, collapse all, new connection) above a
// flattened, virtualized tree of connections › databases › schemas › objects › columns.
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronsDownUp, FolderTree, Import, Plus, RefreshCw, Search, SearchX } from 'lucide-react'
import { openDbeaverImport } from '@/components/import/useDbeaverImportCommand'
import {
  Button,
  ContextMenu,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  IconButton,
  Input,
  SkeletonLines,
  Tooltip,
} from '@/components/ui'
import { registerCommands } from '@/lib/commands'
import { MENU_ACCELERATORS } from '@/lib/shortcuts'
import { useConnections } from '@/stores/connections'
import { useExplorer } from '@/stores/explorer'
import { useUi } from '@/stores/ui'
import { activateObject, refreshRow, runLoad } from './actions'
import { ExplorerEmpty } from './ExplorerEmpty'
import { ExplorerMenuContent } from './ExplorerMenu'
import { ExplorerRow, ROW_HEIGHT, type RowHandlers } from './ExplorerRow'
import { useExplorerPersistence, useRevealOnConnect } from './persistence'
import { columnDragText, objectQualifiedName } from './scripts'
import { ancestorIds, flattenTree, type TreeRow } from './tree'

/** Focus target for the "Filter explorer" command. */
let focusFilterInput: (() => void) | null = null

export function Explorer() {
  const loaded = useConnections((s) => s.loaded)
  const hasConnections = useConnections((s) => s.connections.length > 0)
  useExplorerPersistence()
  useRevealOnConnect()

  if (!loaded) return <SkeletonLines count={5} className="p-3" />
  if (!hasConnections) return <ExplorerEmpty />
  return <ExplorerTree />
}

function ExplorerTree() {
  const connections = useConnections((s) => s.connections)
  const runtime = useConnections((s) => s.runtime)
  const databases = useExplorer((s) => s.databases)
  const schemas = useExplorer((s) => s.schemas)
  const objects = useExplorer((s) => s.objects)
  const details = useExplorer((s) => s.details)
  const expanded = useExplorer((s) => s.expanded)
  const filter = useExplorer((s) => s.filter)
  const selectedId = useExplorer((s) => s.selectedNode)
  const [filterExpanded, setFilterExpanded] = useState<Record<string, boolean>>({})
  const [menuRow, setMenuRow] = useState<TreeRow | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const rows = useMemo(
    () => flattenTree({ connections, runtime, databases, schemas, objects, details, expanded, filter, filterExpanded }),
    [connections, runtime, databases, schemas, objects, details, expanded, filter, filterExpanded],
  )
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const filtering = filter.trim() !== ''

  const indexById = useMemo(() => new Map(rows.map((r, i) => [r.id, i])), [rows])
  const selectedIndex = selectedId !== null ? (indexById.get(selectedId) ?? -1) : -1

  // Expanded nodes whose children were never requested (restored state, filter browsing).
  useEffect(() => {
    for (const r of rows) if (r.pendingLoad) runLoad(r.pendingLoad)
  }, [rows])

  const scrollRef = useRef<HTMLDivElement>(null)
  const treeRef = useRef<HTMLDivElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 16,
    getItemKey: (i) => rows[i]?.id ?? i,
  })

  // --- filter ------------------------------------------------------------------

  const setFilter = useCallback((value: string) => {
    const ex = useExplorer.getState()
    const wasFiltering = ex.filter.trim() !== ''
    setFilterExpanded({})
    if (wasFiltering && value.trim() === '' && ex.selectedNode) {
      // Keep the node picked while filtering visible once the filter is gone.
      ex.setExpandedMany(ancestorIds(rowsRef.current, ex.selectedNode), true)
    }
    ex.setFilter(value)
  }, [])

  useEffect(() => {
    focusFilterInput = () => {
      filterRef.current?.focus()
      filterRef.current?.select()
    }
    return () => {
      focusFilterInput = null
    }
  }, [])

  // --- expansion ---------------------------------------------------------------

  const toggle = useCallback(
    (row: TreeRow, force?: boolean) => {
      if (!row.expandable) return
      const next = force ?? !row.expanded
      if (next === row.expanded) return
      if (useExplorer.getState().filter.trim() !== '') {
        setFilterExpanded((prev) => ({ ...prev, [row.id]: next }))
        return
      }
      useExplorer.getState().setExpanded(row.id, next)
      // Expanding a connection connects it (and loads its databases).
      if (next && row.node.type === 'connection') void useExplorer.getState().loadDatabases(row.node.connection.id)
    },
    [],
  )

  const collapseAll = useCallback(() => {
    const ex = useExplorer.getState()
    const groups = Object.fromEntries(Object.entries(ex.expanded).filter(([id, v]) => id.startsWith('group:') && v === false))
    ex.replaceExpanded(groups)
    setFilterExpanded({})
  }, [])

  // --- selection & activation --------------------------------------------------

  const select = useCallback((row: TreeRow) => {
    if (row.node.type === 'message') return
    useExplorer.getState().select(row.id)
  }, [])

  const activate = useCallback(
    (row: TreeRow) => {
      const node = row.node
      if (node.type === 'object') {
        activateObject(node.path, node.object)
        return
      }
      if (node.type === 'message') {
        if (node.retry) runLoad(node.retry, true)
        return
      }
      toggle(row)
    },
    [toggle],
  )

  const moveTo = useCallback(
    (index: number) => {
      const list = rowsRef.current
      if (list.length === 0) return
      let i = Math.max(0, Math.min(index, list.length - 1))
      // Skip message rows in the direction of travel.
      const dir = index >= selectedIndex ? 1 : -1
      while (list[i]?.node.type === 'message' && i + dir >= 0 && i + dir < list.length) i += dir
      const row = list[i]
      if (!row || row.node.type === 'message') return
      useExplorer.getState().select(row.id)
      virtualizer.scrollToIndex(i, { align: 'auto' })
    },
    [selectedIndex, virtualizer],
  )

  const refreshSelected = useCallback(async () => {
    setRefreshing(true)
    try {
      const row = selectedIndex >= 0 ? rowsRef.current[selectedIndex] : undefined
      if (row) await refreshRow(row)
      else await refreshAll()
    } finally {
      setRefreshing(false)
    }
  }, [selectedIndex])

  const handlers = useMemo<RowHandlers>(
    () => ({
      onSelect: select,
      onToggle: (row) => toggle(row),
      onActivate: activate,
      onContextMenu: (row) => {
        setMenuRow(row)
        select(row)
      },
      onRetry: (row) => {
        if (row.node.type === 'message' && row.node.retry) runLoad(row.node.retry, true)
      },
      onDragStart: (row: TreeRow, event: DragEvent<HTMLDivElement>) => {
        const node = row.node
        const connection = useConnections.getState().connections.find((c) => c.id === row.connectionId)
        const dialect = connection?.dialect ?? 'postgres'
        let text = ''
        if (node.type === 'object') text = objectQualifiedName(node.object, dialect)
        else if (node.type === 'column') text = columnDragText(node.column.name, dialect)
        if (!text) return
        event.dataTransfer.setData('text/plain', text)
        event.dataTransfer.effectAllowed = 'copy'
      },
    }),
    [select, toggle, activate],
  )

  // --- keyboard ----------------------------------------------------------------

  const onTreeKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const row = selectedIndex >= 0 ? rows[selectedIndex] : undefined
    const mod = e.metaKey || e.ctrlKey || e.altKey
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        moveTo(row ? selectedIndex + 1 : 0)
        return
      case 'ArrowUp':
        e.preventDefault()
        moveTo(row ? selectedIndex - 1 : rows.length - 1)
        return
      case 'Home':
        e.preventDefault()
        moveTo(0)
        return
      case 'End':
        e.preventDefault()
        moveTo(rows.length - 1)
        return
      case 'PageDown':
      case 'PageUp': {
        e.preventDefault()
        const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 240) / ROW_HEIGHT) - 1)
        moveTo(selectedIndex + (e.key === 'PageDown' ? page : -page))
        return
      }
      case 'ArrowRight':
        e.preventDefault()
        if (!row) return moveTo(0)
        if (row.expandable && !row.expanded) toggle(row, true)
        else if (row.expanded) moveTo(selectedIndex + 1)
        return
      case 'ArrowLeft': {
        e.preventDefault()
        if (!row) return
        if (row.expandable && row.expanded) toggle(row, false)
        else if (row.parentId) {
          const parent = indexById.get(row.parentId)
          if (parent !== undefined) moveTo(parent)
        }
        return
      }
      case 'Enter':
        e.preventDefault()
        if (row) activate(row)
        return
      case ' ':
        if (!filtering && row) {
          e.preventDefault()
          toggle(row)
        }
        break
      case 'Escape':
        if (filtering) {
          e.preventDefault()
          setFilter('')
        }
        return
      case 'F5':
        e.preventDefault()
        void refreshSelected()
        return
      case 'ContextMenu':
      case 'F10':
        if (e.key === 'F10' && !e.shiftKey) break
        e.preventDefault()
        openContextMenuForSelection()
        return
    }
    // Type-to-filter: printable keys go to the filter input.
    if (!mod && e.key.length === 1 && (e.key !== ' ' || filtering)) {
      e.preventDefault()
      setFilter(filter + e.key)
      filterRef.current?.focus()
    } else if (!mod && e.key === 'Backspace' && filtering) {
      e.preventDefault()
      setFilter(filter.slice(0, -1))
      filterRef.current?.focus()
    }
  }

  const openContextMenuForSelection = () => {
    const id = useExplorer.getState().selectedNode
    if (!id) return
    const el = treeRef.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`)
    if (!el) return
    const rect = el.getBoundingClientRect()
    el.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 32, clientY: rect.bottom - 4 }),
    )
  }

  const onFilterKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (filter) setFilter('')
      else treeRef.current?.focus()
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'Enter') {
      e.preventDefault()
      const first = rowsRef.current.findIndex((r) => r.match)
      const target = selectedIndex >= 0 && e.key === 'ArrowDown' ? selectedIndex : first >= 0 ? first : 0
      treeRef.current?.focus()
      moveTo(target)
    }
  }

  // Keep the selection in view when rows change underneath it (filter, expand above it).
  useEffect(() => {
    if (selectedIndex >= 0) virtualizer.scrollToIndex(selectedIndex, { align: 'auto' })
    // Only when the selection itself changes; scrolling on every data update would fight the user.
  }, [selectedId])

  // Palette commands for the explorer.
  useEffect(
    () =>
      registerCommands([
        {
          id: 'explorer.filter',
          title: 'Filter explorer…',
          group: 'Explorer',
          icon: Search,
          keywords: ['find', 'tree', 'sidebar', 'search'],
          run: () => {
            useUi.getState().setSidebarVisible(true)
            requestAnimationFrame(() => focusFilterInput?.())
          },
        },
        {
          id: 'explorer.refresh',
          title: 'Refresh explorer',
          group: 'Explorer',
          icon: RefreshCw,
          keywords: ['reload', 'metadata', 'schema'],
          run: () => refreshAll(),
        },
        {
          id: 'explorer.collapse-all',
          title: 'Collapse all explorer nodes',
          group: 'Explorer',
          icon: ChevronsDownUp,
          keywords: ['tree', 'fold'],
          run: collapseAll,
        },
      ]),
    [collapseAll],
  )

  const items = virtualizer.getVirtualItems()
  const activeDescendant = selectedIndex >= 0 ? `dg-explorer-row-${selectedIndex}` : undefined

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1.5">
        <Input
          ref={filterRef}
          size="sm"
          leadingIcon={Search}
          value={filter}
          placeholder="Filter"
          aria-label="Filter loaded objects"
          wrapperClassName="min-w-0 flex-1"
          onChange={(e) => setFilter(e.target.value)}
          onClear={() => setFilter('')}
          onKeyDown={onFilterKeyDown}
        />
        <IconButton icon={RefreshCw} size="xs" label={selectedIndex >= 0 ? 'Refresh selected' : 'Refresh all'} shortcut="F5" loading={refreshing} onClick={() => void refreshSelected()} />
        <IconButton icon={ChevronsDownUp} size="xs" label="Collapse all" onClick={collapseAll} />
        <DropdownMenu>
          <Tooltip content="Add connection">
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="xs" icon={Plus} aria-label="Add connection" />
            </DropdownMenuTrigger>
          </Tooltip>
          <DropdownMenuContent align="end" className="min-w-[210px]">
            <DropdownMenuItem icon={Plus} shortcut={MENU_ACCELERATORS['new-connection']} onSelect={() => useUi.getState().openConnectionDialog()}>
              New connection…
            </DropdownMenuItem>
            <DropdownMenuItem icon={Import} onSelect={openDbeaverImport}>
              Import from DBeaver…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <ContextMenu
        onOpenChange={(open) => {
          if (!open) treeRef.current?.focus()
        }}
      >
        <ContextMenuTrigger asChild>
          <div
            ref={scrollRef}
            className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-1"
            onContextMenu={(e) => {
              if (!(e.target as HTMLElement).closest('[data-row-id]')) setMenuRow(null)
            }}
          >
            {rows.length === 0 ? (
              <EmptyState
                size="compact"
                icon={filtering ? SearchX : FolderTree}
                title={filtering ? 'No matches' : 'Nothing to show'}
                description={
                  filtering ? 'Only loaded objects are searched. Expand a schema to search inside it.' : 'Your connections will appear here.'
                }
                action={
                  filtering ? (
                    <Button size="xs" onClick={() => setFilter('')}>
                      Clear filter
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <div
                ref={treeRef}
                role="tree"
                aria-label="Database explorer"
                aria-activedescendant={activeDescendant}
                tabIndex={0}
                onKeyDown={onTreeKeyDown}
                onFocus={(e) => {
                  // Keyboard focus lands on the first row when nothing is selected yet.
                  if (e.target !== e.currentTarget || selectedIndex >= 0 || !e.currentTarget.matches(':focus-visible')) return
                  const first = rows.find((r) => r.node.type !== 'message')
                  if (first) useExplorer.getState().select(first.id)
                }}
                className="group/tree relative outline-none"
                style={{ height: virtualizer.getTotalSize() }}
              >
                {items.map((item) => {
                  const row = rows[item.index]
                  if (!row) return null
                  return (
                    <ExplorerRow
                      key={item.key}
                      row={row}
                      domId={`dg-explorer-row-${item.index}`}
                      selected={item.index === selectedIndex}
                      runtime={row.node.type === 'connection' ? runtime[row.node.connection.id] : undefined}
                      handlers={handlers}
                      top={item.start}
                    />
                  )
                })}
              </div>
            )}
          </div>
        </ContextMenuTrigger>
        <ExplorerMenuContent row={menuRow} onCollapseAll={collapseAll} onRefreshAll={() => void refreshAll()} />
      </ContextMenu>
    </div>
  )
}

async function refreshAll(): Promise<void> {
  const { connections, runtime } = useConnections.getState()
  const connected = connections.filter((c) => runtime[c.id]?.status === 'connected')
  await Promise.all(
    connected.map((c) =>
      refreshRow({ id: c.id, node: { type: 'connection', connection: c }, depth: 0, parentId: null, expandable: true, expanded: true, loading: false }),
    ),
  )
}
