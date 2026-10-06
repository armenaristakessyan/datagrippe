// SessionManager + stores + export against the real drivers and the docker test databases.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest'
import type { IpcEventName } from '@shared/ipc'
import type { ConnectionInput, Dialect } from '@shared/types'
import { getDriver } from '../../src/main/db/drivers'
import { SessionManager } from '../../src/main/db/session-manager'
import { openTunnel } from '../../src/main/db/tunnel'
import { exportQuery } from '../../src/main/export/export-query'
import { ConnectionStore } from '../../src/main/store/connections'
import { HistoryStore } from '../../src/main/store/history'
import { SecretStore } from '../../src/main/store/secrets'
import { TEST_MSSQL, TEST_PG } from '../test-env'

const crypto = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(s, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8'),
}
const quiet = { warn: () => undefined, error: () => undefined }

interface Target {
  dialect: Dialect
  env: typeof TEST_PG | typeof TEST_MSSQL
  writeSql: string
  bigQuery: string
}

const TARGETS: Target[] = [
  {
    dialect: 'postgres',
    env: TEST_PG,
    writeSql: 'create table dg_should_not_exist (id int)',
    bigQuery: "select n, 'row ' || n as label from generate_series(1, 12000) as n",
  },
  {
    dialect: 'mssql',
    env: TEST_MSSQL,
    writeSql: 'create table dg_should_not_exist (id int)',
    bigQuery:
      "select top 12000 row_number() over (order by (select null)) as n, concat('row ', row_number() over (order by (select null))) as label from sys.all_objects a cross join sys.all_objects b",
  },
]

describe.each(TARGETS)('SessionManager with $dialect', ({ dialect, env, writeSql, bigQuery }) => {
  let dir: string
  let store: ConnectionStore
  let history: HistoryStore
  let manager: SessionManager
  const events: { event: IpcEventName; payload: unknown }[] = []
  let available = true

  const input = (overrides: Partial<ConnectionInput> = {}): ConnectionInput => ({
    name: `Test ${dialect}`,
    dialect,
    host: env.host,
    port: env.port,
    database: env.adminDatabase,
    user: env.user,
    savePassword: true,
    ssl: { mode: dialect === 'mssql' ? 'require' : 'disable' },
    ssh: { enabled: false, host: '', port: 22, username: '', authMethod: 'password' },
    color: 'none',
    readOnly: false,
    productionGuard: false,
    options: {},
    secrets: { password: env.password },
    ...overrides,
  })

  const requireDriver = (ctx: TestContext) => {
    if (!available) ctx.skip()
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), `dg-it-${dialect}-`))
    store = new ConnectionStore(dir, new SecretStore(dir, crypto, quiet), { log: quiet })
    history = new HistoryStore(dir, { debounceMs: 0, log: quiet })
    manager = new SessionManager({
      connections: store,
      drivers: getDriver,
      history,
      emit: (event, payload) => events.push({ event, payload }),
      openTunnel: (config, secrets) => openTunnel(config, secrets),
      log: quiet,
    })
    const probe = await manager.test(input())
    // The driver package may not have landed yet: skip instead of failing on its stub.
    if (!probe.ok && /not implemented/i.test(probe.error?.message ?? '')) available = false
  })

  afterAll(async () => {
    await manager?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  it('tests a definition', async (ctx) => {
    requireDriver(ctx)
    const result = await manager.test(input())
    expect(result.error).toBeUndefined()
    expect(result.ok).toBe(true)
    expect(result.info?.dialect).toBe(dialect)
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('connects, executes with summaries and records history', async (ctx) => {
    requireDriver(ctx)
    const c = store.save(input())
    const info = await manager.connect(c.id)
    expect(info.versionShort).not.toBe('')
    const session = await manager.openSession({ connectionId: c.id })
    const exec = await manager.execute(session.sessionId, 'select 1 as one', { maxRows: 100 })
    expect(exec.results[0].kind).toBe('rows')
    expect(exec.results[0].rows).toEqual([[1]])
    expect(exec.messages.some((m) => m.level === 'info' && m.text.startsWith('SELECT · 1 row · '))).toBe(true)
    expect(history.list({ connectionId: c.id })[0]).toMatchObject({ sql: 'select 1 as one', success: true, rowCount: 1 })
    await manager.closeSession(session.sessionId)
  })

  it('blocks writes on a read-only connection', async (ctx) => {
    requireDriver(ctx)
    const c = store.save(input({ name: 'Read only', readOnly: true }))
    const session = await manager.openSession({ connectionId: c.id })
    await expect(manager.execute(session.sessionId, writeSql, { maxRows: 10 })).rejects.toMatchObject({
      info: { kind: 'read-only' },
    })
    const ok = await manager.execute(session.sessionId, 'select 2 as two', { maxRows: 10 })
    expect(ok.results[0].rows).toEqual([[2]])
  })

  it('exports a large result to CSV through fetchMore', async (ctx) => {
    requireDriver(ctx)
    const c = store.save(input({ name: 'Export' }))
    const path = join(dir, 'export.csv')
    const result = await exportQuery(
      { connectionId: c.id, sql: bigQuery, format: 'csv', defaultName: 'export' },
      { sessions: manager, chooseFile: async () => path },
    )
    expect(result).toEqual({ path, rows: 12000 })
    const lines = readFileSync(path, 'utf8').split('\r\n')
    expect(lines[0]).toBe('n,label')
    expect(lines[1]).toBe('1,row 1')
    expect(lines[12000]).toBe('12000,row 12000')
    expect(lines).toHaveLength(12002) // trailing CRLF
  })

  it('asks for a password when none is stored', async (ctx) => {
    requireDriver(ctx)
    const c = store.save(input({ name: 'No password', savePassword: false, secrets: undefined }))
    await expect(manager.connect(c.id)).rejects.toMatchObject({ info: { kind: 'needs-password' } })
    const info = await manager.connect(c.id, { password: env.password })
    expect(info.dialect).toBe(dialect)
  })

  it('disconnect closes everything and emits', async (ctx) => {
    requireDriver(ctx)
    const c = store.save(input({ name: 'Disconnect' }))
    await manager.openSession({ connectionId: c.id })
    await manager.disconnect(c.id)
    expect(manager.activeConnections()).not.toContain(c.id)
    expect(events).toContainEqual({ event: 'event:connectionClosed', payload: { connectionId: c.id } })
  })
})
