import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcEventName, IpcEvents } from '@shared/ipc'
import type { ConnectionInput, HistoryEntry, StatementResult, TransactionState } from '@shared/types'
import { ConnectionStore } from '../store/connections'
import { SecretStore } from '../store/secrets'
import { DriverError } from './errors'
import { SessionManager } from './session-manager'
import type { Tunnel } from './tunnel'
import type { DbDriver, DriverExecuteOptions, DriverExecuteResult, DriverSession, MetadataProvider, ResolvedConnection } from './types'

// Minimal stand-in for @shared/sql (implemented by another package) so these tests only exercise the manager.
vi.mock('@shared/sql', () => ({
  splitStatements: (sql: string) =>
    sql
      .split(';')
      .map((text) => text.trim())
      .filter(Boolean)
      .map((text) => ({ text, start: 0, end: text.length })),
  classifyStatement: (sql: string) => {
    const command = sql.trim().split(/\s+/)[0].toUpperCase()
    return { command, readOnly: ['SELECT', 'WITH', 'SHOW', 'EXPLAIN'].includes(command), destructive: false }
  },
}))

const silent = { warn: vi.fn(), error: vi.fn() }

class FakeSession implements DriverSession {
  readonly dialect = 'postgres' as const
  database: string
  schema: string | undefined = 'public'
  closed = false
  readOnlyCalls: boolean[] = []
  schemaCalls: string[] = []
  executed: string[] = []
  private listener: ((reason: string) => void) | null = null
  private tx: TransactionState = { autoCommit: true, inTransaction: false }
  constructor(
    database: string,
    private readonly behaviour: FakeBehaviour,
  ) {
    this.database = database
  }
  serverInfo = async () => serverInfo(this.database)
  async execute(sql: string, options: DriverExecuteOptions): Promise<DriverExecuteResult> {
    this.executed.push(sql)
    for (const text of this.behaviour.liveMessages ?? []) options.onMessage?.({ level: 'notice', text, at: 1 })
    if (this.behaviour.delayMs) await new Promise((r) => setTimeout(r, this.behaviour.delayMs))
    return this.behaviour.execute(sql)
  }
  /** Simulate a statement that opened a transaction. */
  begin() {
    this.tx = { ...this.tx, inTransaction: true }
  }
  fetchMore = vi.fn(async () => ({ rows: [[2]], hasMore: false }))
  cancel = vi.fn(async () => undefined)
  transactionState = () => this.tx
  setAutoCommit = vi.fn(async (autoCommit: boolean) => (this.tx = { autoCommit, inTransaction: false }))
  commit = async () => this.tx
  rollback = async () => this.tx
  async setSchema(schema: string) {
    this.schemaCalls.push(schema)
    this.schema = schema
  }
  useDatabase = async () => this.behaviour.useDatabaseInPlace
  explain = vi.fn(async () => ({ format: 'postgres-json' as const, raw: '[]', root: null }))
  async setReadOnly(readOnly: boolean) {
    this.readOnlyCalls.push(readOnly)
  }
  async close() {
    this.closed = true
  }
  onUnexpectedClose(listener: (reason: string) => void) {
    this.listener = listener
  }
  drop(reason: string) {
    this.listener?.(reason)
  }
}

interface FakeBehaviour {
  /** Password the fake server accepts (undefined = any). */
  password?: string
  useDatabaseInPlace: boolean
  execute: (sql: string) => DriverExecuteResult
  /** Messages reported through onMessage while executing. */
  liveMessages?: string[]
  /** Time execute takes after reporting its messages. */
  delayMs?: number
}

function serverInfo(database: string) {
  return { dialect: 'postgres' as const, version: 'PostgreSQL 16.4', versionShort: '16.4', currentDatabase: database, currentUser: 'me' }
}

function rowsResult(n: number, overrides: Partial<StatementResult> = {}): StatementResult {
  return {
    index: 0,
    sql: 'select',
    offset: 0,
    kind: 'rows',
    columns: [{ name: 'x', dataType: 'int4' }],
    rows: Array.from({ length: n }, (_, i) => [i]),
    rowCount: n,
    hasMore: false,
    command: 'SELECT',
    durationMs: 5,
    ...overrides,
  }
}

