import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionConfig, ExecutionResult, StatementResult } from '@shared/types'

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
    api: { session, meta: { completionCatalog }, workspace: { save: vi.fn(async () => undefined), load: vi.fn() } },
    errorInfo: (e: unknown) => (e instanceof ApiError ? e.info : { message: e instanceof Error ? e.message : String(e), kind: 'internal' }),
    errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
    onEvent: () => () => undefined,
  }
})

const { executionEffects, usedDatabase, useConsoles } = await import('./consoles')
const { useConnections } = await import('./connections')
const { useTabs } = await import('./tabs')
const { useCatalog } = await import('./catalog')
const originalEnsureConnected = useConnections.getState().ensureConnected

function connection(over: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: 'c1',
    name: 'Local',
    dialect: 'postgres',
    host: 'localhost',
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

function result(over: Partial<StatementResult>): StatementResult {
  return { index: 0, sql: 'SELECT 1', offset: 0, kind: 'rows', columns: [], rows: [], rowCount: 0, hasMore: false, durationMs: 1, ...over }
}

function execution(results: StatementResult[]): ExecutionResult {
  return { executionId: 'x', sessionId: 's1', results, messages: [], durationMs: 1, cancelled: false, transaction: { autoCommit: true, inTransaction: false } }
}

let tabId = ''

beforeEach(() => {
  vi.clearAllMocks()
  useConsoles.setState({ runtimes: {} })
  useCatalog.setState({ catalogs: {} })
  useConnections.setState({ connections: [connection()], runtime: { c1: { status: 'connected' } }, loaded: true, ensureConnected: originalEnsureConnected })
  useTabs.setState({ tabs: [], activeTabId: null, hydrated: false })
  tabId = useTabs.getState().openConsole({ connectionId: 'c1' })
  session.open.mockResolvedValue({ sessionId: 's1', connectionId: 'c1', database: 'shop', transaction: { autoCommit: true, inTransaction: false } })
  completionCatalog.mockResolvedValue({ database: 'shop', defaultSchema: 'public', schemas: [] })
  session.close.mockResolvedValue(undefined)
})

describe('execute', () => {
  it('opens the session lazily, once, and records the execution', async () => {
    session.execute.mockResolvedValue(execution([result({})]))
    await useConsoles.getState().execute(tabId, 'SELECT 1', 4)
    await useConsoles.getState().execute(tabId, 'SELECT 1', 4)
    expect(session.open).toHaveBeenCalledTimes(1)
    expect(session.open).toHaveBeenCalledWith({ connectionId: 'c1', database: 'shop' })
    const runtime = useConsoles.getState().runtime(tabId)
    expect(runtime).toMatchObject({ sessionId: 's1', status: 'idle', executionOffset: 4 })
    expect(useTabs.getState().tabs[0]).toMatchObject({ database: 'shop' })
  })

  it('ignores a second trigger while the first is in flight', async () => {
    let resolve: (value: ExecutionResult) => void = () => undefined
    session.execute.mockReturnValue(new Promise<ExecutionResult>((r) => (resolve = r)))
    const first = useConsoles.getState().execute(tabId, 'SELECT 1')
    const second = useConsoles.getState().execute(tabId, 'SELECT 1')
    await second
    resolve(execution([result({})]))
    await first
    expect(session.execute).toHaveBeenCalledTimes(1)
  })

  it('surfaces connection failures as the session error', async () => {
    useConnections.setState({ runtime: {} })
    const ensure = vi.spyOn(useConnections.getState(), 'ensureConnected').mockImplementation(async () => {
      useConnections.setState({ runtime: { c1: { status: 'error', error: 'ECONNREFUSED 127.0.0.1:5432' } } })
      return false
    })
    useConnections.setState({ ensureConnected: ensure })
    await useConsoles.getState().execute(tabId, 'SELECT 1')
    expect(session.execute).not.toHaveBeenCalled()
    expect(useConsoles.getState().runtime(tabId).error).toMatchObject({ message: 'Could not connect', detail: 'ECONNREFUSED 127.0.0.1:5432', kind: 'connection' })
  })

  it('keeps execution failures and drops a lost session', async () => {
    const { ApiError } = await import('@/lib/api')
    session.execute.mockRejectedValue(new ApiError({ message: 'Session not found', kind: 'not-found' }))
    await useConsoles.getState().execute(tabId, 'SELECT 1')
    const runtime = useConsoles.getState().runtime(tabId)
    expect(runtime.error?.message).toBe('Session not found')
    expect(runtime.sessionId).toBeUndefined()
    useConsoles.getState().dismissError(tabId)
    expect(useConsoles.getState().runtime(tabId).error).toBeUndefined()
  })

  it('follows USE on SQL Server and refreshes the catalog after DDL', async () => {
    useConnections.setState({ connections: [connection({ dialect: 'mssql' })] })
    session.execute.mockResolvedValue(execution([result({ sql: 'USE [reporting]', kind: 'command', command: 'USE' })]))
    await useConsoles.getState().execute(tabId, 'USE [reporting]')
    expect(useTabs.getState().tabs[0]).toMatchObject({ database: 'reporting' })
    expect(completionCatalog).toHaveBeenLastCalledWith('c1', 'reporting')

    session.execute.mockResolvedValue(execution([result({ sql: 'CREATE TABLE t (id int)', kind: 'command', command: 'CREATE TABLE' })]))
    await useConsoles.getState().execute(tabId, 'CREATE TABLE t (id int)')
    expect(completionCatalog).toHaveBeenCalledTimes(2)
  })
})

describe('session context', () => {
  it('switching connection closes the session and resets database / schema', async () => {
    session.execute.mockResolvedValue(execution([result({})]))
    await useConsoles.getState().execute(tabId, 'SELECT 1')
    useConnections.setState({ connections: [connection(), connection({ id: 'c2', dialect: 'mssql' })] })
    await useConsoles.getState().switchConnection(tabId, 'c2')
    expect(session.close).toHaveBeenCalledWith('s1')
    expect(useTabs.getState().tabs[0]).toMatchObject({ connectionId: 'c2', database: undefined, schema: undefined })
    expect(useConsoles.getState().runtime(tabId).sessionId).toBeUndefined()
  })

  it('reverts the tab when the server refuses a database switch', async () => {
    session.execute.mockResolvedValue(execution([result({})]))
    await useConsoles.getState().execute(tabId, 'SELECT 1')
    session.setDatabase.mockRejectedValue(new Error('database "nope" does not exist'))
    await useConsoles.getState().setDatabase(tabId, 'nope')
    expect(useTabs.getState().tabs[0]).toMatchObject({ database: 'shop' })
    expect(useConsoles.getState().runtime(tabId).error?.message).toContain('does not exist')
  })
})

describe('helpers', () => {
  it('parses USE statements', () => {
    expect(usedDatabase('USE sales')).toBe('sales')
    expect(usedDatabase('use [My DB];')).toBe('My DB')
    expect(usedDatabase('USE "x""y"')).toBe('x"y')
    expect(usedDatabase('SELECT 1')).toBeUndefined()
    expect(usedDatabase('USE a; SELECT 1')).toBeUndefined()
  })

  it('derives execution effects', () => {
    expect(executionEffects(execution([result({ sql: 'DROP VIEW v', kind: 'command', command: 'DROP VIEW' })]), 'postgres')).toEqual({ schemaChanged: true, database: undefined })
    expect(executionEffects(execution([result({ sql: 'USE x', kind: 'error' })]), 'mssql')).toEqual({ schemaChanged: false, database: undefined })
    expect(executionEffects(execution([result({ sql: 'USE x', kind: 'command' })]), 'postgres').database).toBeUndefined()
  })
})
