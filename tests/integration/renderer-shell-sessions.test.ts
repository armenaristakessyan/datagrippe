// Server sessions view (renderer-shell): its listing SQL and the cancel / terminate statements run
// through the real SessionManager and drivers against the docker test databases.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConnectionInput, Dialect, StatementResult } from '@shared/types'
import { getDriver } from '../../src/main/db/drivers'
import { SessionManager } from '../../src/main/db/session-manager'
import { openTunnel } from '../../src/main/db/tunnel'
import { ConnectionStore } from '../../src/main/store/connections'
import { HistoryStore } from '../../src/main/store/history'
import { SecretStore } from '../../src/main/store/secrets'

// The renderer module under test is loaded at runtime: tsconfig.node (which type-checks tests/) does not
// include renderer sources. It only depends on @shared types, so it runs fine under node.
interface ListedSession {
  pid: number
  user: string | null
  database: string | null
  state: string | null
  stateMs: number | null
  query: string | null
  self: boolean
}
interface SessionsQueries {
  SESSIONS_SQL: Record<Dialect, string>
  parseSessions(result: Pick<StatementResult, 'columns' | 'rows'>): ListedSession[]
  sessionActionSql(dialect: Dialect, action: 'cancel' | 'terminate', pid: number): string
  supportsCancel(dialect: Dialect): boolean
  actionSucceeded(dialect: Dialect, result: Pick<StatementResult, 'kind' | 'rows'> | undefined): boolean
}
const QUERIES_MODULE = '../../src/renderer/src/components/sessions/queries'
const { actionSucceeded, parseSessions, sessionActionSql, SESSIONS_SQL, supportsCancel } = (await import(
  /* @vite-ignore */ QUERIES_MODULE
)) as SessionsQueries
import { TEST_MSSQL, TEST_PG } from '../test-env'

const crypto = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(s, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8'),
}
const quiet = { warn: () => undefined, error: () => undefined }

const TARGETS: { dialect: Dialect; env: typeof TEST_PG | typeof TEST_MSSQL; sleep: string }[] = [
  { dialect: 'postgres', env: TEST_PG, sleep: 'SELECT pg_sleep(30)' },
  { dialect: 'mssql', env: TEST_MSSQL, sleep: "WAITFOR DELAY '00:00:30'" },
]

const OPTIONS = { maxRows: 2000 }

describe.each(TARGETS)('server sessions on $dialect', ({ dialect, env, sleep }) => {
  let dir: string
  let manager: SessionManager
  let connectionId: string

  const input = (): ConnectionInput => ({
    name: `Sessions ${dialect}`,
    dialect,
    host: env.host,
    port: env.port,
    database: env.database,
    user: env.user,
    savePassword: true,
    ssl: { mode: dialect === 'mssql' ? 'require' : 'disable' },
    ssh: { enabled: false, host: '', port: 22, username: '', authMethod: 'password' },
    color: 'none',
    readOnly: false,
    productionGuard: false,
    options: {},
    secrets: { password: env.password },
  })

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), `dg-it-sessions-${dialect}-`))
    const store = new ConnectionStore(dir, new SecretStore(dir, crypto, quiet), { log: quiet })
    manager = new SessionManager({
      connections: store,
      drivers: getDriver,
      history: new HistoryStore(dir, { debounceMs: 0, log: quiet }),
      emit: () => undefined,
      openTunnel: (config, secrets) => openTunnel(config, secrets),
      log: quiet,
    })
    connectionId = store.save(input()).id
    await manager.connect(connectionId)
  })

  afterAll(async () => {
    await manager?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  const list = async (sessionId: string) => {
    const exec = await manager.execute(sessionId, SESSIONS_SQL[dialect], OPTIONS, { history: false })
    const result = exec.results[0]!
    expect(result.error).toBeUndefined()
    expect(result.kind).toBe('rows')
    return parseSessions(result)
  }

  it('lists the sessions, flags its own and shows what another one runs', async () => {
    const view = await manager.openSession({ connectionId })
    const other = await manager.openSession({ connectionId })
    try {
      const running = manager.execute(other.sessionId, sleep, OPTIONS, { history: false })
      // Wait until the sleeping statement shows up as active.
      let target: ListedSession | undefined
      for (let i = 0; i < 40 && !target; i++) {
        target = (await list(view.sessionId)).find((s) => !s.self && /pg_sleep|WAITFOR/i.test(s.query ?? '') && /active|running|suspended/.test(s.state ?? ''))
        if (!target) await new Promise((r) => setTimeout(r, 100))
      }
      expect(target).toBeDefined()
      const sessions = await list(view.sessionId)
      const self = sessions.filter((s) => s.self)
      expect(self).toHaveLength(1)
      expect(self[0]!.database).toBe(env.database)
      expect(target!.user).toBe(env.user)
      expect(target!.stateMs).not.toBeNull()

      // End it: PostgreSQL cancels the query (the session survives), SQL Server kills the session.
      const action = supportsCancel(dialect) ? 'cancel' : 'terminate'
      const done = await manager.execute(view.sessionId, sessionActionSql(dialect, action, target!.pid), OPTIONS)
      expect(done.results[0]!.error).toBeUndefined()
      expect(actionSucceeded(dialect, done.results[0])).toBe(true)
      const outcome = await running.then(
        (exec) => exec.results[0]?.kind ?? 'none',
        () => 'thrown',
      )
      expect(['error', 'thrown']).toContain(outcome)
    } finally {
      await manager.closeSession(other.sessionId).catch(() => undefined)
      await manager.closeSession(view.sessionId).catch(() => undefined)
    }
  })

  it.runIf(dialect === 'postgres')('terminates another PostgreSQL session', async () => {
    const view = await manager.openSession({ connectionId })
    const other = await manager.openSession({ connectionId })
    try {
      await manager.execute(other.sessionId, 'SELECT 1', OPTIONS, { history: false })
      const pidExec = await manager.execute(other.sessionId, 'SELECT pg_backend_pid()', OPTIONS, { history: false })
      const pid = Number(pidExec.results[0]!.rows[0]![0])
      const done = await manager.execute(view.sessionId, sessionActionSql('postgres', 'terminate', pid), OPTIONS)
      expect(actionSucceeded('postgres', done.results[0])).toBe(true)
      for (let i = 0; i < 20 && (await list(view.sessionId)).some((s) => s.pid === pid); i++) await new Promise((r) => setTimeout(r, 100))
      expect((await list(view.sessionId)).some((s) => s.pid === pid)).toBe(false)
      // A pid that does not exist is reported as "not signalled", not as an error.
      const missing = await manager.execute(view.sessionId, sessionActionSql('postgres', 'cancel', 2147483000), OPTIONS)
      expect(actionSucceeded('postgres', missing.results[0])).toBe(false)
    } finally {
      await manager.closeSession(other.sessionId).catch(() => undefined)
      await manager.closeSession(view.sessionId).catch(() => undefined)
    }
  })
})