function makeDriver(behaviour: FakeBehaviour) {
  const sessions: FakeSession[] = []
  const metadata = {
    closed: 0,
    fetchReadOnly: [] as boolean[],
  }
  const checkAuth = (c: ResolvedConnection) => {
    if (behaviour.password !== undefined && c.secrets.password !== behaviour.password) {
      throw new DriverError({ kind: 'connection', code: '28P01', message: 'password authentication failed for user "me"' })
    }
  }
  const openMetadata = vi.fn(async (c: ResolvedConnection): Promise<MetadataProvider> => {
    await new Promise((r) => setTimeout(r, 5))
    checkAuth(c)
    return {
      serverInfo: async () => serverInfo(c.config.database),
      listDatabases: vi.fn(async (showSystem: boolean) => [{ name: showSystem ? 'sys' : 'app', isSystem: showSystem }]),
      listSchemas: async () => [],
      listObjects: async () => [],
      tableDetails: async () => {
        throw new Error('unused')
      },
      getDdl: async () => '',
      completionCatalog: async (database: string) => ({ database, defaultSchema: 'public', schemas: [] }),
      fetchTableData: async (_req, readOnly) => {
        metadata.fetchReadOnly.push(readOnly)
        return { columns: [], rows: [], offset: 0, hasMore: false, primaryKey: [], editable: !readOnly, sql: '', durationMs: 1 }
      },
      countTableData: async () => 0,
      previewChanges: async () => [],
      applyChanges: async () => ({ affected: 1, statements: [] }),
      close: async () => {
        metadata.closed++
      },
    }
  })
  const driver: DbDriver = {
    dialect: 'postgres',
    test: vi.fn(async (c: ResolvedConnection) => {
      checkAuth(c)
      return serverInfo(c.config.database)
    }),
    openMetadata,
    openSession: vi.fn(async (_c: ResolvedConnection, database: string) => {
      const s = new FakeSession(database, behaviour)
      sessions.push(s)
      return s
    }),
  }
  return { driver, sessions, metadata, openMetadata }
}

function connectionInput(overrides: Partial<ConnectionInput> = {}): ConnectionInput {
  return {
    name: 'Prod',
    dialect: 'postgres',
    host: 'db.example',
    port: 5432,
    database: 'app',
    user: 'me',
    savePassword: true,
    ssl: { mode: 'prefer' },
    ssh: { enabled: false, host: '', port: 22, username: '', authMethod: 'password' },
    color: 'none',
    readOnly: false,
    productionGuard: false,
    options: {},
    ...overrides,
  }
}

