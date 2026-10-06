// Autocompletion catalogs, one per connection + database.
import { create } from 'zustand'
import type { CompletionCatalog } from '@shared/types'
import { api, errorMessage } from '@/lib/api'
import { dbKey, type Loadable } from './explorer'

interface CatalogState {
  catalogs: Record<string, Loadable<CompletionCatalog>>
  /** Load (or reuse) the catalog; concurrent calls share one request. Resolves to the data, if any. */
  load: (connectionId: string, database: string, force?: boolean) => Promise<CompletionCatalog | undefined>
  invalidate: (connectionId: string) => void
}

const inflight = new Map<string, Promise<CompletionCatalog | undefined>>()
const latest = new Map<string, symbol>()

export const useCatalog = create<CatalogState>((set, get) => ({
  catalogs: {},
  load: (connectionId, database, force) => {
    const key = dbKey(connectionId, database)
    const current = get().catalogs[key]
    if (!force && current?.status === 'ready') return Promise.resolve(current.data)
    const pending = inflight.get(key)
    if (pending && !force) return pending
    set({ catalogs: { ...get().catalogs, [key]: { status: 'loading', data: current?.data } } })
    // A newer (forced) request supersedes this one: only the latest writes its outcome.
    const token = Symbol(key)
    const isLatest = () => latest.get(key) === token
    latest.set(key, token)
    const promise = api.meta
      .completionCatalog(connectionId, database)
      .then((data) => {
        if (isLatest()) set({ catalogs: { ...get().catalogs, [key]: { status: 'ready', data } } })
        return data
      })
      .catch((error: unknown) => {
        const previous = get().catalogs[key]?.data
        if (isLatest()) set({ catalogs: { ...get().catalogs, [key]: { status: 'error', error: errorMessage(error), data: previous } } })
        return previous
      })
      .finally(() => {
        if (isLatest()) inflight.delete(key)
      })
    inflight.set(key, promise)
    return promise
  },
  invalidate: (connectionId) => {
    for (const key of [...inflight.keys()]) {
      if (key.startsWith(`${connectionId}|`)) {
        inflight.delete(key)
        latest.delete(key)
      }
    }
    set({
      catalogs: Object.fromEntries(Object.entries(get().catalogs).filter(([k]) => !k.startsWith(`${connectionId}|`))),
    })
  },
}))

/** The catalog of a connection + database, if loaded. */
export function catalogFor(connectionId: string | undefined, database: string | undefined): CompletionCatalog | undefined {
  if (!connectionId || !database) return undefined
  return useCatalog.getState().catalogs[dbKey(connectionId, database)]?.data
}
