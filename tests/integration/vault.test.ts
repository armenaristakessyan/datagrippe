// HashiCorp Vault end to end: the dev Vault of docker-compose.test.yml issues real database users for the
// test PostgreSQL / SQL Server databases (configured by tests/setup/vault.ts).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sql from 'mssql'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { ConnectionInput, Dialect, VaultConfig, VaultStatus } from '@shared/types'
import { getDriver } from '../../src/main/db/drivers'
import { SessionManager } from '../../src/main/db/session-manager'
import { openTunnel } from '../../src/main/db/tunnel'
import { ConnectionStore } from '../../src/main/store/connections'
import { HistoryStore } from '../../src/main/store/history'
import { SecretStore } from '../../src/main/store/secrets'
import { VaultService } from '../../src/main/vault/service'
import { readerToken, vaultAvailable, vaultNames } from '../setup/vault'
import { TEST_MSSQL, TEST_PG, TEST_VAULT } from '../test-env'

const available = await vaultAvailable()
if (!available) console.warn(`[vault] ${TEST_VAULT.address} is not reachable: skipping the Vault integration tests.`)
const n = vaultNames()
const quiet = { warn: () => undefined, error: () => undefined }
const crypto = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(s, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8'),
}

function createHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'dg-vault-it-'))
  // An empty home and environment: the developer's own ~/.vault-token / VAULT_TOKEN must never be sent to the test Vault.
  const home = mkdtempSync(join(tmpdir(), 'dg-vault-home-'))
  const store = new ConnectionStore(dir, new SecretStore(dir, crypto, quiet), { log: quiet })
  const statuses: VaultStatus[] = []
  const vault = new VaultService({
    env: () => ({}),
    homeDir: () => home,
    onStatus: (status) => statuses.push(status),
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
    vault,
    statuses,
    async dispose() {
      await manager.shutdown()
      await vault.dispose()
      rmSync(dir, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    },
  }
}

function vaultInput(dialect: Dialect, vault: Partial<VaultConfig> = {}, patch: Partial<ConnectionInput> = {}): ConnectionInput {
  const env = dialect === 'postgres' ? TEST_PG : TEST_MSSQL
  return {
    name: `Vault ${dialect}`,
    dialect,
    host: env.host,
    port: env.port,
    database: env.database,
    user: '',
    savePassword: true,
    ssl: { mode: dialect === 'mssql' ? 'require' : 'disable' },
    ssh: { enabled: false, host: '', port: 22, username: '', authMethod: 'password' },
    color: 'none',
    readOnly: false,
    productionGuard: false,
    options: {},
    authMode: 'vault',
    vault: {
      address: TEST_VAULT.address,
      loginMethod: 'userpass',
      authMount: n.userpassMount,
      username: n.readerUser,
      secretPath: `${n.dbMount}/creds/${dialect === 'postgres' ? n.pgRole : n.mssqlRole}`,
      ...vault,
    },
    ...patch,
  }
}

async function scalar(manager: SessionManager, sessionId: string, query: string): Promise<unknown> {
  const result = await manager.execute(sessionId, query, { maxRows: 10 })
  const first = result.results[0]
  if (first.kind === 'error') throw new Error(first.error?.message)
  return first.rows[0]?.[0]
}

let admin: pg.Client
let mssqlAdmin: sql.ConnectionPool

async function pgRoleExists(name: string): Promise<boolean> {
  const { rowCount } = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name])
  return (rowCount ?? 0) > 0
}

async function mssqlLoginExists(name: string): Promise<boolean> {
  const result = await mssqlAdmin.request().input('name', sql.NVarChar, name).query('SELECT 1 AS x FROM sys.server_principals WHERE name = @name')
  return result.recordset.length > 0
}

