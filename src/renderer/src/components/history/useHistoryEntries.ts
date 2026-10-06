// Loads query history for the panel: debounced search, connection filter, refresh after executions.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { HistoryEntry } from '@shared/types'
import { api, errorMessage } from '@/lib/api'
import { useConsoles } from '@/stores/consoles'

export const HISTORY_PAGE = 1000
const SEARCH_DEBOUNCE_MS = 160
/** Main records the entry while answering session:execute; a short delay avoids racing it. */
const AFTER_RUN_DELAY_MS = 150

export type HistoryLoad =
  | { status: 'loading'; entries: HistoryEntry[] }
  | { status: 'ready'; entries: HistoryEntry[] }
  | { status: 'error'; entries: HistoryEntry[]; error: string }

export function useHistoryEntries(open: boolean, connectionId: string | undefined, search: string) {
  const [state, setState] = useState<HistoryLoad>({ status: 'loading', entries: [] })
  const [debounced, setDebounced] = useState(search)
  const request = useRef(0)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [search])

  const reload = useCallback(async () => {
    const id = ++request.current
    setState((s) => ({ status: 'loading', entries: s.entries }))
    try {
      const entries = await api.history.list({ connectionId, search: debounced || undefined, limit: HISTORY_PAGE })
      if (id === request.current) setState({ status: 'ready', entries })
    } catch (error) {
      if (id === request.current) setState((s) => ({ status: 'error', entries: s.entries, error: errorMessage(error) }))
    }
  }, [connectionId, debounced])

  useEffect(() => {
    if (open) void reload()
  }, [open, reload])

  // Refresh when any console finishes running (a new history entry exists).
  useEffect(() => {
    if (!open) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = useConsoles.subscribe((next, prev) => {
      const finished = Object.entries(next.runtimes).some(([tabId, rt]) => {
        const before = prev.runtimes[tabId]
        return (before?.status === 'running' && rt.status !== 'running') || (rt.execution !== undefined && rt.execution !== before?.execution)
      })
      if (!finished) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void reload(), AFTER_RUN_DELAY_MS)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [open, reload])

  return { state, reload, searching: debounced !== '' }
}
