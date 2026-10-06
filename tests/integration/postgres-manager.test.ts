// SessionManager behaviour on PostgreSQL connections.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConnectionInput } from '@shared/types'
import { getDriver } from '../../src/main/db/drivers'
import { SessionManager } from '../../src/main/db/session-manager'
import { openTunnel } from '../../src/main/db/tunnel'
import { ConnectionStore } from '../../src/main/store/connections'
import { HistoryStore } from '../../src/main/store/history'
import { SecretStore } from '../../src/main/store/secrets'
import { TEST_PG } from '../test-env'
import { adminClient } from './helpers/pg'

const crypto = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(s, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8'),
}
const quiet = { warn: () => undefined, error: () => undefined }

describe('pg review: session manager', () => {
  let admin: pg.Client
  let dir: string
  let store: ConnectionStore
  let manager: SessionManager
  const input = (overrides: Partial<ConnectionInput> = {}): ConnectionInput => ({
    name: 'Review pg',
    dialect: 'postgres',
    host: TEST_PG.host,
    port: TEST_PG.port,
    database: TEST_PG.database,
    user: TEST_PG.user,
    savePassword: true,
    ssl: { mode: 'disable' },
    ssh: {
      enabled: false,
      host: '',
      port: 22,
      username: '',
      authMethod: 'password',
    },
    color: 'none',
    readOnly: false,
    productionGuard: false,
    options: {},
    secrets: { password: TEST_PG.password },
    ...overrides,
  })

  beforeAll(async () => {
    admin = adminClient()
    await admin.connect()
    await admin.query(`DROP SCHEMA IF EXISTS rv_mgr CASCADE; CREATE SCHEMA rv_mgr;
      CREATE TABLE rv_mgr.t (id int PRIMARY KEY); INSERT INTO rv_mgr.t VALUES (1), (2), (3);
      CREATE FUNCTION rv_mgr.purge() RETURNS int LANGUAGE sql AS $$ DELETE FROM rv_mgr.t RETURNING 1 $$`)
    dir = mkdtempSync(join(tmpdir(), 'dg-rv-pg-'))
    store = new ConnectionStore(dir, new SecretStore(dir, crypto, quiet), {
      log: quiet,
    })
    manager = new SessionManager({
      connections: store,
      drivers: getDriver,
      history: new HistoryStore(dir, { debounceMs: 0, log: quiet }),
      emit: () => undefined,
      openTunnel,
      log: quiet,
    })
  })
  afterAll(async () => {
    await manager.shutdown()
    await admin.query('DROP SCHEMA IF EXISTS rv_mgr CASCADE')
    await admin.end()
    rmSync(dir, { recursive: true, force: true })
  })

  it('switching database keeps manual-commit mode', async () => {
    const c = store.save(input())
    const s = await manager.openSession({ connectionId: c.id })
    expect(await manager.setAutoCommit(s.sessionId, false)).toEqual({
      autoCommit: false,
      inTransaction: false,
    })
    const info = await manager.setDatabase(s.sessionId, 'postgres')
    // Before the fix: { autoCommit: true } — the reopened session silently falls back to auto-commit.
    expect(info.transaction.autoCommit).toBe(false)
    await manager.closeSession(s.sessionId)
  })

  it('a read-only connection cannot be switched back to read-write by the user', async () => {
    const c = store.save(input({ name: 'Review pg read-only', readOnly: true }))
    const s = await manager.openSession({ connectionId: c.id })
    const outcome = await manager
      .execute(s.sessionId, 'BEGIN READ WRITE; SELECT rv_mgr.purge(); COMMIT', {
        maxRows: 10,
      })
      .catch((error: unknown) => error)
    // Before the fix: BEGIN / SET / RESET are classified read-only, so the server-side guard is switched off and the rows are deleted.
    expect(Number((await admin.query('SELECT count(*) AS n FROM rv_mgr.t')).rows[0]?.n)).toBe(3)
    expect(outcome).toBeInstanceOf(Error)
    await manager.closeSession(s.sessionId)
  })
})
