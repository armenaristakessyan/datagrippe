// Open tabs (consoles, table data, table structure) persisted to the workspace file.
import { create } from 'zustand'
import type { ObjectKind, PersistedTab, WorkspaceState } from '@shared/types'
import { api } from '@/lib/api'
import { uid } from '@/lib/id'
import { markRegion } from '@/lib/recency'

export interface ConsoleTab {
  id: string
  kind: 'console'
  title: string
  connectionId: string
  database?: string
  schema?: string
  content: string
  /** Set when the console was opened from / saved to a .sql file. */
  filePath?: string
  /** Text of `filePath` as last opened or saved (content !== savedContent = unsaved changes). */
  savedContent?: string
  pinned?: boolean
}

export interface TableTab {
  id: string
  kind: 'table' | 'structure'
  title: string
  connectionId: string
  database: string
  table: { schema: string; name: string; kind: ObjectKind }
  pinned?: boolean
}

/** Live list of the server's sessions (not persisted: it only makes sense while the app runs). */
export interface SessionsTab {
  id: string
  kind: 'sessions'
  title: string
  connectionId: string
  database?: undefined
  pinned?: boolean
}

export type Tab = ConsoleTab | TableTab | SessionsTab

export interface OpenConsoleOptions {
  connectionId: string
  database?: string
  schema?: string
  content?: string
  title?: string
  filePath?: string
}

export interface OpenTableOptions {
  connectionId: string
  database: string
  schema: string
  name: string
  kind: ObjectKind
}

interface TabsState {
  tabs: Tab[]
  activeTabId: string | null
  hydrated: boolean
  /** Free-form persisted layout values (panel sizes…), see setLayout. */
  layout: Record<string, unknown>

  hydrate: () => Promise<void>
  openConsole: (options: OpenConsoleOptions) => string
  /** Focus an existing tab for the same object and view, or open a new one. */
  openTable: (options: OpenTableOptions, view: 'table' | 'structure') => string
  /** Close guards (registerCloseGuard) may veto; resolves once the tabs are closed or kept. */
  closeTab: (id: string) => Promise<void>
  closeOthers: (id: string) => Promise<void>
  closeAll: () => Promise<void>
  setActive: (id: string) => void
  move: (fromIndex: number, toIndex: number) => void
  updateConsole: (id: string, patch: Partial<Omit<ConsoleTab, 'id' | 'kind'>>) => void
  rename: (id: string, title: string) => void
  togglePin: (id: string) => void
  setLayout: (key: string, value: unknown) => void
  /** Focus the sessions tab of the connection, or open one. */
  openSessions: (connectionId: string) => string
  /** Put a closed tab back (undo close) at `index`, and activate it. */
  reopen: (tab: Tab, index: number) => string
}

/** Hooks run when a tab closes (consoles store closes the session). */
const closeListeners = new Set<(tab: Tab) => void>()
export function onTabClosed(listener: (tab: Tab) => void): () => void {
  closeListeners.add(listener)
  return () => closeListeners.delete(listener)
}

/** Asked before a tab closes; resolve false to keep it open (e.g. unsaved table edits). */
export type CloseGuard = (tab: Tab) => boolean | Promise<boolean>
const closeGuards = new Set<CloseGuard>()
export function registerCloseGuard(guard: CloseGuard): () => void {
  closeGuards.add(guard)
  return () => closeGuards.delete(guard)
}

function nextConsoleTitle(tabs: Tab[]): string {
  const used = new Set(tabs.filter((t) => t.kind === 'console').map((t) => t.title))
  for (let i = 1; ; i++) {
    const title = `Query ${i}`
    if (!used.has(title)) return title
  }
}

function toPersisted(tab: Tab): PersistedTab | null {
  if (tab.kind === 'sessions') return null
  if (tab.kind === 'console') {
    return {
      id: tab.id,
      kind: 'console',
      title: tab.title,
      connectionId: tab.connectionId,
      database: tab.database,
      schema: tab.schema,
      content: tab.content,
      filePath: tab.filePath,
      pinned: tab.pinned,
    }
  }
  return {
    id: tab.id,
    kind: tab.kind,
    title: tab.title,
    connectionId: tab.connectionId,
    database: tab.database,
    table: tab.table,
    pinned: tab.pinned,
  }
}

