// Cache of explorer metadata + tree UI state. Keys are built with the helpers below.
import { create } from 'zustand'
import type { DatabaseInfo, DbObjectInfo, SchemaInfo, TableDetails } from '@shared/types'
import { api, errorMessage } from '@/lib/api'
import { markRegion } from '@/lib/recency'
import { connectionById, useConnections } from './connections'

export interface Loadable<T> {
  status: 'loading' | 'ready' | 'error'
  data?: T
  error?: string
}

export const dbKey = (connectionId: string, database: string) => `${connectionId}|${database}`
export const schemaKey = (connectionId: string, database: string, schema: string) =>
  `${connectionId}|${database}|${schema}`
export const objectKey = (connectionId: string, database: string, schema: string, name: string) =>
  `${connectionId}|${database}|${schema}|${name}`

interface ExplorerState {
  databases: Record<string, Loadable<DatabaseInfo[]>>
  schemas: Record<string, Loadable<SchemaInfo[]>>
  objects: Record<string, Loadable<DbObjectInfo[]>>
  details: Record<string, Loadable<TableDetails>>
  /** Tree node id → expanded. Node ids are chosen by the explorer component. */
  expanded: Record<string, boolean>
  selectedNode: string | null
  filter: string

  loadDatabases: (connectionId: string, force?: boolean) => Promise<DatabaseInfo[] | undefined>
  loadSchemas: (connectionId: string, database: string, force?: boolean) => Promise<SchemaInfo[] | undefined>
  loadObjects: (connectionId: string, database: string, schema: string, force?: boolean) => Promise<DbObjectInfo[] | undefined>
  loadDetails: (connectionId: string, database: string, schema: string, name: string, force?: boolean) => Promise<TableDetails | undefined>
  setExpanded: (nodeId: string, expanded: boolean) => void
  /** Set several nodes at once (one store update). */
  setExpandedMany: (nodeIds: string[], expanded: boolean) => void
  /** Replace the whole expanded map (restore from the workspace, collapse all…). */
  replaceExpanded: (expanded: Record<string, boolean>) => void
  toggle: (nodeId: string) => void
  select: (nodeId: string | null) => void
  setFilter: (filter: string) => void
  /** Drop cached metadata for a connection (optionally a database / schema within it). */
  invalidate: (connectionId: string, database?: string, schema?: string) => void
  /**
   * Reload everything already cached under connection › database › schema › object (the deepest given
   * level and below). Stale data stays visible while reloading.
   */
  refresh: (connectionId: string, database?: string, schema?: string, name?: string) => Promise<void>
}

type CacheField = 'databases' | 'schemas' | 'objects' | 'details'
const CACHE_FIELDS: CacheField[] = ['databases', 'schemas', 'objects', 'details']

/** In-flight requests per cache entry, so concurrent callers share one IPC round trip. */
const inflight = new Map<string, Promise<unknown>>()
/** How to reload each cache entry (keys cannot be parsed back reliably: names may contain "|"). */
const reloaders = new Map<string, () => Promise<unknown>>()
/** Latest request per cache entry; responses of superseded or invalidated requests are dropped. */
const tokens = new Map<string, number>()
let nextToken = 0

const slot = (field: CacheField, key: string) => `${field}\u0000${key}`

function prefixOf(parts: (string | undefined)[]): string {
  const defined: string[] = []
  for (const p of parts) {
    if (p === undefined) break
    defined.push(p)
  }
  return defined.join('|')
}

const underPrefix = (prefix: string) => (key: string) => key === prefix || key.startsWith(`${prefix}|`)

