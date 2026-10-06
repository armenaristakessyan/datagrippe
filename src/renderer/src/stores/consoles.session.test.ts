// Console session lifecycle: races between opening a session and retargeting the console, the desired
// commit mode across lost sessions, closing a console with an open transaction, cancel while connecting,
// query parameters and explain. Mocked api (no database).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionConfig, ExecutionResult, ExplainResult, SessionInfo, StatementResult, TransactionState } from '@shared/types'

const session = {
  open: vi.fn(),
  close: vi.fn(),
  execute: vi.fn(),
  setSchema: vi.fn(),
  setDatabase: vi.fn(),
  setAutoCommit: vi.fn(),
  explain: vi.fn(),
  cancel: vi.fn(),
  commit: vi.fn(),
  rollback: vi.fn(),
  fetchMore: vi.fn(),
}
const completionCatalog = vi.fn()
const listeners = new Map<string, ((payload: unknown) => void)[]>()

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
      session,
      meta: { completionCatalog, objects: vi.fn(async () => []), schemas: vi.fn(async () => []) },
      workspace: { save: vi.fn(async () => undefined), load: vi.fn() },
    },
    errorInfo: (e: unknown) => (e instanceof ApiError ? e.info : { message: e instanceof Error ? e.message : String(e), kind: 'internal' }),
    errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
    onEvent: (event: string, listener: (payload: unknown) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return () => undefined
    },
  }
})

const { bindConsoleEvents, registerConsolePromptHost, useConsoles, wantsManualCommit, executionEffects } = await import('./consoles')
const { useConnections } = await import('./connections')
const { useTabs } = await import('./tabs')
const { useCatalog } = await import('./catalog')
const { useExplorer } = await import('./explorer')
const { useSettings } = await import('./settings')
const { useUi } = await import('./ui')
bindConsoleEvents()

const emit = (event: string, payload: unknown) => listeners.get(event)?.forEach((l) => l(payload))
const flush = () => new Promise((r) => setTimeout(r, 0))

function connection(over: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: 'c1',
    name: 'Dev',
    dialect: 'postgres',
    host: 'dev.local',
    port: 5432,
    database: 'shop',
    user: 'me',
    savePassword: true,
    hasPassword: true,
    ssl: { mode: 'disable' },
    ssh: { enabled: false, host: '', port: 22, username: '', authMethod: 'password' },
    color: 'none',
    readOnly: false,
    productionGuard: false,
    options: {},
    createdAt: '',
    updatedAt: '',
    ...over,
  }
}

