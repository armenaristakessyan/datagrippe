import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceState } from '@shared/types'

const save = vi.fn(async (_state: WorkspaceState) => undefined)
const load = vi.fn(async (): Promise<WorkspaceState | null> => null)
vi.mock('@/lib/api', () => ({ api: { workspace: { save, load } } }))

const { onTabClosed, registerCloseGuard, useTabs } = await import('./tabs')

const titles = () => useTabs.getState().tabs.map((t) => t.title)

describe('tabs store', () => {
  beforeEach(() => {
    useTabs.setState({ tabs: [], activeTabId: null, layout: {}, hydrated: false })
  })

  it('closes synchronously when no guard objects', () => {
    const a = useTabs.getState().openConsole({ connectionId: 'c', title: 'A' })
    useTabs.getState().openConsole({ connectionId: 'c', title: 'B' })
    const closed: string[] = []
    const off = onTabClosed((t) => closed.push(t.title))
    const unguard = registerCloseGuard(() => true)
    void useTabs.getState().closeTab(a)
    expect(titles()).toEqual(['B'])
    expect(closed).toEqual(['A'])
    off()
    unguard()
  })

  it('keeps every tab of the request when a guard refuses', async () => {
    const { openConsole, openTable } = useTabs.getState()
    openConsole({ connectionId: 'c', title: 'A' })
    const table = openTable({ connectionId: 'c', database: 'db', schema: 's', name: 'orders', kind: 'table' }, 'table')
    const keep = vi.fn(async () => false)
    const unguard = registerCloseGuard((tab) => (tab.id === table ? keep() : true))
    await useTabs.getState().closeAll()
    expect(keep).toHaveBeenCalledOnce()
    expect(titles()).toEqual(['A', 'orders'])
    unguard()
  })

  it('closes after asynchronous approval, asking one tab at a time', async () => {
    useTabs.getState().openConsole({ connectionId: 'c', title: 'A' })
    useTabs.getState().openConsole({ connectionId: 'c', title: 'B' })
    const order: string[] = []
    let resolveFirst: (v: boolean) => void = () => undefined
    const unguard = registerCloseGuard((tab) => {
      order.push(tab.title)
      if (tab.title === 'A') return new Promise<boolean>((r) => (resolveFirst = r))
      return Promise.resolve(true)
    })
    const done = useTabs.getState().closeAll()
    expect(order).toEqual(['A'])
    resolveFirst(true)
    await done
    expect(order).toEqual(['A', 'B'])
    expect(titles()).toEqual([])
    expect(useTabs.getState().activeTabId).toBeNull()
    unguard()
  })

  it('persists the file path of console tabs', async () => {
    load.mockResolvedValueOnce({
      version: 1,
      tabs: [{ id: 't1', kind: 'console', title: 'Q', connectionId: 'c', content: 'select 1', filePath: '/tmp/q.sql' }],
      activeTabId: 't1',
    })
    await useTabs.getState().hydrate()
    const tab = useTabs.getState().tabs[0]
    expect(tab?.kind === 'console' && tab.filePath).toBe('/tmp/q.sql')
    vi.useFakeTimers()
    useTabs.getState().rename('t1', 'Renamed')
    vi.advanceTimersByTime(500)
    vi.useRealTimers()
    expect(save.mock.calls.at(-1)?.[0].tabs[0]).toMatchObject({ title: 'Renamed', filePath: '/tmp/q.sql' })
  })
})
