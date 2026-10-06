// The vault CLI workflow end to end against the dev Vault: VAULT_ADDR from the login shell, the CLI token in
// ~/.vault-token (no prompt for that server), and secret paths suggested from the database mounts the token sees
// (deep mounts laid out per instance, like a real organisation's — tests/setup/vault.ts).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConnectionInput, Dialect, VaultConfig, VaultDiscoverTarget } from '@shared/types'
import { getDriver } from '../../src/main/db/drivers'
import { SessionManager } from '../../src/main/db/session-manager'
import { openTunnel } from '../../src/main/db/tunnel'
import { ConnectionStore } from '../../src/main/store/connections'
import { HistoryStore } from '../../src/main/store/history'
import { SecretStore } from '../../src/main/store/secrets'
import { MemoryVaultTokenStore } from '../../src/main/store/vault-tokens'
import { VaultService } from '../../src/main/vault/service'
import { readerToken, vaultApi, vaultAvailable, vaultNames } from '../setup/vault'
import { TEST_MSSQL, TEST_PG, TEST_VAULT } from '../test-env'

const available = await vaultAvailable()
const n = vaultNames()
const quiet = { warn: () => undefined, error: () => undefined }
const crypto = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s, 'utf8'), decryptString: (b: Buffer) => b.toString('utf8') }