describe.skipIf(!available)('HashiCorp Vault (dev server)', () => {
  let h: ReturnType<typeof createHarness>

  beforeAll(async () => {
    admin = new pg.Client({ host: TEST_PG.host, port: TEST_PG.port, user: TEST_PG.user, password: TEST_PG.password, database: TEST_PG.database })
    await admin.connect()
    mssqlAdmin = new sql.ConnectionPool({
      server: TEST_MSSQL.host,
      port: TEST_MSSQL.port,
      user: TEST_MSSQL.user,
      password: TEST_MSSQL.password,
      database: TEST_MSSQL.adminDatabase,
      options: { encrypt: false, trustServerCertificate: true },
    })
    await mssqlAdmin.connect()
  })
  afterAll(async () => {
    await admin?.end()
    await mssqlAdmin?.close()
  })
  afterEach(async () => {
    await h?.dispose()
  })

  it('connects to PostgreSQL with a dynamic user and revokes it on disconnect', async () => {
    h = createHarness()
    const saved = h.store.save(vaultInput('postgres', {}, { secrets: { vaultPassword: n.readerPassword } }))
    const server = await h.manager.connect(saved.id)
    const status = h.manager.vaultStatus(saved.id)
    expect(status).toMatchObject({ state: 'valid', info: { kind: 'dynamic', tokenSource: 'userpass', renewable: true, leaseDurationSec: 3600 } })
    const username = status?.info?.username ?? ''
    expect(username).toMatch(/^v-/)
    expect(server.currentUser).toBe(username)
    expect(await pgRoleExists(username)).toBe(true)

    const session = await h.manager.openSession({ connectionId: saved.id })
    expect(await scalar(h.manager, session.sessionId, 'SELECT current_user')).toBe(username)
    expect(Number(await scalar(h.manager, session.sessionId, 'SELECT count(*) FROM sales.orders'))).toBeGreaterThan(0)
    const page = await h.manager.fetchTableData({ table: { connectionId: saved.id, database: TEST_PG.database, schema: 'public', name: 'customers' }, offset: 0, limit: 5 })
    expect(page.rows.length).toBeGreaterThan(0)

    await h.manager.disconnect(saved.id)
    expect(await pgRoleExists(username)).toBe(false)
  })

  it('connects to SQL Server with a dynamic login and revokes it on disconnect', async () => {
    h = createHarness()
    const saved = h.store.save(vaultInput('mssql', {}, { secrets: { vaultPassword: n.readerPassword } }))
    await h.manager.connect(saved.id)
    const username = h.manager.vaultStatus(saved.id)?.info?.username ?? ''
    expect(username).toMatch(/^v-/)
    const session = await h.manager.openSession({ connectionId: saved.id })
    expect(await scalar(h.manager, session.sessionId, 'SELECT SUSER_NAME()')).toBe(username)
    expect(Number(await scalar(h.manager, session.sessionId, 'SELECT COUNT(*) FROM sales.orders'))).toBeGreaterThan(0)
    expect(await mssqlLoginExists(username)).toBe(true)
    await h.manager.disconnect(saved.id)
    expect(await mssqlLoginExists(username)).toBe(false)
  })

  it('reads static credentials from KV v2', async () => {
    h = createHarness()
    const saved = h.store.save(vaultInput('postgres', { secretPath: `${n.kvMount}/data/pg` }, { secrets: { vaultPassword: n.readerPassword } }))
    const server = await h.manager.connect(saved.id)
    expect(server.currentUser).toBe(TEST_PG.user)
    expect(h.manager.vaultStatus(saved.id)).toMatchObject({ state: 'valid', info: { kind: 'static', username: TEST_PG.user } })
  })

  it('logs in with a token: asks for it (vaultToken), then uses and remembers the typed one', async () => {
    h = createHarness()
    const saved = h.store.save(vaultInput('postgres', { loginMethod: 'token', authMount: undefined, username: undefined }))
    await expect(h.manager.connect(saved.id)).rejects.toMatchObject({
      info: { kind: 'needs-password', secretField: 'vaultToken', message: `Vault token required for ${TEST_VAULT.address}` },
    })
    const token = await readerToken()
    const server = await h.manager.connect(saved.id, { vaultToken: token })
    expect(h.manager.vaultStatus(saved.id)?.info).toMatchObject({ tokenSource: 'stored', username: server.currentUser })
    expect(h.store.get(saved.id)?.hasVaultSecret).toBe(true)
  })

  it('asks for the Vault password (vaultPassword) when none is stored', async () => {
    h = createHarness()
    const saved = h.store.save(vaultInput('postgres', {}, { savePassword: false }))
    await expect(h.manager.connect(saved.id)).rejects.toMatchObject({ info: { kind: 'needs-password', secretField: 'vaultPassword' } })
    await expect(h.manager.connect(saved.id, { vaultPassword: 'wrong-password' })).rejects.toMatchObject({
      info: { kind: 'needs-password', secretField: 'vaultPassword' },
    })
    const server = await h.manager.connect(saved.id, { vaultPassword: n.readerPassword })
    expect(server.currentUser).toMatch(/^v-/)
    expect(h.store.get(saved.id)?.hasVaultSecret).toBe(false) // in memory only (savePassword false)
  })

  it('maps a policy denial to a clear Vault error', async () => {
    h = createHarness()
    const saved = h.store.save(vaultInput('postgres', { username: n.deniedUser }, { secrets: { vaultPassword: n.deniedPassword } }))
    await expect(h.manager.connect(saved.id)).rejects.toMatchObject({
      info: { kind: 'vault', code: '403', message: `Vault: permission denied on ${n.dbMount}/creds/${n.pgRole} (403)` },
    })
    expect(h.manager.isConnected(saved.id)).toBe(false)
  })

  it('vault:test and connections:test revoke the lease they create', async () => {
    h = createHarness()
    const input = vaultInput('postgres', {}, { secrets: { vaultPassword: n.readerPassword } })
    const vt = await h.manager.vaultTest(input)
    expect(vt).toMatchObject({ ok: true, info: { kind: 'dynamic', tokenSource: 'userpass' } })
    expect(await pgRoleExists(vt.info?.username ?? '')).toBe(false)

    const ct = await h.manager.test(input)
    expect(ct.ok).toBe(true)
    expect(ct.info?.currentUser).toMatch(/^v-/)
    expect(await pgRoleExists(ct.info?.currentUser ?? '')).toBe(false)

    const mssql = await h.manager.test(vaultInput('mssql', {}, { secrets: { vaultPassword: n.readerPassword } }))
    expect(mssql.ok).toBe(true)
    expect(await mssqlLoginExists(mssql.info?.currentUser ?? '')).toBe(false)
  })
})
