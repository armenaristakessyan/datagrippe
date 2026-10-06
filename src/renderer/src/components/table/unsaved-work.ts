// Reports pending (unsubmitted) table edits to main, which asks before quitting or closing the window
// when that list is not empty (it adds the consoles with an open transaction itself).
import type { UnsavedWorkItem } from '@shared/types'
import { call } from '@/lib/api'
import { pluralize } from '@/lib/format'
import { useTabs } from '@/stores/tabs'
import { changeCount, hasChanges } from './pending-changes'
import { useTableSessions } from './table-session'

/** Tabs with pending edits, as main's quit guard lists them. */
export function unsavedTableWork(): UnsavedWorkItem[] {
  const { sessions } = useTableSessions.getState()
  const items: UnsavedWorkItem[] = []
  for (const tab of useTabs.getState().tabs) {
    if (tab.kind !== 'table') continue
    const changes = sessions[tab.id]?.changes
    if (!changes || !hasChanges(changes)) continue
    items.push({
      kind: 'table-edits',
      title: `${tab.table.schema}.${tab.table.name}`,
      detail: `${pluralize(changeCount(changes), 'pending change')}`,
    })
  }
  return items
}

const keyOf = (items: UnsavedWorkItem[]) => items.map((i) => `${i.title}\u0000${i.detail ?? ''}`).join('\u0001')

/** Keep main informed while the app runs. Returns the unsubscribe function. */
export function bindUnsavedWorkReport(): () => void {
  let last = ''
  const report = () => {
    const items = unsavedTableWork()
    const key = keyOf(items)
    if (key === last) return
    last = key
    void call('app:setUnsavedWork', items).catch(() => undefined)
  }
  const offSessions = useTableSessions.subscribe((state, prev) => {
    if (state.sessions !== prev.sessions) report()
  })
  const offTabs = useTabs.subscribe((state, prev) => {
    if (state.tabs !== prev.tabs) report()
  })
  return () => {
    offSessions()
    offTabs()
  }
}