function harness(options: { shellAddress?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dg-vault-disc-'))
  const home = mkdtempSync(join(tmpdir(), 'dg-vault-disc-home-'))
  const store = new ConnectionStore(dir, new SecretStore(dir, crypto, quiet), { log: quiet })
  const asked: string[] = []
  const vault = new VaultService({
    // Started from Finder: no VAULT_* in the process; the login shell knows VAULT_ADDR.
    env: () => ({}),
    environment: async () => (options.shellAddress ? { address: options.shellAddress, source: 'login-shell' } : { source: 'none' }),
    homeDir: () => home,
    tokenStore: new MemoryVaultTokenStore(),
    confirmAmbientToken: async (request) => {
      asked.push(request.address)
      return false
    },
    openExternal: async () => {
      throw new Error('no browser in tests')
    },
    log: quiet,
  })
  const manager = new SessionManager({
    connections: store,
    drivers: getDriver,
    history: new HistoryStore(dir, { debounceMs: 0, log: quiet }),
    emit: () => undefined,
    openTunnel: (config, secrets) => openTunnel(config, secrets),
    vault,
    log: quiet,
  })
  return {
    store,
    manager,
    home,
    asked,
    async dispose() {
      await manager.shutdown()
      await vault.dispose()
      rmSync(dir, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    },
  }
}

const cliVault = (secretPath: string): VaultConfig => ({ address: TEST_VAULT.address, loginMethod: 'token', secretPath })

function input(dialect: Dialect, vault: VaultConfig): ConnectionInput {
  const env = dialect === 'postgres' ? TEST_PG : TEST_MSSQL
  return {
    name: dialect === 'postgres' ? `PGSQL - Analytics - ${env.database}` : 'SQL SERVER - billing-prod-acme',
    dialect,
    host: env.host,
    port: env.port,
    database: env.database,
    user: '',
    savePassword: true,
    ssl: { mode: dialect === 'mssql' ? 'require' : 'disable' },
    ssh: { enabled: false, host: '', port: 22, username: '', authMethod: 'password' },
    color: 'red',
    group: 'PROD',
    readOnly: false,
    productionGuard: true,
    options: {},
    authMode: 'vault',
    vault,
  }
}

const targets: VaultDiscoverTarget[] = [
  { key: 'pg', dialect: 'postgres', host: TEST_PG.host, database: TEST_PG.database, name: `PGSQL - Analytics - ${TEST_PG.database}`, group: 'PROD' },
  { key: 'mssql', dialect: 'mssql', host: TEST_MSSQL.host, database: TEST_MSSQL.database, name: 'SQL SERVER - billing-prod-acme', group: 'PROD' },
]

describe.skipIf(!available)('Vault CLI workflow (dev server)', () => {
  let h: ReturnType<typeof harness>
  afterEach(async () => {
    await h?.dispose()
  })

  it('suggests "<mount>/creds/read_only" from the mounts the token sees', async () => {
    h = harness()
    const result = await h.manager.vaultDiscover({
      vault: { address: TEST_VAULT.address, loginMethod: 'userpass', authMount: n.userpassMount, username: n.readerUser, secretPath: '' },
      secrets: { vaultPassword: n.readerPassword },
      targets,
    })
    const paths = result.mounts.map((m) => m.path)
    expect(paths).toEqual(expect.arrayContaining([n.deepPgMount, n.deepMssqlMount, n.dbMount]))
    expect(Object.fromEntries(result.suggestions.map((s) => [s.key, s.path]))).toEqual({
      pg: `${n.deepPgMount}/creds/read_only`,
      mssql: `${n.deepMssqlMount}/creds/read_only`,
    })
    expect(result.ranking?.pg?.[0]?.mount).toBe(n.deepPgMount)
    expect(JSON.stringify(result)).not.toContain(n.readerPassword)
  })

  it('connects with ~/.vault-token for the VAULT_ADDR of the login shell, without asking', async () => {
    h = harness({ shellAddress: `${TEST_VAULT.address}/` })
    writeFileSync(join(h.home, '.vault-token'), `${await readerToken()}\n`)
    const pgConn = h.store.save(input('postgres', cliVault(`${n.deepPgMount}/creds/read_only`)))
    const pgServer = await h.manager.connect(pgConn.id)
    expect(pgServer.currentUser).toMatch(/^v-token-/)
    expect(h.manager.vaultStatus(pgConn.id)?.info).toMatchObject({ tokenSource: 'cli', kind: 'dynamic' })

    const msConn = h.store.save(input('mssql', cliVault(`${n.deepMssqlMount}/creds/read_only`)))
    const msServer = await h.manager.connect(msConn.id)
    expect(msServer.currentUser).toMatch(/^v-token-/)
    expect(h.asked).toEqual([])

    // Discovery with the same CLI token: no password, no prompt.
    const found = await h.manager.vaultDiscover({ vault: cliVault(''), targets, connectionId: pgConn.id })
    expect(found.suggestions.map((s) => s.path).sort()).toEqual([`${n.deepMssqlMount}/creds/read_only`, `${n.deepPgMount}/creds/read_only`])
  })

  it('never sends ~/.vault-token to a server the login shell does not name', async () => {
    h = harness({ shellAddress: 'https://vault.example.shared' })
    writeFileSync(join(h.home, '.vault-token'), await readerToken())
    const saved = h.store.save(input('postgres', { ...cliVault(`${n.deepPgMount}/creds/read_only`), oidcFallback: false }))
    await expect(h.manager.connect(saved.id)).rejects.toMatchObject({ info: { kind: 'needs-password', secretField: 'vaultToken' } })
    expect(h.asked).toEqual([])
  })

  it('a token that sees no database mount gets a warning, not an error', async () => {
    h = harness()
    const result = await h.manager.vaultDiscover({
      vault: { address: TEST_VAULT.address, loginMethod: 'userpass', authMount: n.userpassMount, username: n.deniedUser, secretPath: '' },
      secrets: { vaultPassword: n.deniedPassword },
      targets,
    })
    expect(result.mounts).toEqual([])
    expect(result.suggestions).toEqual([])
    expect(result.warnings[0]).toMatch(/no database secrets engine/)
  })

  it('keeps the role of the request and refuses a malformed one', async () => {
    h = harness()
    const vault: VaultConfig = { address: TEST_VAULT.address, loginMethod: 'userpass', authMount: n.userpassMount, username: n.readerUser, secretPath: '' }
    const result = await h.manager.vaultDiscover({ vault, secrets: { vaultPassword: n.readerPassword }, targets: [targets[0]], role: 'reporting' })
    expect(result.suggestions[0]?.path).toBe(`${n.deepPgMount}/creds/reporting`)
    await expect(h.manager.vaultDiscover({ vault, secrets: { vaultPassword: n.readerPassword }, targets, role: '../sys' })).rejects.toMatchObject({
      info: { kind: 'invalid-input' },
    })
    // The dev Vault also sees the mounts through the API used by the app.
    const ui = await vaultApi<{ data: { secret: Record<string, unknown> } }>('GET', 'sys/internal/ui/mounts')
    expect(Object.keys(ui.data.secret)).toContain(`${n.deepPgMount}/`)
  })
})
