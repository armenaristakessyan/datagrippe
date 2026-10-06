// Lease lifecycle against the dev Vault: a role with default_ttl 8 s / max_ttl 20 s is renewed, then reaches
// its max TTL, and new credentials are issued before expiry: the metadata pool switches to the new user,
// consoles opened earlier keep theirs, the old user is revoked once unused.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ConnectionInput, VaultStatus } from '@shared/types'
import { getDriver } from '../../src/main/db/drivers'
import { SessionManager } from '../../src/main/db/session-manager'
import { openTunnel } from '../../src/main/db/tunnel'
import { ConnectionStore } from '../../src/main/store/connections'
import { HistoryStore } from '../../src/main/store/history'
import { SecretStore } from '../../src/main/store/secrets'
import { VaultService } from '../../src/main/vault/service'
import { vaultAvailable, vaultNames } from '../setup/vault'
import { TEST_PG, TEST_VAULT } from '../test-env'

const available = await vaultAvailable()
const n = vaultNames()
const quiet = { warn: () => undefined, error: () => undefined }
const crypto = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(s, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8'),
}

function input(): ConnectionInput {
  return {
    name: 'Vault short TTL',
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
    options: { applicationName: 'dg-vault-renewal' },
    authMode: 'vault',
    vault: {
      address: TEST_VAULT.address,
      loginMethod: 'userpass',
      authMount: n.userpassMount,
      username: n.readerUser,
      secretPath: `${n.dbMount}/creds/${n.pgShortRole}`,
    },
    secrets: { vaultPassword: n.readerPassword },
  }
}

describe.skipIf(!available)('Vault lease renewal and re-issue (dev server)', () => {
  let admin: pg.Client
  let dir: string
  let home: string
  let manager: SessionManager
  let vault: VaultService
  const statuses: VaultStatus[] = []

  beforeAll(async () => {
    admin = new pg.Client({ host: TEST_PG.host, port: TEST_PG.port, user: TEST_PG.user, password: TEST_PG.password, database: TEST_PG.database })
    await admin.connect()
  })
  afterAll(async () => {
    await admin?.end()
  })
  afterEach(async () => {
    await manager?.shutdown()
    await vault?.dispose()
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })

  const roleExists = async (name: string) => ((await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name])).rowCount ?? 0) > 0
  const activeUsers = async () =>
    (
      await admin.query<{ usename: string }>(
        "SELECT DISTINCT usename FROM pg_stat_activity WHERE datname = $1 AND application_name = 'dg-vault-renewal' ORDER BY 1",
        [TEST_PG.database],
      )
    ).rows.map((r) => r.usename)

  it('renews, re-issues before max TTL and switches the metadata pool to the new user', { timeout: 60_000 }, async () => {
    dir = mkdtempSync(join(tmpdir(), 'dg-vault-renew-'))
    home = mkdtempSync(join(tmpdir(), 'dg-vault-home-'))
    const store = new ConnectionStore(dir, new SecretStore(dir, crypto, quiet), { log: quiet })
    vault = new VaultService({ env: () => ({}), homeDir: () => home, onStatus: (s) => statuses.push(s), log: quiet })
    manager = new SessionManager({
      connections: store,
      drivers: getDriver,
      history: new HistoryStore(dir, { debounceMs: 0, log: quiet }),
      emit: () => undefined,
      openTunnel: (config, secrets) => openTunnel(config, secrets),
      vault,
      log: quiet,
    })
    const saved = store.save(input())
    await manager.connect(saved.id)
    const first = manager.vaultStatus(saved.id)?.info?.username ?? ''
    expect(first).toMatch(/^v-/)
    expect(manager.vaultStatus(saved.id)?.info?.leaseDurationSec).toBe(8)
    // A console opened on the first credentials.
    const early = await manager.openSession({ connectionId: saved.id })
    expect((await manager.execute(early.sessionId, 'SELECT current_user', { maxRows: 1 })).results[0].rows[0][0]).toBe(first)

    // ~5.3 s: renewed (8 s again); ~16 s: capped by max_ttl → expiring; ~19 s: re-issued.
    await vi.waitFor(() => expect(statuses.map((s) => s.state)).toContain('renewing'), { timeout: 10_000, interval: 200 })
    await vi.waitFor(() => expect(statuses.map((s) => s.state)).toContain('expiring'), { timeout: 20_000, interval: 200 })
    await vi.waitFor(
      () => {
        const info = manager.vaultStatus(saved.id)?.info
        expect(info?.username).toBeDefined()
        expect(info?.username).not.toBe(first)
      },
      { timeout: 20_000, interval: 200 },
    )
    const second = manager.vaultStatus(saved.id)?.info?.username ?? ''
    expect(manager.vaultStatus(saved.id)?.state).toBe('valid')
    expect(statuses.some((s) => s.state === 'expiring' && /maximum TTL/.test(s.message ?? ''))).toBe(true)

    // The metadata pool now logs in as the new user, and so do new consoles. (Vault drops the first user at its
    // max TTL, a second after the re-issue: the idle early console is moved to the new user just before.)
    await manager.databases(saved.id)
    const late = await manager.openSession({ connectionId: saved.id })
    const who = async (sessionId: string) => (await manager.execute(sessionId, 'SELECT current_user', { maxRows: 1 })).results[0].rows[0][0]
    expect(await who(late.sessionId)).toBe(second)
    expect(await activeUsers()).toContain(second)
    expect(manager.sessionInfo(early.sessionId).connectionId).toBe(saved.id)

    expect(await who(early.sessionId)).toBe(second)
    // Once the early console is closed, nothing runs as the first user and its role is gone.
    await manager.closeSession(early.sessionId)
    await vi.waitFor(async () => expect(await roleExists(first)).toBe(false), { timeout: 10_000, interval: 200 })
    expect(await activeUsers()).toEqual([second])

    await manager.disconnect(saved.id)
    expect(await roleExists(second)).toBe(false)
  })
})