export const useExplorer = create<ExplorerState>((set, get) => {
  function load<T>(field: CacheField, key: string, force: boolean | undefined, connectionId: string, fetcher: () => Promise<T>): Promise<T | undefined> {
    const id = slot(field, key)
    reloaders.set(id, () => load(field, key, true, connectionId, fetcher))
    const current = get()[field][key] as Loadable<T> | undefined
    if (!force && current?.status === 'ready') return Promise.resolve(current.data)
    const running = inflight.get(id) as Promise<T | undefined> | undefined
    if (running) return running

    const token = ++nextToken
    tokens.set(id, token)
    const write = (entry: Loadable<T>) => {
      if (tokens.get(id) !== token) return
      set({ [field]: { ...get()[field], [key]: entry } } as Partial<ExplorerState>)
    }
    write({ status: 'loading', data: current?.data })
    const run = (async () => {
      try {
        const ok = await useConnections.getState().ensureConnected(connectionId)
        if (!ok) throw new Error(useConnections.getState().runtime[connectionId]?.error ?? 'Not connected')
        const data = await fetcher()
        write({ status: 'ready', data })
        return data
      } catch (error) {
        write({ status: 'error', error: errorMessage(error) })
        return undefined
      } finally {
        if (tokens.get(id) === token) inflight.delete(id)
      }
    })()
    inflight.set(id, run)
    return run
  }

  return {
    databases: {},
    schemas: {},
    objects: {},
    details: {},
    expanded: {},
    selectedNode: null,
    filter: '',

    loadDatabases: (connectionId, force) =>
      load('databases', connectionId, force, connectionId, () => api.meta.databases(connectionId)),
    loadSchemas: (connectionId, database, force) =>
      load('schemas', dbKey(connectionId, database), force, connectionId, () => api.meta.schemas(connectionId, database)),
    loadObjects: (connectionId, database, schema, force) =>
      load('objects', schemaKey(connectionId, database, schema), force, connectionId, () =>
        api.meta.objects(connectionId, database, schema),
      ),
    loadDetails: (connectionId, database, schema, name, force) =>
      load('details', objectKey(connectionId, database, schema, name), force, connectionId, () =>
        api.meta.tableDetails(connectionId, database, schema, name),
      ),

    setExpanded: (nodeId, expanded) => {
      if (Boolean(get().expanded[nodeId]) === expanded && nodeId in get().expanded) return
      set({ expanded: { ...get().expanded, [nodeId]: expanded } })
    },
    setExpandedMany: (nodeIds, expanded) => {
      if (nodeIds.length === 0) return
      const next = { ...get().expanded }
      for (const id of nodeIds) next[id] = expanded
      set({ expanded: next })
    },
    replaceExpanded: (expanded) => set({ expanded }),
    toggle: (nodeId) => set({ expanded: { ...get().expanded, [nodeId]: !get().expanded[nodeId] } }),
    select: (selectedNode) => {
      if (selectedNode !== null) markRegion('explorer')
      set({ selectedNode })
    },
    setFilter: (filter) => set({ filter }),

    invalidate: (connectionId, database, schema) => {
      const matches = underPrefix(prefixOf([connectionId, database, schema]))
      const prune = <T,>(record: Record<string, T>) =>
        Object.fromEntries(Object.entries(record).filter(([key]) => !matches(key)))
      for (const field of CACHE_FIELDS) {
        if (field === 'databases' && database !== undefined) continue
        for (const key of Object.keys(get()[field])) {
          if (matches(key)) {
            inflight.delete(slot(field, key))
            reloaders.delete(slot(field, key))
            tokens.delete(slot(field, key))
          }
        }
      }
      set({
        databases: database === undefined ? prune(get().databases) : get().databases,
        schemas: prune(get().schemas),
        objects: prune(get().objects),
        details: prune(get().details),
      })
    },

    refresh: async (connectionId, database, schema, name) => {
      const prefix = prefixOf([connectionId, database, schema, name])
      const matches = underPrefix(prefix)
      // The databases list is keyed by the connection alone; only a connection refresh reloads it.
      const fields = database === undefined ? CACHE_FIELDS : CACHE_FIELDS.filter((f) => f !== 'databases')
      const jobs: Promise<unknown>[] = []
      for (const field of fields) {
        for (const key of Object.keys(get()[field])) {
          if (!matches(key)) continue
          const reload = reloaders.get(slot(field, key))
          if (reload) jobs.push(reload())
        }
      }
      await Promise.all(jobs)
    },
  }
})

// Cached metadata belongs to a live connection: drop it when the connection closes or is deleted.
useConnections.subscribe((state, prev) => {
  const { invalidate } = useExplorer.getState()
  for (const [id, runtime] of Object.entries(state.runtime)) {
    const before = prev.runtime[id]?.status
    const closed = runtime.status === 'disconnected' || runtime.status === 'error'
    if (closed && before === 'connected') invalidate(id)
  }
  if (state.connections !== prev.connections) {
    const alive = new Set(state.connections.map((c) => c.id))
    for (const c of prev.connections) if (!alive.has(c.id)) invalidate(c.id)
  }
})

/** Default database for a connection (its configured database, else the first non-system one). */
export function defaultDatabase(connectionId: string): string | undefined {
  const config = connectionById(connectionId)
  if (config?.database) return config.database
  const info = useConnections.getState().runtime[connectionId]?.info
  if (info?.currentDatabase) return info.currentDatabase
  const dbs = useExplorer.getState().databases[connectionId]?.data
  return dbs?.find((d) => !d.isSystem)?.name ?? dbs?.[0]?.name
}

/** Schema the explorer reveals after connecting: configured default, then the server's, then public / dbo. */
export function defaultSchema(connectionId: string, database: string): string | undefined {
  const config = connectionById(connectionId)
  const schemas = useExplorer.getState().schemas[dbKey(connectionId, database)]?.data
  const names = schemas?.map((s) => s.name) ?? []
  const info = useConnections.getState().runtime[connectionId]?.info
  const candidates = [
    config?.options.defaultSchema,
    info && info.currentDatabase === database ? info.currentSchema : undefined,
    config?.dialect === 'mssql' ? 'dbo' : 'public',
  ]
  for (const c of candidates) if (c && names.includes(c)) return c
  return schemas?.find((s) => !s.isSystem)?.name
}
