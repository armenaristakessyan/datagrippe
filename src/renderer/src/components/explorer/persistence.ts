// Explorer side effects: expanded-state persistence in the workspace layout, and auto-reveal of the
// default database / schema when a connection comes up.
import { useEffect } from 'react'
import { useConnections } from '@/stores/connections'
import { useExplorer } from '@/stores/explorer'
import { useTabs } from '@/stores/tabs'
import { revealDefaults } from './actions'
import { pruneExpanded } from './tree'

export const EXPANDED_LAYOUT_KEY = 'explorer.expanded'
const SAVE_DELAY_MS = 300

/** The workspace is restored once per app run (remounts, e.g. after an error boundary reset, keep the live state). */
let restored = false

function readPersisted(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, boolean> = {}
  for (const [id, v] of Object.entries(value)) if (typeof v === 'boolean') out[id] = v
  return out
}

export function useExplorerPersistence(): void {
  useEffect(() => {
    if (!restored) {
      restored = true
      const ids = new Set(useConnections.getState().connections.map((c) => c.id))
      const persisted = pruneExpanded(readPersisted(useTabs.getState().layout[EXPANDED_LAYOUT_KEY]), ids)
      useExplorer.getState().replaceExpanded({ ...persisted, ...useExplorer.getState().expanded })
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = useExplorer.subscribe((state, prev) => {
      if (state.expanded === prev.expanded) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        const ids = new Set(useConnections.getState().connections.map((c) => c.id))
        useTabs.getState().setLayout(EXPANDED_LAYOUT_KEY, pruneExpanded(useExplorer.getState().expanded, ids))
      }, SAVE_DELAY_MS)
    })
    return () => {
      unsubscribe()
      if (timer) clearTimeout(timer)
    }
  }, [])
}

/** connecting → connected: expand the connection, its default database and default schema. */
export function useRevealOnConnect(): void {
  useEffect(
    () =>
      useConnections.subscribe((state, prev) => {
        for (const [id, runtime] of Object.entries(state.runtime)) {
          if (runtime.status === 'connected' && prev.runtime[id]?.status === 'connecting') void revealDefaults(id)
        }
      }),
    [],
  )
}
