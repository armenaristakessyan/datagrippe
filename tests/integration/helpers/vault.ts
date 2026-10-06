// SessionManager wired to the real drivers and the dev Vault of docker-compose.test.yml (Vault lifecycle tests).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcEventName } from '@shared/ipc'
import type { ConnectionInput, VaultConfig, VaultStatus } from '@shared/types'
import { getDriver } from '../../../src/main/db/drivers'
import { SessionManager } from '../../../src/main/db/session-manager'
import { openTunnel } from '../../../src/main/db/tunnel'
import { ConnectionStore } from '../../../src/main/store/connections'
import { HistoryStore } from '../../../src/main/store/history'
import { SecretStore } from '../../../src/main/store/secrets'
import { VaultService, type VaultServiceDeps } from '../../../src/main/vault/service'
import { TEST_PG, TEST_VAULT } from '../../test-env'

export const quiet = { warn: () => undefined, error: () => undefined }
const crypto = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(s, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8'),
}

/** Root-token call to the dev Vault (test-only token from tests/test-env.ts). A 404 resolves (deletes are idempotent). */
export async function rootApi<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${TEST_VAULT.address}/v1/${path}`, {
    method,
    headers: { 'X-Vault-Token': TEST_VAULT.rootToken, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  if (!res.ok && res.status !== 404) throw new Error(`Vault ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`)
  return (text ? JSON.parse(text) : null) as T
}

/**
 * A SessionManager + VaultService on a temporary profile. The home directory and environment are empty by
 * default: the developer's own ~/.vault-token / VAULT_TOKEN are never sent to the test Vault.
 */
export function createVaultHarness(deps: Partial<VaultServiceDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dg-vault-it-'))
  const home = mkdtempSync(join(tmpdir(), 'dg-vault-home-'))
  const store = new ConnectionStore(dir, new SecretStore(dir, crypto, quiet), { log: quiet })
  const statuses: VaultStatus[] = []
  const events: { event: IpcEventName; payload: unknown }[] = []
  const vault = new VaultService({ env: () => ({}), homeDir: () => home, onStatus: (s) => statuses.push(s), log: quiet, ...deps })
  const manager = new SessionManager({
    connections: store,
    drivers: getDriver,
    history: new HistoryStore(dir, { debounceMs: 0, log: quiet }),
    emit: (event, payload) => void events.push({ event, payload }),
    openTunnel: (config, secrets) => openTunnel(config, secrets),
    vault,
    log: quiet,
  })
  return {
    home,
    store,
    manager,
    vault,
    statuses,
    events,
    async dispose() {
      await manager.shutdown()
      await vault.dispose()
      rmSync(dir, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    },
  }
}

export function pgVaultInput(vault: VaultConfig, secrets: ConnectionInput['secrets'], applicationName = 'dg-vault-lifecycle'): ConnectionInput {
  return {
    name: 'Vault pg',
    dialect: 'postgres',
    host: TEST_PG.host,
    port: TEST_PG.port,
    database: TEST_PG.database,
    user: '',
    savePassword: true,
    ssl: { mode: 'disable' },
    ssh: { enabled: false, host: '', port: 22, username: '', authMethod: 'password' },
    color: 'none',
    readOnly: false,
    productionGuard: false,
    options: { applicationName },
    authMode: 'vault',
    vault,
    secrets,
  }
}
