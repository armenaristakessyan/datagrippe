import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionConfig } from '@shared/types'

const disconnectApi = vi.fn(async (_id: string) => undefined)
vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    info: { message: string; kind?: string }
    constructor(info: { message: string; kind?: string }) {
      super(info.message)
      this.info = info
    }
  }
  return {
    ApiError,
    api: {
      session: { close: vi.fn(async () => undefined) },
      connections: { disconnect: disconnectApi },
      workspace: { save: vi.fn(async () => undefined), load: vi.fn() },
    },
    errorInfo: (e: unknown) => ({ message: e instanceof Error ? e.message : String(e) }),
    errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
    onEvent: () => () => undefined,
  }
})
const toastMessage = vi.fn()
vi.mock('@/components/ui', () => ({ toast: { message: toastMessage, error: vi.fn(), success: vi.fn(), info: vi.fn() } }))

const { bindConsoleGuards, confirmCloseConsole, confirmDisconnect, consoleWork, describeWork, hasUnsavedFile, listTitles } = await import('./console-guards')
const { disconnect } = await import('@/components/explorer/actions')
const { useConsoles } = await import('@/stores/consoles')
const { useConnections } = await import('@/stores/connections')
const { useTabs } = await import('@/stores/tabs')
const { useUi } = await import('@/stores/ui')

const connection = (id: string): ConnectionConfig =>
  ({ id, name: id === 'pg' ? 'Local PG' : id, dialect: 'postgres', host: 'h', port: 5432 }) as ConnectionConfig

function runtime(patch: { running?: boolean; transaction?: boolean; session?: boolean }) {
  return {
    ...useConsoles.getState().runtime('none'),
    sessionId: patch.session === false ? undefined : 's1',
    status: patch.running ? ('running' as const) : ('idle' as const),
    transaction: { autoCommit: !patch.transaction, inTransaction: Boolean(patch.transaction) },
  }
}

/** Answer the confirmation currently shown by DialogHost. */
function answer(value: boolean): string {
  const dialog = useUi.getState().dialogs[0]
  if (!dialog || dialog.type !== 'confirm') throw new Error('no confirmation shown')
  dialog.resolve(value)
  useUi.getState().dismissDialog(dialog.id)
  return dialog.options.title
}

beforeEach(() => {
  useTabs.setState({ tabs: [], activeTabId: null, hydrated: false })
  useConsoles.setState({ runtimes: {} })
  useUi.setState({ dialogs: [] })
  useConnections.setState({ connections: [connection('pg'), connection('ms')], runtime: { pg: { status: 'connected' } } })
  disconnectApi.mockClear()
  toastMessage.mockClear()
})

describe('console work', () => {
  it('lists consoles of a connection holding a transaction or a running statement', () => {
    const a = useTabs.getState().openConsole({ connectionId: 'pg', title: 'Query 1' })
    const b = useTabs.getState().openConsole({ connectionId: 'pg', title: 'Query 2' })
    const c = useTabs.getState().openConsole({ connectionId: 'ms', title: 'Query 3' })
    const d = useTabs.getState().openConsole({ connectionId: 'pg', title: 'Query 4' })
    useConsoles.setState({ runtimes: { [a]: runtime({ transaction: true }), [b]: runtime({ running: true }), [c]: runtime({ transaction: true }), [d]: runtime({}) } })
    const work = consoleWork(useTabs.getState().tabs, useConsoles.getState().runtimes, 'pg')
    expect(work.map((w) => w.tab.title)).toEqual(['Query 1', 'Query 2'])
    expect(describeWork(work)).toBe('Uncommitted changes in “Query 1” are rolled back. The statement running in “Query 2” is cancelled.')
  })

  it('formats lists of titles', () => {
    expect(listTitles(['A'])).toBe('“A”')
    expect(listTitles(['A', 'B'])).toBe('“A” and “B”')
    expect(listTitles(['A', 'B', 'C', 'D', 'E'])).toBe('“A”, “B” and 3 more')
  })
})