function fromPersisted(p: PersistedTab): Tab | null {
  if (p.kind === 'console') {
    return {
      id: p.id,
      kind: 'console',
      title: p.title,
      connectionId: p.connectionId,
      database: p.database,
      schema: p.schema,
      content: p.content ?? '',
      filePath: p.filePath,
      // Unknown after a restart: assume the file matches what was persisted.
      savedContent: p.filePath ? (p.content ?? '') : undefined,
      pinned: p.pinned,
    }
  }
  if (!p.table || !p.database) return null
  return { id: p.id, kind: p.kind, title: p.title, connectionId: p.connectionId, database: p.database, table: p.table, pinned: p.pinned }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined

export const useTabs = create<TabsState>((set, get) => {
  const activate = (tabs: Tab[], activeTabId: string | null) => {
    markRegion('workspace')
    set({ tabs, activeTabId })
  }

  const remove = (ids: Set<string>) => {
    const { tabs, activeTabId } = get()
    const closing = tabs.filter((t) => ids.has(t.id))
    if (closing.length === 0) return
    const remaining = tabs.filter((t) => !ids.has(t.id))
    let nextActive = activeTabId
    if (activeTabId && ids.has(activeTabId)) {
      const oldIndex = tabs.findIndex((t) => t.id === activeTabId)
      const neighbour = remaining[Math.min(oldIndex, remaining.length - 1)]
      nextActive = neighbour?.id ?? null
    }
    activate(remaining, nextActive)
    for (const tab of closing) for (const listener of closeListeners) listener(tab)
  }

  // Guards run one after the other (each may show a dialog). The close is synchronous when every
  // guard allows synchronously; one refusal keeps all the tabs of the request open.
  const close = (ids: Set<string>): Promise<void> => {
    const checks = get()
      .tabs.filter((t) => ids.has(t.id))
      .flatMap((tab) => [...closeGuards].map((guard) => () => guard(tab)))
    for (let i = 0; i < checks.length; i++) {
      const answer = checks[i]!()
      if (answer === true) continue
      if (answer === false) return Promise.resolve()
      return (async () => {
        if (!(await answer)) return
        for (const check of checks.slice(i + 1)) if (!(await check())) return
        remove(new Set([...ids].filter((id) => get().tabs.some((t) => t.id === id))))
      })()
    }
    remove(ids)
    return Promise.resolve()
  }

  return {
    tabs: [],
    activeTabId: null,
    hydrated: false,
    layout: {},

    hydrate: async () => {
      const state = await api.workspace.load()
      const tabs = (state?.tabs ?? []).map(fromPersisted).filter((t): t is Tab => t !== null)
      const activeTabId = tabs.some((t) => t.id === state?.activeTabId) ? (state?.activeTabId ?? null) : (tabs[0]?.id ?? null)
      set({ tabs, activeTabId, layout: state?.layout ?? {}, hydrated: true })
    },

    openConsole: (options) => {
      const tab: ConsoleTab = {
        id: uid('tab'),
        kind: 'console',
        title: options.title ?? nextConsoleTitle(get().tabs),
        connectionId: options.connectionId,
        database: options.database,
        schema: options.schema,
        content: options.content ?? '',
        filePath: options.filePath,
        savedContent: options.filePath ? (options.content ?? '') : undefined,
      }
      activate([...get().tabs, tab], tab.id)
      return tab.id
    },

    openTable: (options, view) => {
      const existing = get().tabs.find(
        (t) =>
          t.kind === view &&
          t.connectionId === options.connectionId &&
          t.database === options.database &&
          t.table.schema === options.schema &&
          t.table.name === options.name,
      )
      if (existing) {
        markRegion('workspace')
        set({ activeTabId: existing.id })
        return existing.id
      }
      const tab: TableTab = {
        id: uid('tab'),
        kind: view,
        title: options.name,
        connectionId: options.connectionId,
        database: options.database,
        table: { schema: options.schema, name: options.name, kind: options.kind },
      }
      activate([...get().tabs, tab], tab.id)
      return tab.id
    },

    openSessions: (connectionId) => {
      const existing = get().tabs.find((t) => t.kind === 'sessions' && t.connectionId === connectionId)
      if (existing) {
        markRegion('workspace')
        set({ activeTabId: existing.id })
        return existing.id
      }
      const tab: SessionsTab = { id: uid('tab'), kind: 'sessions', title: 'Sessions', connectionId }
      activate([...get().tabs, tab], tab.id)
      return tab.id
    },

    closeTab: (id) => close(new Set([id])),
    closeOthers: (id) => close(new Set(get().tabs.filter((t) => t.id !== id && !t.pinned).map((t) => t.id))),
    closeAll: () => close(new Set(get().tabs.filter((t) => !t.pinned).map((t) => t.id))),
    setActive: (id) => {
      markRegion('workspace')
      set({ activeTabId: id })
    },
    move: (fromIndex, toIndex) => {
      const tabs = [...get().tabs]
      const [tab] = tabs.splice(fromIndex, 1)
      if (!tab) return
      tabs.splice(Math.max(0, Math.min(toIndex, tabs.length)), 0, tab)
      set({ tabs })
    },
    updateConsole: (id, patch) =>
      set({
        tabs: get().tabs.map((t) => {
          if (t.id !== id || t.kind !== 'console') return t
          const next = { ...t, ...patch }
          // Saving to (or opening) a file records what the file now holds.
          if (patch.filePath !== undefined && patch.savedContent === undefined) next.savedContent = next.content
          return next
        }),
      }),
    rename: (id, title) => set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, title } : t)) }),
    togglePin: (id) => set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t)) }),
    setLayout: (key, value) => set({ layout: { ...get().layout, [key]: value } }),
    reopen: (tab, index) => {
      const tabs = [...get().tabs]
      const restored = tabs.some((t) => t.id === tab.id) ? { ...tab, id: uid('tab') } : tab
      tabs.splice(Math.max(0, Math.min(index, tabs.length)), 0, restored)
      activate(tabs, restored.id)
      return restored.id
    },
  }
})

function saveWorkspaceNow(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = undefined
  const { tabs, activeTabId, layout, hydrated } = useTabs.getState()
  if (!hydrated) return
  const persisted = tabs.map(toPersisted).filter((t): t is PersistedTab => t !== null)
  // A transient tab (sessions) is not restored: the next start opens the tab saved next to it.
  const active = persisted.some((t) => t.id === activeTabId) ? activeTabId : persisted[persisted.length - 1]?.id
  const workspace: WorkspaceState = { version: 1, tabs: persisted, activeTabId: active ?? undefined, layout }
  void api.workspace.save(workspace).catch(() => undefined)
}

// Debounced persistence of tabs + layout.
useTabs.subscribe((state, prev) => {
  if (!state.hydrated) return
  if (state.tabs === prev.tabs && state.activeTabId === prev.activeTabId && state.layout === prev.layout) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(saveWorkspaceNow, 400)
})

/** Save the workspace right away when a save is pending (the window is closing or reloading). */
export function flushWorkspace(): void {
  if (saveTimer) saveWorkspaceNow()
}

export function activeTab(): Tab | undefined {
  const { tabs, activeTabId } = useTabs.getState()
  return tabs.find((t) => t.id === activeTabId)
}
