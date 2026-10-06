// Minimal SessionManager harness on the docker test databases.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import type { ConnectionInput, Dialect } from '@shared/types'
import { getDriver } from '../../../src/main/db/drivers'
import { SessionManager } from '../../../src/main/db/session-manager'
import { openTunnel } from '../../../src/main/db/tunnel'
import { ConnectionStore } from '../../../src/main/store/connections'
import { HistoryStore } from '../../../src/main/store/history'
import { SecretStore } from '../../../src/main/store/secrets'
import { TEST_MSSQL, TEST_PG } from '../../test-env'

const crypto = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(s, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8'),
}
const quiet = { warn: () => undefined, error: () => undefined }

export interface Harness {
  dir: string
  store: ConnectionStore
  manager: SessionManager
  input: (dialect: Dialect, overrides?: Partial<ConnectionInput>) => ConnectionInput
  close: () => Promise<void>
}

export function createHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'dg-rv-full-'))
  const store = new ConnectionStore(dir, new SecretStore(dir, crypto, quiet), { log: quiet })
  const history = new HistoryStore(dir, { debounceMs: 0, log: quiet })
  const manager = new SessionManager({
    connections: store,
    drivers: getDriver,
    history,
    emit: () => undefined,
    openTunnel: (config, secrets) => openTunnel(config, secrets),
    log: quiet,
  })
  const input = (dialect: Dialect, overrides: Partial<ConnectionInput> = {}): ConnectionInput => {
    const env = dialect === 'postgres' ? TEST_PG : TEST_MSSQL
    return {
      name: `Review ${dialect}`,
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
      ...overrides,
    }
  }
  return {
    dir,
    store,
    manager,
    input,
    close: async () => {
      await manager.shutdown()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** A plain pg client on the review database (plays "another user" of the server). */
export async function pgAdmin(): Promise<pg.Client> {
  const client = new pg.Client({ host: TEST_PG.host, port: TEST_PG.port, user: TEST_PG.user, password: TEST_PG.password, database: TEST_PG.database })
  await client.connect()
  return client
}
