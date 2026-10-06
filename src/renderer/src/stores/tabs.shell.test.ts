import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceState } from '@shared/types'

const save = vi.fn(async (_state: WorkspaceState) => undefined)
vi.mock('@/lib/api', () => ({ api: { workspace: { save, load: vi.fn(async () => null) } } }))

const { useTabs } = await import('./tabs')

beforeEach(() => {
  vi.useFakeTimers()
  save.mockClear()
  useTabs.setState({ tabs: [], activeTabId: null, layout: {}, hydrated: true })
})
afterEach(() => vi.useRealTimers())

describe('sessions tabs', () => {
  it('are reused per connection and never persisted', () => {
    const consoleId = useTabs.getState().openConsole({ connectionId: 'c', title: 'Q' })
    const sessions = useTabs.getState().openSessions('c')
    expect(useTabs.getState().openSessions('c')).toBe(sessions)
    expect(useTabs.getState().openSessions('d')).not.toBe(sessions)
    useTabs.getState().setActive(sessions)
    vi.advanceTimersByTime(500)
    const saved = save.mock.calls.at(-1)?.[0]
    expect(saved?.tabs.map((t) => t.id)).toEqual([consoleId])
    // The active sessions tab is not restored: the persisted tab next to it is.
    expect(saved?.activeTabId).toBe(consoleId)
  })
})

describe('reopen', () => {
  it('puts a closed tab back at its place and activates it', async () => {
    useTabs.getState().openConsole({ connectionId: 'c', title: 'A' })
    const b = useTabs.getState().openConsole({ connectionId: 'c', title: 'B', content: 'select 1' })
    useTabs.getState().openConsole({ connectionId: 'c', title: 'C' })
    const closed = useTabs.getState().tabs[1]!
    await useTabs.getState().closeTab(b)
    expect(useTabs.getState().reopen(closed, 1)).toBe(b)
    expect(useTabs.getState().tabs.map((t) => t.title)).toEqual(['A', 'B', 'C'])
    expect(useTabs.getState().activeTabId).toBe(b)
    // Reopening a tab whose id is taken gives it a fresh id.
    expect(useTabs.getState().reopen(closed, 0)).not.toBe(b)
  })
})
