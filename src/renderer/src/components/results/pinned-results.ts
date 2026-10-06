// Pinned results of a console: a pinned result stays available (as its own tab) after the console
// runs again, so results can be compared before / after a change. While its execution is still the
// current one, the snapshot follows the live result (rows fetched later included).
import { create } from 'zustand'
import type { ExecutionResult, StatementResult } from '@shared/types'
import { uid } from '@/lib/id'
import { onTabClosed } from '@/stores/tabs'

export interface PinnedResult {
  id: string
  executionId: string
  index: number
  /** Snapshot of the result (rows fetched so far). */
  result: StatementResult
  /** When the execution that produced it was pinned / last seen live. */
  pinnedAt: number
}

/** Pinned results kept per console at most (the oldest go first). */
export const MAX_PINNED = 8

interface PinnedStore {
  /** Console tab id → pinned results, oldest first. */
  pinned: Record<string, PinnedResult[]>
  /** Console tab id → id of the pinned result shown (from an older run). */
  active: Record<string, string | undefined>
  /** Console tab id → execution last shown by the results panel. */
  seen: Record<string, string | undefined>
}

export const usePinnedResults = create<PinnedStore>(() => ({ pinned: {}, active: {}, seen: {} }))

const NONE: PinnedResult[] = []

export function usePinned(tabId: string): PinnedResult[] {
  return usePinnedResults((s) => s.pinned[tabId]) ?? NONE
}

export function isPinned(tabId: string, executionId: string | undefined, index: number): boolean {
  return (usePinnedResults.getState().pinned[tabId] ?? NONE).some((p) => p.executionId === executionId && p.index === index)
}

export function pinResult(tabId: string, execution: ExecutionResult, index: number): void {
  const result = execution.results[index]
  if (!result || isPinned(tabId, execution.executionId, index)) return
  const { pinned } = usePinnedResults.getState()
  const list = [...(pinned[tabId] ?? NONE), { id: uid('pin'), executionId: execution.executionId, index, result, pinnedAt: Date.now() }]
  usePinnedResults.setState({ pinned: { ...pinned, [tabId]: list.slice(-MAX_PINNED) } })
}

export function unpinResult(tabId: string, match: { id?: string; executionId?: string; index?: number }): void {
  const { pinned, active } = usePinnedResults.getState()
  const list = (pinned[tabId] ?? NONE).filter((p) => !(match.id !== undefined ? p.id === match.id : p.executionId === match.executionId && p.index === match.index))
  const removedActive = active[tabId] !== undefined && !list.some((p) => p.id === active[tabId])
  usePinnedResults.setState({
    pinned: { ...pinned, [tabId]: list },
    active: removedActive ? { ...active, [tabId]: undefined } : active,
  })
}

export function showPinned(tabId: string, id: string | undefined): void {
  const { active } = usePinnedResults.getState()
  if (active[tabId] === id) return
  usePinnedResults.setState({ active: { ...active, [tabId]: id } })
}

/**
 * The results panel shows `executionId`: when it is a new one (a new run, or a plan replacing the
 * results), the panel goes back to the live output instead of an older pinned result.
 */
export function noteExecution(tabId: string, executionId: string | undefined): void {
  const { seen, active } = usePinnedResults.getState()
  if (tabId in seen && seen[tabId] === executionId) return
  const reset = tabId in seen && active[tabId] !== undefined
  usePinnedResults.setState({ seen: { ...seen, [tabId]: executionId }, active: reset ? { ...active, [tabId]: undefined } : active })
}

/** Keep the snapshots of the live execution's pinned results up to date. */
export function syncPinned(tabId: string, execution: ExecutionResult | undefined): void {
  if (!execution) return
  const { pinned } = usePinnedResults.getState()
  const list = pinned[tabId]
  if (!list?.some((p) => p.executionId === execution.executionId)) return
  let changed = false
  const next = list.map((p) => {
    if (p.executionId !== execution.executionId) return p
    const live = execution.results[p.index]
    if (!live || live === p.result) return p
    changed = true
    return { ...p, result: live }
  })
  if (changed) usePinnedResults.setState({ pinned: { ...pinned, [tabId]: next } })
}

export function dropPinned(tabId: string): void {
  const { pinned, active, seen } = usePinnedResults.getState()
  if (!(tabId in pinned) && !(tabId in active) && !(tabId in seen)) return
  const nextPinned = { ...pinned }
  const nextActive = { ...active }
  const nextSeen = { ...seen }
  delete nextPinned[tabId]
  delete nextActive[tabId]
  delete nextSeen[tabId]
  usePinnedResults.setState({ pinned: nextPinned, active: nextActive, seen: nextSeen })
}

// A closed console takes its pinned results with it.
onTabClosed((tab) => {
  if (tab.kind === 'console') dropPinned(tab.id)
})

/** "10:42" — time label of a pinned result. */
export function pinTime(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