describe('disconnect', () => {
  it('asks before rolling back an open transaction, and keeps the connection when refused', async () => {
    const a = useTabs.getState().openConsole({ connectionId: 'pg', title: 'Query 1' })
    useConsoles.setState({ runtimes: { [a]: runtime({ transaction: true }) } })
    const pending = disconnect('pg')
    await Promise.resolve()
    expect(answer(false)).toBe('Disconnect “Local PG” and roll back 1 open transaction?')
    await pending
    expect(disconnectApi).not.toHaveBeenCalled()

    const again = disconnect('pg')
    await Promise.resolve()
    answer(true)
    await again
    expect(disconnectApi).toHaveBeenCalledWith('pg')
  })

  it('disconnects at once when nothing would be lost', async () => {
    useTabs.getState().openConsole({ connectionId: 'pg', title: 'Idle' })
    await expect(confirmDisconnect('pg')).resolves.toBe(true)
    await disconnect('pg')
    expect(useUi.getState().dialogs).toHaveLength(0)
    expect(disconnectApi).toHaveBeenCalledTimes(1)
  })
})

describe('closing a console', () => {
  it('asks before cancelling a running statement', async () => {
    const off = bindConsoleGuards()
    const a = useTabs.getState().openConsole({ connectionId: 'pg', title: 'Query 1', content: 'select pg_sleep(9)' })
    useConsoles.setState({ runtimes: { [a]: runtime({ running: true }) } })
    const closing = useTabs.getState().closeTab(a)
    await Promise.resolve()
    expect(answer(false)).toBe('Close “Query 1” and cancel its running statement?')
    await closing
    expect(useTabs.getState().tabs).toHaveLength(1)
    off()
  })

  it('leaves an open transaction to the console’s own close dialog', async () => {
    const a = useTabs.getState().openConsole({ connectionId: 'pg', title: 'Query 1' })
    useConsoles.setState({ runtimes: { [a]: runtime({ transaction: true, running: true }) } })
    const tab = useTabs.getState().tabs[0]!
    if (tab.kind !== 'console') throw new Error('console expected')
    await expect(confirmCloseConsole(tab)).resolves.toBe(true)
    expect(useUi.getState().dialogs).toHaveLength(0)
  })

  it('asks before discarding unsaved edits of a .sql file', async () => {
    const a = useTabs.getState().openConsole({ connectionId: 'pg', title: 'report.sql', content: 'select 1', filePath: '/tmp/report.sql' })
    let tab = useTabs.getState().tabs[0]!
    if (tab.kind !== 'console') throw new Error('console expected')
    expect(hasUnsavedFile(tab)).toBe(false)
    useTabs.getState().updateConsole(a, { content: 'select 2' })
    tab = useTabs.getState().tabs[0]!
    if (tab.kind !== 'console') throw new Error('console expected')
    expect(hasUnsavedFile(tab)).toBe(true)
    const pending = confirmCloseConsole(tab)
    expect(answer(true)).toBe('Close “report.sql” and discard unsaved changes?')
    await expect(pending).resolves.toBe(true)
    // Saving records the file content again.
    useTabs.getState().updateConsole(a, { filePath: '/tmp/report.sql', content: 'select 2' })
    tab = useTabs.getState().tabs[0]!
    expect(tab.kind === 'console' && hasUnsavedFile(tab)).toBe(false)
  })

  it('offers to undo closing consoles that held a script', async () => {
    vi.useFakeTimers()
    const off = bindConsoleGuards()
    useTabs.getState().openConsole({ connectionId: 'pg', title: 'Keep', content: '' })
    const b = useTabs.getState().openConsole({ connectionId: 'pg', title: 'Script', content: 'select 42' })
    useTabs.getState().openConsole({ connectionId: 'pg', title: 'Last', content: '' })
    await useTabs.getState().closeTab(b)
    vi.runAllTimers()
    expect(toastMessage).toHaveBeenCalledTimes(1)
    const [title, options] = toastMessage.mock.calls[0] as [string, { action: { onClick: () => void } }]
    expect(title).toBe('Closed “Script”')
    options.action.onClick()
    expect(useTabs.getState().tabs.map((t) => t.title)).toEqual(['Keep', 'Script', 'Last'])
    expect(useTabs.getState().tabs[1]).toMatchObject({ kind: 'console', content: 'select 42' })
    // An empty console closes without a toast.
    await useTabs.getState().closeTab(useTabs.getState().tabs[0]!.id)
    vi.runAllTimers()
    expect(toastMessage).toHaveBeenCalledTimes(1)
    off()
    vi.useRealTimers()
  })
})