describe('SessionManager', () => {
  let dir: string
  let store: ConnectionStore
  let events: { event: IpcEventName; payload: unknown }[]
  let history: Omit<HistoryEntry, 'id'>[]
  let behaviour: FakeBehaviour
  let fake: ReturnType<typeof makeDriver>
  let tunnels: { closed: boolean; lose: (reason: string) => void }[]
  let manager: SessionManager
  let clock: number

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dg-sm-'))
    const crypto = {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from(s),
      decryptString: (b: Buffer) => b.toString(),
    }
    store = new ConnectionStore(dir, new SecretStore(dir, crypto, silent), { log: silent })
    events = []
    history = []
    tunnels = []
    clock = 1_000
    behaviour = { useDatabaseInPlace: false, execute: () => ({ results: [rowsResult(3)], messages: [], cancelled: false }) }
    fake = makeDriver(behaviour)
    manager = new SessionManager({
      connections: store,
      drivers: () => fake.driver,
      history: { add: (e) => history.push(e) },
      emit: <E extends IpcEventName>(event: E, payload: IpcEvents[E]) => events.push({ event, payload }),
      openTunnel: async (): Promise<Tunnel> => {
        let onClose: ((reason: string) => void) | null = null
        const t = {
          closed: false,
          lose: (reason: string) => onClose?.(reason),
        }
        tunnels.push(t)
        return {
          host: '127.0.0.1',
          port: 40000,
          close: async () => {
            t.closed = true
          },
          onClose: (l) => {
            onClose = l
          },
        }
      },
      now: () => clock,
      log: silent,
    })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  describe('connect', () => {
    it('asks for a password when none is available and the server rejects the login', async () => {
      behaviour.password = 'right'
      const c = store.save(connectionInput({ savePassword: false }))
      await expect(manager.connect(c.id)).rejects.toMatchObject({ info: { kind: 'needs-password' } })
      expect(manager.activeConnections()).toEqual([])

      const info = await manager.connect(c.id, { password: 'right' })
      expect(info.versionShort).toBe('16.4')
      expect(manager.activeConnections()).toEqual([c.id])
      // cached for this run, not persisted (savePassword=false)
      expect(store.secrets(c.id).password).toBe('right')
      expect(store.get(c.id)?.hasPassword).toBe(false)
    })

    it('reports a wrong provided password as a normal error', async () => {
      behaviour.password = 'right'
      const c = store.save(connectionInput())
      await expect(manager.connect(c.id, { password: 'wrong' })).rejects.toMatchObject({ info: { code: '28P01', kind: 'connection' } })
      expect(store.secrets(c.id).password).toBeUndefined()
    })

    it('drops a wrong cached password and asks again', async () => {
      behaviour.password = 'right'
      const c = store.save(connectionInput({ savePassword: false, secrets: { password: 'stale' } }))
      await expect(manager.connect(c.id)).rejects.toMatchObject({ info: { kind: 'needs-password' } })
      expect(store.secrets(c.id).password).toBeUndefined()
    })

    it('persists provided passwords when savePassword is on', async () => {
      const c = store.save(connectionInput())
      await manager.connect(c.id, { password: 'p' })
      expect(store.get(c.id)?.hasPassword).toBe(true)
    })

    it('is idempotent and shares concurrent attempts', async () => {
      const c = store.save(connectionInput())
      const [a, b] = await Promise.all([manager.connect(c.id), manager.connect(c.id)])
      await manager.connect(c.id)
      expect(a).toEqual(b)
      expect(fake.openMetadata).toHaveBeenCalledTimes(1)
    })

    it('opens an SSH tunnel and dials its local end', async () => {
      const c = store.save(
        connectionInput({ ssh: { enabled: true, host: 'bastion', port: 22, username: 'u', authMethod: 'agent' } }),
      )
      await manager.connect(c.id)
      const resolved = fake.openMetadata.mock.calls[0][0]
      expect(resolved).toMatchObject({ host: '127.0.0.1', port: 40000 })
      expect(tunnels).toHaveLength(1)
    })

    it('unknown connection is not-found', async () => {
      await expect(manager.connect('nope')).rejects.toMatchObject({ info: { kind: 'not-found' } })
    })
  })

  describe('sessions & execution', () => {
    it('opens sessions lazily, applying read-only and default schema', async () => {
      const c = store.save(connectionInput({ readOnly: true, options: { defaultSchema: 'sales' } }))
      const info = await manager.openSession({ connectionId: c.id })
      expect(info).toMatchObject({ connectionId: c.id, database: 'app', schema: 'sales' })
      expect(fake.sessions[0].readOnlyCalls).toEqual([true])
      expect(fake.sessions[0].schemaCalls).toEqual(['sales'])
      expect(manager.activeConnections()).toEqual([c.id])
    })

    it('blocks writes on read-only connections before sending anything', async () => {
      const c = store.save(connectionInput({ readOnly: true }))
      const { sessionId } = await manager.openSession({ connectionId: c.id })
      await expect(manager.execute(sessionId, 'select 1; update t set x = 1', { maxRows: 10 })).rejects.toMatchObject({
        info: { kind: 'read-only', message: '“Prod” is a read-only connection — UPDATE is blocked.' },
      })
      expect(fake.sessions[0].executed).toEqual([])
      const ok = await manager.execute(sessionId, 'select 1', { maxRows: 10 })
      expect(ok.results).toHaveLength(1)
      await expect(manager.applyChanges({ connectionId: c.id, database: 'app', schema: 'public', name: 't' }, [])).rejects.toMatchObject({
        info: { kind: 'read-only' },
      })
      await manager.fetchTableData({ table: { connectionId: c.id, database: 'app', schema: 'public', name: 't' }, offset: 0, limit: 10 })
      expect(fake.metadata.fetchReadOnly).toEqual([true])
      await expect(manager.explain(sessionId, 'delete from t', true)).rejects.toMatchObject({ info: { kind: 'read-only' } })
      await manager.explain(sessionId, 'delete from t', false)
    })

    it('re-applies read-only when the connection flag changes', async () => {
      const c = store.save(connectionInput())
      const { sessionId } = await manager.openSession({ connectionId: c.id })
      store.save({ ...connectionInput({ readOnly: true }), id: c.id })
      await manager.execute(sessionId, 'select 1', { maxRows: 10 })
      expect(fake.sessions[0].readOnlyCalls).toEqual([true])
    })

    it('builds the execution result with summaries and records history', async () => {
      const c = store.save(connectionInput())
      const { sessionId } = await manager.openSession({ connectionId: c.id })
      behaviour.execute = () => {
        clock += 30
        return {
          results: [
            rowsResult(42, { durationMs: 12 }),
            rowsResult(0, { index: 1, kind: 'command', command: 'UPDATE', rowCount: 3, rows: [], columns: [], durationMs: 4 }),
            rowsResult(0, { index: 2, kind: 'error', rows: [], columns: [], rowCount: null, error: { message: 'boom' }, durationMs: 1 }),
          ],
          messages: [{ level: 'notice', text: 'hello', at: 1_005 }],
          cancelled: false,
        }
      }
      const result = await manager.execute(sessionId, 'select; update; oops', { maxRows: 500 })
      expect(result.sessionId).toBe(sessionId)
      expect(result.executionId).toMatch(/[0-9a-f-]{36}/)
      expect(result.durationMs).toBe(30)
      expect(result.transaction).toEqual({ autoCommit: true, inTransaction: false })
      expect(result.messages.map((m) => [m.level, m.text])).toEqual([
        ['notice', 'hello'],
        ['info', 'SELECT · 42 rows · 12 ms'],
        ['info', 'UPDATE · 3 rows affected · 4 ms'],
        ['error', 'boom'],
      ])
      expect(history).toHaveLength(1)
      expect(history[0]).toMatchObject({
        connectionId: c.id,
        database: 'app',
        sql: 'select; update; oops',
        durationMs: 30,
        success: false,
        rowCount: null,
        error: 'boom',
        executedAt: new Date(1_000).toISOString(),
      })
    })

    it('records failed executions that throw', async () => {
      const c = store.save(connectionInput())
      const { sessionId } = await manager.openSession({ connectionId: c.id })
      behaviour.execute = () => {
        throw DriverError.of('connection', 'Connection terminated')
      }
      await expect(manager.execute(sessionId, 'select 1', { maxRows: 1 })).rejects.toThrow('Connection terminated')
      expect(history[0]).toMatchObject({ success: false, error: 'Connection terminated' })
    })

    it('skips the history for internal executions', async () => {
      const c = store.save(connectionInput())
      const { sessionId } = await manager.openSession({ connectionId: c.id })
      behaviour.execute = () => ({ results: [rowsResult(1)], messages: [], cancelled: false })
      await manager.execute(sessionId, 'select 1', { maxRows: 1 }, { history: false })
      expect(history).toHaveLength(0)
      behaviour.execute = () => {
        throw DriverError.of('connection', 'Connection terminated')
      }
      await expect(manager.execute(sessionId, 'select 1', { maxRows: 1 }, { history: false })).rejects.toThrow()
      expect(history).toHaveLength(0)
    })

    it('reopens the session on setDatabase when the driver cannot switch in place, keeping the id', async () => {
      const c = store.save(connectionInput({ readOnly: true }))
      const { sessionId } = await manager.openSession({ connectionId: c.id })
      const info = await manager.setDatabase(sessionId, 'other')
      expect(info).toMatchObject({ sessionId, database: 'other' })
      expect(fake.sessions).toHaveLength(2)
      expect(fake.sessions[0].closed).toBe(true)
      expect(fake.sessions[1].readOnlyCalls).toEqual([true])
      // the old session's close does not leak events
      fake.sessions[0].drop('late')
      expect(events.filter((e) => e.event === 'event:sessionClosed')).toEqual([])
      await manager.execute(sessionId, 'select 1', { maxRows: 1 })
      expect(fake.sessions[1].executed).toEqual(['select 1'])
    })

    it('uses USE in place when supported', async () => {
      behaviour.useDatabaseInPlace = true
      const c = store.save(connectionInput())
      const { sessionId } = await manager.openSession({ connectionId: c.id })
      await manager.setDatabase(sessionId, 'other')
      expect(fake.sessions).toHaveLength(1)
    })

    it('emits sessionClosed on unexpected loss and forgets the session', async () => {
      const c = store.save(connectionInput())
      const { sessionId } = await manager.openSession({ connectionId: c.id })
      fake.sessions[0].drop('server closed the connection')
      expect(events).toContainEqual({
        event: 'event:sessionClosed',
        payload: { sessionId, connectionId: c.id, reason: 'server closed the connection' },
      })
      await expect(manager.execute(sessionId, 'select 1', { maxRows: 1 })).rejects.toMatchObject({ info: { kind: 'not-found' } })
    })

    it('passes through transaction controls, fetchMore and cancel', async () => {
      const c = store.save(connectionInput())
      const { sessionId } = await manager.openSession({ connectionId: c.id })
      expect(await manager.setAutoCommit(sessionId, false)).toEqual({ autoCommit: false, inTransaction: false })
      await manager.fetchMore(sessionId, 'cur', 100)
      expect(fake.sessions[0].fetchMore).toHaveBeenCalledWith('cur', 100)
      await manager.cancel(sessionId)
      expect(fake.sessions[0].cancel).toHaveBeenCalled()
      await expect(manager.commit('missing')).rejects.toMatchObject({ info: { kind: 'not-found' } })
    })
  })

  describe('disconnect & lifecycle', () => {
    it('closes sessions, metadata and tunnel, then emits connectionClosed', async () => {
      const c = store.save(
        connectionInput({ ssh: { enabled: true, host: 'bastion', port: 22, username: 'u', authMethod: 'agent' } }),
      )
      const { sessionId } = await manager.openSession({ connectionId: c.id })
      await manager.disconnect(c.id)
      expect(fake.sessions[0].closed).toBe(true)
      expect(fake.metadata.closed).toBe(1)
      expect(tunnels[0].closed).toBe(true)
      expect(events).toEqual([{ event: 'event:connectionClosed', payload: { connectionId: c.id } }])
      expect(manager.activeConnections()).toEqual([])
      await expect(manager.execute(sessionId, 'select 1', { maxRows: 1 })).rejects.toMatchObject({ info: { kind: 'not-found' } })
    })

    it('tears down and reports a lost tunnel', async () => {
      const c = store.save(
        connectionInput({ ssh: { enabled: true, host: 'bastion', port: 22, username: 'u', authMethod: 'agent' } }),
      )
      const { sessionId } = await manager.openSession({ connectionId: c.id })
      tunnels[0].lose('SSH connection to bastion was closed.')
      await vi.waitFor(() => expect(events).toHaveLength(2))
      expect(manager.activeConnections()).toEqual([])
      expect(events).toEqual([
        { event: 'event:sessionClosed', payload: { sessionId, connectionId: c.id, reason: 'SSH connection to bastion was closed.' } },
        { event: 'event:connectionClosed', payload: { connectionId: c.id, reason: 'SSH connection to bastion was closed.' } },
      ])
    })

    it('disconnects when the endpoint of a connected connection changes', async () => {
      const c = store.save(connectionInput())
      await manager.connect(c.id)
      const renamed = store.save({ ...connectionInput({ name: 'Renamed' }), id: c.id })
      await manager.connectionSaved(c, renamed, false)
      expect(manager.activeConnections()).toEqual([c.id])
      const moved = store.save({ ...connectionInput({ host: 'elsewhere' }), id: c.id })
      await manager.connectionSaved(renamed, moved, false)
      expect(manager.activeConnections()).toEqual([])
    })

    it('shutdown closes everything without emitting', async () => {
      const a = store.save(connectionInput())
      const b = store.save(connectionInput({ name: 'B' }))
      await manager.openSession({ connectionId: a.id })
      await manager.connect(b.id)
      await manager.shutdown(1000)
      expect(manager.activeConnections()).toEqual([])
      expect(fake.metadata.closed).toBe(2)
      expect(events).toEqual([])
    })

    it('passes showSystemObjects to metadata', async () => {
      const c = store.save(connectionInput({ options: { showSystemObjects: true } }))
      expect(await manager.databases(c.id)).toEqual([{ name: 'sys', isSystem: true }])
    })
  })

  describe('test', () => {
    it('fills missing secrets from the store, measures latency and never throws', async () => {
      behaviour.password = 'right'
      const c = store.save(connectionInput({ secrets: { password: 'right' } }))
      const ok = await manager.test({ ...connectionInput(), id: c.id })
      expect(ok.ok).toBe(true)
      expect(ok.latencyMs).toBeGreaterThanOrEqual(0)
      const cleared = await manager.test({ ...connectionInput(), id: c.id, secrets: { password: '' } })
      expect(cleared.ok).toBe(false)
      expect(cleared.error?.code).toBe('28P01')
      const invalid = await manager.test({ ...connectionInput(), host: '' })
      expect(invalid).toMatchObject({ ok: false, error: { kind: 'invalid-input' } })
    })

    it('closes the temporary tunnel', async () => {
      behaviour.password = 'x'
      const result = await manager.test(
        connectionInput({ ssh: { enabled: true, host: 'bastion', port: 22, username: 'u', authMethod: 'agent' } }),
      )
      expect(result.ok).toBe(false)
      expect(tunnels[0].closed).toBe(true)
    })
  })

  describe('review regressions', () => {
    it('re-asserts the server-side read-only mode before every run, except inside a transaction', async () => {
      const c = store.save(connectionInput({ readOnly: true }))
      const { sessionId } = await manager.openSession({ connectionId: c.id })
      const session = fake.sessions[0]
      expect(session.readOnlyCalls).toEqual([true])
      await manager.execute(sessionId, 'select 1', { maxRows: 1 })
      await manager.execute(sessionId, 'select 2', { maxRows: 1 })
      expect(session.readOnlyCalls).toEqual([true, true, true])
      session.begin()
      await manager.execute(sessionId, 'select 3', { maxRows: 1 })
      expect(session.readOnlyCalls).toEqual([true, true, true])
    })

    it('refuses to run in a transaction opened before the connection became read-only', async () => {
      const c = store.save(connectionInput())
      const { sessionId } = await manager.openSession({ connectionId: c.id })
      fake.sessions[0].begin()
      store.save({ ...connectionInput({ readOnly: true }), id: c.id })
      await expect(manager.execute(sessionId, 'select 1', { maxRows: 1 })).rejects.toMatchObject({
        info: { kind: 'read-only', message: expect.stringMatching(/Commit or roll back/) },
      })
      expect(fake.sessions[0].executed).toEqual([])
    })

    it('keeps manual-commit mode across setDatabase and refuses to drop an open transaction', async () => {
      const c = store.save(connectionInput())
      const { sessionId } = await manager.openSession({ connectionId: c.id })
      await manager.setAutoCommit(sessionId, false)
      const info = await manager.setDatabase(sessionId, 'other')
      expect(info.transaction.autoCommit).toBe(false)
      expect(fake.sessions[1].setAutoCommit).toHaveBeenCalledWith(false)

      fake.sessions[1].begin()
      await expect(manager.setDatabase(sessionId, 'third')).rejects.toMatchObject({ info: { kind: 'invalid-input' } })
      expect(fake.sessions).toHaveLength(2)
      const forced = await manager.setDatabase(sessionId, 'third', { discardTransaction: true })
      expect(forced).toMatchObject({ database: 'third', transaction: { autoCommit: false } })
      expect(fake.sessions[1].closed).toBe(true)
    })

    it('asks for the password again when the saved one is rejected', async () => {
      behaviour.password = 'right'
      const c = store.save(connectionInput({ secrets: { password: 'expired' } }))
      await expect(manager.connect(c.id)).rejects.toMatchObject({
        info: { kind: 'needs-password', message: expect.stringMatching(/saved password .* was rejected/) },
      })
      await manager.connect(c.id, { password: 'right' })
      expect(store.secrets(c.id).password).toBe('right')
    })

    it('only sends the saved password to the saved endpoint when testing', async () => {
      const seen: (string | undefined)[] = []
      fake.driver.test = vi.fn(async (r: ResolvedConnection) => {
        seen.push(r.secrets.password)
        if (r.secrets.password !== 'right') throw new DriverError({ kind: 'connection', code: '28P01', message: 'password authentication failed' })
        return serverInfo(r.config.database)
      })
      const c = store.save(connectionInput({ secrets: { password: 'right' } }))
      expect((await manager.test({ ...connectionInput({ database: 'other' }), id: c.id })).ok).toBe(true)
      const moved = await manager.test({ ...connectionInput({ host: 'attacker.example' }), id: c.id })
      expect(moved).toMatchObject({ ok: false, error: { kind: 'needs-password' } })
      const otherUser = await manager.test({ ...connectionInput({ user: 'admin' }), id: c.id })
      expect(otherUser.ok).toBe(false)
      expect(seen).toEqual(['right', undefined, undefined])
      expect((await manager.test({ ...connectionInput({ host: 'attacker.example' }), id: c.id, secrets: { password: 'right' } })).ok).toBe(true)
    })

    it('streams server messages while a script runs', async () => {
      {
        behaviour.liveMessages = ['step 1', 'step 2']
        const c = store.save(connectionInput())
        const { sessionId } = await manager.openSession({ connectionId: c.id })
        behaviour.delayMs = 400
        const running = manager.execute(sessionId, 'do something', { maxRows: 1 })
        // delivered while the statement is still running (batched every 100 ms)
        await vi.waitFor(() => expect(events.some((e) => e.event === 'event:sessionMessages')).toBe(true), { timeout: 300 })
        await running
        expect(events.filter((e) => e.event === 'event:sessionMessages')).toEqual([
          {
            event: 'event:sessionMessages',
            payload: {
              sessionId,
              messages: [
                { level: 'notice', text: 'step 1', at: 1 },
                { level: 'notice', text: 'step 2', at: 1 },
              ],
            },
          },
        ])
      }
    })

    it('records the console schema and redacts passwords in the history', async () => {
      const c = store.save(connectionInput())
      const { sessionId } = await manager.openSession({ connectionId: c.id })
      await manager.setSchema(sessionId, 'sales')
      await manager.execute(sessionId, "select 1; alter role app password 'hunter2'", { maxRows: 1 })
      expect(history.at(-1)).toMatchObject({ schema: 'sales', sql: "select 1; alter role app password '********'" })
    })

    it('lists open transactions and closes every console session on renderer reload', async () => {
      const c = store.save(connectionInput())
      const a = await manager.openSession({ connectionId: c.id })
      await manager.openSession({ connectionId: c.id })
      fake.sessions[0].begin()
      expect(manager.openTransactions()).toEqual([{ sessionId: a.sessionId, connectionId: c.id }])
      await manager.closeAllSessions()
      expect(fake.sessions.every((s) => s.closed)).toBe(true)
      expect(manager.openTransactions()).toEqual([])
      expect(manager.activeConnections()).toEqual([c.id])
      expect(events).toEqual([])
    })

    it('refuses SQL Server estimated plans that would switch SHOWPLAN off', async () => {
      const c = store.save(connectionInput({ dialect: 'mssql', port: 1433 }))
      const { sessionId } = await manager.openSession({ connectionId: c.id })
      await expect(manager.explain(sessionId, 'SET SHOWPLAN_XML OFF\nGO\nDELETE FROM t', false)).rejects.toMatchObject({
        info: { kind: 'invalid-input' },
      })
      await expect(manager.explain(sessionId, 'set statistics xml on; select 1', false)).rejects.toMatchObject({ info: { kind: 'invalid-input' } })
      expect(fake.sessions[0].explain).not.toHaveBeenCalled()
      await manager.explain(sessionId, "SELECT 'SET SHOWPLAN_XML OFF' AS x", false)
      expect(fake.sessions[0].explain).toHaveBeenCalledTimes(1)
    })
  })
})