function result(over: Partial<StatementResult> = {}): StatementResult {
  return { index: 0, sql: 'SELECT 1', offset: 0, kind: 'rows', columns: [], rows: [], rowCount: 0, hasMore: false, durationMs: 1, ...over }
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

const info = (sessionId: string, connectionId: string, database: string, transaction: TransactionState = { autoCommit: true, inTransaction: false }): SessionInfo => ({
  sessionId,
  connectionId,
  database,
  transaction,
})

/** Server-side transaction state per session (what the driver reports). */
const server = new Map<string, TransactionState>()
let sessions = 0

let tabId = ''

beforeEach(() => {
  vi.clearAllMocks()
  server.clear()
  sessions = 0
  useConsoles.setState({ runtimes: {}, prompts: {} })
  useCatalog.setState({ catalogs: {} })
  useUi.setState({ dialogs: [] })
  useSettings.setState({ settings: { ...useSettings.getState().settings, confirmDestructive: true } })
  useConnections.setState({
    connections: [connection(), connection({ id: 'c2', name: 'Production', host: 'prod.local' }), connection({ id: 'ms', name: 'MS', dialect: 'mssql' })],
    runtime: { c1: { status: 'connected' }, c2: { status: 'connected' }, ms: { status: 'connected' } },
    loaded: true,
  })
  useTabs.setState({ tabs: [], activeTabId: null, hydrated: false, layout: {} })
  tabId = useTabs.getState().openConsole({ connectionId: 'c1' })
  completionCatalog.mockResolvedValue({ database: 'shop', defaultSchema: 'public', schemas: [] })
  session.open.mockImplementation(async ({ connectionId, database }: { connectionId: string; database?: string }) => {
    const id = `s${++sessions}`
    server.set(id, { autoCommit: true, inTransaction: false })
    return info(id, connectionId, database ?? 'shop', server.get(id))
  })
  session.close.mockResolvedValue(undefined)
  session.setAutoCommit.mockImplementation(async (id: string, autoCommit: boolean) => {
    server.set(id, { autoCommit, inTransaction: false })
    return server.get(id)
  })
  session.setDatabase.mockImplementation(async (id: string, database: string) => info(id, 'c1', database, server.get(id)))
  session.commit.mockImplementation(async (id: string) => {
    server.set(id, { autoCommit: server.get(id)!.autoCommit, inTransaction: false })
    return server.get(id)
  })
  session.rollback.mockImplementation(async (id: string) => {
    server.set(id, { autoCommit: server.get(id)!.autoCommit, inTransaction: false })
    return server.get(id)
  })
  session.execute.mockImplementation(async (id: string, sql: string): Promise<ExecutionResult> => {
    const state = server.get(id) ?? { autoCommit: true, inTransaction: false }
    const next = { autoCommit: state.autoCommit, inTransaction: !state.autoCommit }
    server.set(id, next)
    return { executionId: `x-${sql}`, sessionId: id, results: [result({ sql, kind: 'command', command: 'INSERT' })], messages: [], durationMs: 1, cancelled: false, transaction: next }
  })
})

describe('retargeting a console while its session opens', () => {
  it('a connection switch drops the stale session and does not run the statement', async () => {
    const opening = deferred<SessionInfo>()
    session.open.mockImplementationOnce(() => opening.promise)
    const run = useConsoles.getState().execute(tabId, 'DELETE FROM orders WHERE id = 1')
    await flush()
    await useConsoles.getState().switchConnection(tabId, 'c2')
    await run
    opening.resolve(info('s-old', 'c1', 'shop'))
    await flush()
    expect(session.close).toHaveBeenCalledWith('s-old')
    expect(session.execute).not.toHaveBeenCalled()
    expect(useConsoles.getState().runtime(tabId).sessionId).toBeUndefined()
    // The next run opens a session on the connection the toolbar shows.
    await useConsoles.getState().execute(tabId, 'SELECT 1')
    expect(session.open).toHaveBeenLastCalledWith({ connectionId: 'c2', database: 'shop' })
  })

  it('a database picked while opening is applied to the new session; the pending run is skipped', async () => {
    useTabs.setState({ tabs: [], activeTabId: null })
    tabId = useTabs.getState().openConsole({ connectionId: 'c1', database: 'shop' })
    const opening = deferred<SessionInfo>()
    session.open.mockImplementationOnce(() => opening.promise)
    const run = useConsoles.getState().execute(tabId, 'SELECT 1')
    await flush()
    await useConsoles.getState().setDatabase(tabId, 'reporting')
    opening.resolve(info('s1', 'c1', 'shop'))
    await run
    expect(session.setDatabase).toHaveBeenCalledWith('s1', 'reporting')
    expect(useTabs.getState().tabs[0]).toMatchObject({ database: 'reporting' })
    expect(useConsoles.getState().runtime(tabId).sessionId).toBe('s1')
    expect(session.execute).not.toHaveBeenCalled()
  })

  it('a session that fails after opening is closed, not leaked', async () => {
    useTabs.setState({ tabs: [], activeTabId: null })
    tabId = useTabs.getState().openConsole({ connectionId: 'c1', schema: 'nope' })
    session.setSchema.mockRejectedValueOnce(new Error('schema "nope" does not exist'))
    await useConsoles.getState().execute(tabId, 'SELECT 1')
    expect(session.close).toHaveBeenCalledWith('s1')
    expect(useConsoles.getState().runtime(tabId).error?.message).toContain('does not exist')
  })
})

describe('cancel while connecting', () => {
  it('gives up at once and closes the session if it opens later', async () => {
    const connected = deferred<boolean>()
    const original = useConnections.getState().ensureConnected
    useConnections.setState({ ensureConnected: () => connected.promise })
    try {
      const run = useConsoles.getState().execute(tabId, 'SELECT 1')
      await flush()
      expect(useConsoles.getState().runtime(tabId).status).toBe('connecting')
      await useConsoles.getState().cancel(tabId)
      await run
      expect(useConsoles.getState().runtime(tabId).status).toBe('idle')
      connected.resolve(true)
      await flush()
      expect(session.open).not.toHaveBeenCalled()
      expect(session.execute).not.toHaveBeenCalled()
    } finally {
      useConnections.setState({ ensureConnected: original })
    }
  })
})

describe('closing a tab mid-query', () => {
  it('drops the late result instead of re-creating the runtime', async () => {
    const running = deferred<ExecutionResult>()
    session.execute.mockReturnValueOnce(running.promise)
    const run = useConsoles.getState().execute(tabId, 'SELECT * FROM big')
    await flush()
    await useTabs.getState().closeTab(tabId)
    running.resolve({ executionId: 'x', sessionId: 's1', results: [result({ rows: [[1]], rowCount: 1 })], messages: [], durationMs: 1, cancelled: false, transaction: { autoCommit: true, inTransaction: false } })
    await run
    expect(useConsoles.getState().runtimes[tabId]).toBeUndefined()
  })
})

describe('manual-commit mode', () => {
  it('survives a lost session: the next session is put back in manual mode', async () => {
    await useConsoles.getState().setAutoCommit(tabId, false)
    await useConsoles.getState().execute(tabId, 'insert 1')
    emit('event:sessionClosed', { sessionId: 's1', connectionId: 'c1', reason: 'terminating connection due to administrator command' })
    const runtime = useConsoles.getState().runtime(tabId)
    expect(runtime.transaction.autoCommit).toBe(false)
    expect(runtime.error?.message).toMatch(/rolled back/)
    expect(runtime.error?.detail).toMatch(/uncommitted changes were lost/i)
    expect(runtime.error?.detail).toMatch(/administrator command/)
    expect(runtime.error?.hint).toBe('Run a statement again to open a new session.')

    await useConsoles.getState().execute(tabId, 'insert 2')
    expect(session.execute).toHaveBeenLastCalledWith('s2', 'insert 2', expect.anything())
    expect(server.get('s2')).toEqual({ autoCommit: false, inTransaction: true })
  })

  it('survives a disconnect of the connection', async () => {
    await useConsoles.getState().setAutoCommit(tabId, false)
    await useConsoles.getState().execute(tabId, 'insert 1')
    emit('event:connectionClosed', { connectionId: 'c1' })
    expect(useConsoles.getState().runtime(tabId).error?.message).toMatch(/rolled back/)
    await useConsoles.getState().execute(tabId, 'insert 2')
    expect(server.get('s2')?.autoCommit).toBe(false)
  })

  it('is persisted with the workspace layout and forgotten when the tab closes', async () => {
    await useConsoles.getState().setAutoCommit(tabId, false)
    expect(wantsManualCommit(tabId)).toBe(true)
    expect(useTabs.getState().layout['console.manualCommit']).toEqual([tabId])
    await useConsoles.getState().setAutoCommit(tabId, true)
    await useConsoles.getState().setAutoCommit(tabId, false)
    // a restarted app (no session yet) opens the console's session in manual mode
    useConsoles.setState({ runtimes: {} })
    await useConsoles.getState().ensureSession(tabId)
    expect(useConsoles.getState().runtime(tabId).transaction.autoCommit).toBe(false)
    useConsoles.setState({ runtimes: {} })
    await useTabs.getState().closeTab(tabId)
    expect(wantsManualCommit(tabId)).toBe(false)
  })
})

describe('closing a console with an open transaction', () => {
  async function pending() {
    await useConsoles.getState().setAutoCommit(tabId, false)
    await useConsoles.getState().execute(tabId, 'insert 1')
    expect(useConsoles.getState().runtime(tabId).transaction.inTransaction).toBe(true)
  }

  it('asks Commit / Roll back / Cancel in the console; Cancel keeps the tab', async () => {
    const unhost = registerConsolePromptHost(tabId)
    try {
      await pending()
      const closing = useTabs.getState().closeTab(tabId)
      await flush()
      const prompt = useConsoles.getState().prompts[tabId]
      expect(prompt?.kind).toBe('close-transaction')
      if (prompt?.kind === 'close-transaction') prompt.resolve('cancel')
      await closing
      expect(useTabs.getState().tabs.some((t) => t.id === tabId)).toBe(true)
      expect(session.close).not.toHaveBeenCalled()
    } finally {
      unhost()
    }
  })

  it('Commit commits before the tab closes', async () => {
    const unhost = registerConsolePromptHost(tabId)
    try {
      await pending()
      const closing = useTabs.getState().closeTab(tabId)
      await flush()
      const prompt = useConsoles.getState().prompts[tabId]
      if (prompt?.kind === 'close-transaction') prompt.resolve('commit')
      await closing
      expect(session.commit).toHaveBeenCalledWith('s1')
      expect(useTabs.getState().tabs.some((t) => t.id === tabId)).toBe(false)
      expect(session.close).toHaveBeenCalledWith('s1')
    } finally {
      unhost()
    }
  })

  it('without a console view, falls back to a roll-back confirmation', async () => {
    await pending()
    const closing = useTabs.getState().closeTab(tabId)
    await flush()
    const dialog = useUi.getState().dialogs.find((d) => d.type === 'confirm')
    expect(dialog).toBeDefined()
    if (dialog?.type === 'confirm') dialog.resolve(true)
    await closing
    expect(session.rollback).toHaveBeenCalledWith('s1')
    expect(useTabs.getState().tabs.some((t) => t.id === tabId)).toBe(false)
  })

  it('closes at once when nothing is pending', async () => {
    await useConsoles.getState().execute(tabId, 'insert 1')
    await useTabs.getState().closeTab(tabId)
    expect(useTabs.getState().tabs).toHaveLength(0)
    expect(useUi.getState().dialogs).toHaveLength(0)
  })
})

describe('production guard', () => {
  it('does not offer “Run anyway” on a read-only connection (main blocks the write)', async () => {
    useConnections.setState({
      connections: [connection({ readOnly: true, productionGuard: true })],
    })
    void useConsoles.getState().execute(tabId, 'delete from t')
    await flush()
    expect(useUi.getState().dialogs).toHaveLength(0)
  })

  it('still asks on a writable production connection', async () => {
    useConnections.setState({ connections: [connection({ productionGuard: true })] })
    void useConsoles.getState().execute(tabId, 'delete from t')
    await flush()
    expect(useUi.getState().dialogs.filter((d) => d.type === 'confirm')).toHaveLength(1)
  })
})

describe('query parameters', () => {
  it('asks for values, substitutes them and remembers them for the console', async () => {
    const unhost = registerConsolePromptHost(tabId)
    try {
      const run = useConsoles.getState().execute(tabId, 'select * from customers where id = :id and name = :name')
      await flush()
      const prompt = useConsoles.getState().prompts[tabId]
      expect(prompt?.kind).toBe('parameters')
      if (prompt?.kind !== 'parameters') return
      expect(prompt.parameters.map((p) => p.label)).toEqual([':id', ':name'])
      prompt.resolve({ ':id': { mode: 'value', text: '42' }, ':name': { mode: 'value', text: "O'Brien" } })
      await run
      expect(session.execute).toHaveBeenCalledWith('s1', "select * from customers where id = 42 and name = 'O''Brien'", expect.anything())

      const again = useConsoles.getState().execute(tabId, 'select :id')
      await flush()
      const second = useConsoles.getState().prompts[tabId]
      expect(second?.kind === 'parameters' && second.initial[':id']).toEqual({ mode: 'value', text: '42' })
      if (second?.kind === 'parameters') second.resolve(null)
      await again
      expect(session.execute).toHaveBeenCalledTimes(1)
    } finally {
      unhost()
    }
  })

  it('"Run as written" sends the SQL unchanged', async () => {
    const unhost = registerConsolePromptHost(tabId)
    try {
      const run = useConsoles.getState().execute(tabId, 'select :x')
      await flush()
      const prompt = useConsoles.getState().prompts[tabId]
      if (prompt?.kind === 'parameters') prompt.resolve('as-is')
      await run
      expect(session.execute).toHaveBeenCalledWith('s1', 'select :x', expect.anything())
    } finally {
      unhost()
    }
  })
})

describe('explain', () => {
  const plan: ExplainResult = { format: 'postgres-json', raw: '[]', root: null }

  it('records the explained statement and replaces the previous results; a later run drops the plan', async () => {
    session.explain.mockResolvedValue(plan)
    await useConsoles.getState().execute(tabId, 'select 1')
    await useConsoles.getState().explain(tabId, ' select * from t join u on true ', false)
    let runtime = useConsoles.getState().runtime(tabId)
    expect(runtime).toMatchObject({ explain: plan, explainSql: 'select * from t join u on true', resultView: 'explain', execution: undefined })

    await useConsoles.getState().execute(tabId, 'select 2')
    runtime = useConsoles.getState().runtime(tabId)
    expect(runtime.explain).toBeUndefined()
    expect(runtime.explainSql).toBeUndefined()
    expect(runtime.resultView).toBe('results')
  })
})

describe('DDL in a console', () => {
  it('refreshes the explorer listings of the database, not only the completion catalog', async () => {
    const refresh = vi.spyOn(useExplorer.getState(), 'refresh').mockResolvedValue(undefined)
    useExplorer.setState({ refresh })
    session.execute.mockResolvedValueOnce({
      executionId: 'x', sessionId: 's1', results: [result({ sql: 'create table t (id int)', kind: 'command', command: 'CREATE TABLE' })], messages: [], durationMs: 1, cancelled: false, transaction: { autoCommit: true, inTransaction: false },
    })
    await useConsoles.getState().execute(tabId, 'create table t (id int)')
    expect(refresh).toHaveBeenCalledWith('c1', 'shop')
    expect(completionCatalog).toHaveBeenCalledWith('c1', 'shop')
  })
})

describe('execution effects', () => {
  const exec = (sql: string, command = 'SELECT', kind: StatementResult['kind'] = 'rows'): ExecutionResult => ({
    executionId: 'x', sessionId: 's', results: [result({ sql, command, kind })], messages: [], durationMs: 1, cancelled: false, transaction: { autoCommit: true, inTransaction: false },
  })

  it('SQL Server: follows the last USE of a batch', () => {
    expect(executionEffects(exec('USE master\nSELECT DB_NAME() AS db'), 'mssql').database).toBe('master')
    expect(executionEffects(exec('USE [a];\nUSE [b]]c]; SELECT 1'), 'mssql').database).toBe('b]c')
    expect(executionEffects(exec("SELECT 'USE x' AS s -- USE y"), 'mssql').database).toBeUndefined()
    expect(executionEffects(exec('USE master'), 'postgres').database).toBeUndefined()
  })

  it('detects DDL anywhere in a batch and SELECT … INTO', () => {
    expect(executionEffects(exec('SELECT 1 AS before_ddl\nCREATE TABLE dbo.t (id int)'), 'mssql').schemaChanged).toBe(true)
    expect(executionEffects(exec('SELECT * INTO archive_orders FROM orders', 'SELECT', 'command'), 'postgres').schemaChanged).toBe(true)
    expect(executionEffects(exec('SELECT * INTO #tmp FROM orders', 'SELECT', 'command'), 'mssql').schemaChanged).toBe(true)
    expect(executionEffects(exec("COMMENT ON TABLE t IS 'x'", 'COMMENT', 'command'), 'postgres').schemaChanged).toBe(true)
  })

  it('does not flag plain queries, INSERT INTO, variables or text that merely mentions DDL', () => {
    expect(executionEffects(exec('INSERT INTO t SELECT * FROM u', 'INSERT', 'command'), 'postgres').schemaChanged).toBe(false)
    expect(executionEffects(exec('SELECT @x = id FROM t; FETCH NEXT FROM c INTO @y', 'SELECT'), 'mssql').schemaChanged).toBe(false)
    expect(executionEffects(exec("SELECT 'drop table x' AS s"), 'postgres').schemaChanged).toBe(false)
    expect(executionEffects(exec('SELECT (SELECT 1 INTO x)'), 'postgres').schemaChanged).toBe(false)
  })
})

describe('live server messages', () => {
  it('shows notices of the running script, then the final result replaces them', async () => {
    const gate = deferred<ExecutionResult>()
    session.execute.mockImplementationOnce(async () => gate.promise)
    const run = useConsoles.getState().execute(tabId, "DO $$ BEGIN RAISE NOTICE 'step 1'; END $$")
    await flush()
    await flush()
    const { sessionId } = useConsoles.getState().runtime(tabId)
    expect(useConsoles.getState().runtime(tabId).status).toBe('running')
    emit('event:sessionMessages', { sessionId, messages: [{ level: 'notice', text: 'step 1', at: 1 }] })
    emit('event:sessionMessages', { sessionId: 'other', messages: [{ level: 'notice', text: 'not mine', at: 2 }] })
    expect(useConsoles.getState().runtime(tabId).liveMessages?.map((m) => m.text)).toEqual(['step 1'])
    gate.resolve({
      executionId: 'x1',
      sessionId: sessionId!,
      results: [result({ kind: 'command', command: 'DO' })],
      messages: [{ level: 'notice', text: 'step 1', at: 1 }],
      durationMs: 1,
      cancelled: false,
      transaction: { autoCommit: true, inTransaction: false },
    })
    await run
    expect(useConsoles.getState().runtime(tabId).liveMessages).toBeUndefined()
    expect(useConsoles.getState().runtime(tabId).execution?.messages).toHaveLength(1)
  })
})

describe('fetching more rows after the cursor is gone', () => {
  it('stops offering more rows (hasMore off, cursor dropped)', async () => {
    session.execute.mockImplementationOnce(async (id: string) => ({
      executionId: 'x-rows',
      sessionId: id,
      results: [result({ rows: [[1]], rowCount: 1, hasMore: true, cursorId: 'cur' })],
      messages: [],
      durationMs: 1,
      cancelled: false,
      transaction: { autoCommit: true, inTransaction: false },
    }))
    await useConsoles.getState().execute(tabId, 'SELECT 1')
    const { ApiError } = await import('@/lib/api')
    session.fetchMore.mockRejectedValueOnce(new ApiError({ message: 'This result is no longer available', kind: 'not-found' }))
    await useConsoles.getState().fetchMore(tabId, 0)
    const shown = useConsoles.getState().runtime(tabId).execution!.results[0]!
    expect(shown.hasMore).toBe(false)
    expect(shown.cursorId).toBeUndefined()
    expect(useConsoles.getState().runtime(tabId).error?.kind).toBe('not-found')
  })
})

describe('switching database', () => {
  it('passes the user’s consent to discard the open transaction on to main', async () => {
    await useConsoles.getState().ensureSession(tabId)
    await useConsoles.getState().setDatabase(tabId, 'other', { discardTransaction: true })
    expect(session.setDatabase).toHaveBeenLastCalledWith(expect.any(String), 'other', { discardTransaction: true })
  })
})
