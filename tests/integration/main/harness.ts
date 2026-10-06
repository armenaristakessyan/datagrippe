// Shared setup for the main-process review repro tests: a SessionManager on real drivers and stores.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConnectionInput, Dialect } from '@shared/types'
import { getDriver } from '../../../src/main/db/drivers'
import { SessionManager } from '../../../src/main/db/session-manager'
import { openTunnel } from '../../../src/main/db/tunnel'
import { ConnectionStore } from '../../../src/main/store/connections'
import { HistoryStore } from '../../../src/main/store/history'
import { SecretStore } from '../../../src/main/store/secrets'
import { TEST_MSSQL, TEST_PG } from '../../test-env'

export const crypto = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(s, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8'),
}
export const quiet = { warn: () => undefined, error: () => undefined }

export function envOf(dialect: Dialect) {
  return dialect === 'postgres' ? TEST_PG : TEST_MSSQL
}

export function connectionInput(dialect: Dialect, overrides: Partial<ConnectionInput> = {}): ConnectionInput {
  const env = envOf(dialect)
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

export function createHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'dg-rv-main-'))
  const store = new ConnectionStore(dir, new SecretStore(dir, crypto, quiet), { log: quiet })
  const history = new HistoryStore(dir, { debounceMs: 0, log: quiet })
  const events: { event: string; payload: unknown }[] = []
  const manager = new SessionManager({
    connections: store,
    drivers: getDriver,
    history,
    emit: (event, payload) => events.push({ event, payload }),
    openTunnel: (config, secrets) => openTunnel(config, secrets),
    log: quiet,
  })
  return {
    dir,
    store,
    history,
    events,
    manager,
    async dispose() {
      await manager.shutdown()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
