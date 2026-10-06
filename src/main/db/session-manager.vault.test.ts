// Session manager × HashiCorp Vault: a fake Vault server and a fake driver that checks the credentials it gets.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcEventName, IpcEvents } from '@shared/ipc'
import type { ConnectionInput, ServerInfo, TransactionState, VaultConfig } from '@shared/types'
import { ConnectionStore } from '../store/connections'
import { SecretStore } from '../store/secrets'
import { VaultService } from '../vault/service'
import { dynamicCreds, FakeVault, freePort, loginReply, lookupSelf } from '../vault/testing/fake-vault'
import { DriverError } from './errors'
import { LEASE_ENDED_REASON, SessionManager } from './session-manager'
import type { DbDriver, DriverSession, MetadataProvider, ResolvedConnection } from './types'

const quiet = { warn: () => undefined, error: () => undefined }
const crypto = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`enc:${s}`, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8').slice(4),
}

function info(user: string, database = 'app'): ServerInfo {
  return { dialect: 'postgres', version: 'PostgreSQL 16', versionShort: '16', currentDatabase: database, currentUser: user }
}

interface Opened {
  kind: 'metadata' | 'session' | 'test'
  user: string
  password: string | undefined
  database?: string
}

class FakeSession implements DriverSession {
  readonly dialect = 'postgres' as const
  schema = 'public'
  closed = false
  tx: TransactionState = { autoCommit: true, inTransaction: false }
  constructor(
    readonly database: string,
    readonly user: string,
  ) {}
  serverInfo = async () => info(this.user, this.database)
  execute = async () => ({ results: [], messages: [], cancelled: false })
  fetchMore = async () => ({ rows: [], hasMore: false })
  cancel = async () => undefined
  transactionState = () => this.tx
  setAutoCommit = async (autoCommit: boolean) => (this.tx = { autoCommit, inTransaction: false })
  commit = async () => this.tx
  rollback = async () => this.tx
  setSchema = async (schema: string) => void (this.schema = schema)
  useDatabase = async () => false
  explain = async () => ({ format: 'postgres-json' as const, raw: '[]', root: null })
  setReadOnly = async () => undefined
  close = async () => void (this.closed = true)
  onUnexpectedClose = () => undefined
}

function fakeDriver(accepts: (user: string, password: string | undefined) => boolean, alive: (user: string) => boolean = () => true) {
  const opened: Opened[] = []
  const metadata: { user: string; closed: boolean }[] = []
  const sessions: FakeSession[] = []
  const check = (c: ResolvedConnection, kind: Opened['kind'], database?: string) => {
    opened.push({ kind, user: c.config.user, password: c.secrets.password, ...(database ? { database } : {}) })
    if (!accepts(c.config.user, c.secrets.password)) {
      throw DriverError.of('database', `password authentication failed for user "${c.config.user}"`, { code: '28P01' })
    }
  }
  const driver: DbDriver = {
    dialect: 'postgres',
    test: async (c) => {
      check(c, 'test')
      return info(c.config.user)
    },
    openMetadata: async (c) => {
      check(c, 'metadata')
      const record = { user: c.config.user, closed: false }
      metadata.push(record)
      const provider: Partial<MetadataProvider> = {
        serverInfo: async () => info(record.user),
        // A pool connects lazily: once Vault dropped the user, new pooled connections are refused.
        listDatabases: async () => {
          if (!alive(record.user)) throw DriverError.of('database', `password authentication failed for user "${record.user}"`, { code: '28P01' })
          return [{ name: 'app', isSystem: false }]
        },
        close: async () => void (record.closed = true),
      }
      return provider as MetadataProvider
    },
    openSession: async (c, database) => {
      check(c, 'session', database)
      const session = new FakeSession(database, c.config.user)
      sessions.push(session)
      return session
    },
  }
  return { driver, opened, metadata, sessions }
}

describe('SessionManager with HashiCorp Vault', () => {
  let dir: string
  let vault: FakeVault
  let store: ConnectionStore
  let service: VaultService
  let manager: SessionManager
  let fake: ReturnType<typeof fakeDriver>
  let liveUsers: Set<string>
  let rejectOnce: Set<string>
  let events: { event: IpcEventName; payload: unknown }[]
  let issued: number

  const vaultConfig = (patch: Partial<VaultConfig> = {}): VaultConfig => ({
    address: vault.address,
    loginMethod: 'userpass',
    username: 'alice',
    secretPath: 'database/creds/ro',
    ...patch,
  })
  const input = (patch: Partial<ConnectionInput> = {}): ConnectionInput => ({
    name: 'PGSQL - Analytics',
    dialect: 'postgres',
    host: 'pg-analytics.example.cloud',
    port: 5432,
    database: 'warehouse',
    user: '',
    savePassword: true,
    ssl: { mode: 'disable' },
    ssh: { enabled: false, host: '', port: 22, username: '', authMethod: 'password' },
    color: 'red',
    readOnly: false,
    productionGuard: true,
    options: {},
    authMode: 'vault',
    vault: vaultConfig(),
    ...patch,
  })

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'dg-sm-vault-'))
    vault = await FakeVault.start()
    issued = 0
    liveUsers = new Set()
    rejectOnce = new Set()
    events = []
    vault.on('POST', 'auth/userpass/login/alice', (req) => (req.body?.password === 'alice-pw' ? loginReply('tok-alice') : { status: 400, body: { errors: ['invalid username or password'] } }))
    vault.on('GET', 'auth/token/lookup-self', lookupSelf())
    vault.on('GET', 'database/creds/ro', () => {
      issued++
      liveUsers.add(`v-ro-${issued}`)
      return dynamicCreds(`v-ro-${issued}`, `db-pw-${issued}`, `database/creds/ro/l${issued}`, 3600)
    })
    vault.on('PUT', 'sys/leases/revoke', (req) => {
      const id = String(req.body?.lease_id ?? '')
      liveUsers.delete(`v-ro-${id.split('/l').pop()}`)
      return { status: 204 }
    })
    store = new ConnectionStore(dir, new SecretStore(dir, crypto, quiet), { log: quiet })
    service = new VaultService({ log: quiet, revokeTimeoutMs: 500, onStatus: (status) => events.push({ event: 'event:vaultStatus', payload: status }) })
    fake = fakeDriver(
      (user, password) => {
        if (rejectOnce.delete(user)) return false
        return liveUsers.has(user) && password === `db-pw-${user.split('-').pop()}`
      },
      (user) => liveUsers.has(user),
    )
    manager = new SessionManager({
      connections: store,
      drivers: () => fake.driver,
      history: { add: () => undefined },
      emit: <E extends IpcEventName>(event: E, payload: IpcEvents[E]) => void events.push({ event, payload }),
      openTunnel: async () => {
        throw new Error('no tunnel')
      },
      vault: service,
      vaultRetryDelayMs: 5,
      log: quiet,
    })
  })

  afterEach(async () => {
    await manager.shutdown()
    await service.dispose()
    await vault.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('connects with Vault-issued credentials, never asking for a database password', async () => {
    const saved = store.save(input({ secrets: { vaultPassword: 'alice-pw' } }))
    expect(saved.hasPassword).toBe(false)
    expect(saved.hasVaultSecret).toBe(true)
    const server = await manager.connect(saved.id)
    expect(server.currentUser).toBe('v-ro-1')
    expect(fake.opened).toEqual([{ kind: 'metadata', user: 'v-ro-1', password: 'db-pw-1' }])
    expect(manager.vaultStatus(saved.id)).toMatchObject({ state: 'valid', info: { username: 'v-ro-1', kind: 'dynamic', tokenSource: 'userpass' } })
    expect(events.some((e) => e.event === 'event:vaultStatus')).toBe(true)
    // Nothing secret reaches the renderer-bound events.
    expect(JSON.stringify(events)).not.toMatch(/db-pw|alice-pw|tok-alice/)
  })

  it('retries once when the database rejects freshly issued credentials', async () => {
    const saved = store.save(input({ secrets: { vaultPassword: 'alice-pw' } }))
    rejectOnce.add('v-ro-1')
    await manager.connect(saved.id)
    expect(fake.opened.map((o) => o.user)).toEqual(['v-ro-1', 'v-ro-1'])
  })

  it('asks for the Vault password (vaultPassword) and remembers it per savePassword', async () => {
    const saved = store.save(input({ savePassword: false }))
    await expect(manager.connect(saved.id)).rejects.toMatchObject({ info: { kind: 'needs-password', secretField: 'vaultPassword' } })
    await expect(manager.connect(saved.id, { vaultPassword: 'wrong-pw' })).rejects.toMatchObject({
      info: { kind: 'needs-password', secretField: 'vaultPassword', message: `Vault rejected the password for alice on ${vault.address}` },
    })
    await manager.connect(saved.id, { vaultPassword: 'alice-pw' })
    expect(store.secrets(saved.id).vaultPassword).toBe('alice-pw') // cached for this run
    expect(store.get(saved.id)?.hasVaultSecret).toBe(false) // not on disk (savePassword false)
    await manager.disconnect(saved.id)

    // A cached password Vault rejects is forgotten (the next connect prompts again).
    service.logout(vault.address)
    store.rememberSecrets(saved.id, { vaultPassword: 'stale-pw' })
    await expect(manager.connect(saved.id)).rejects.toMatchObject({ info: { kind: 'needs-password' } })
    expect(store.secrets(saved.id).vaultPassword).toBeUndefined()
  })

  it('opens sessions with the current credentials and switches the metadata pool on refresh', async () => {
    const saved = store.save(input({ secrets: { vaultPassword: 'alice-pw' } }))
    await manager.connect(saved.id)
    const s1 = await manager.openSession({ connectionId: saved.id })
    expect(fake.sessions[0].user).toBe('v-ro-1')

    const status = await manager.vaultRefresh(saved.id)
    expect(status).toMatchObject({ state: 'valid', info: { username: 'v-ro-2' } })
    expect(fake.metadata.map((m) => [m.user, m.closed])).toEqual([
      ['v-ro-1', true],
      ['v-ro-2', false],
    ])
    // The console opened before keeps its server connection (and lease); new consoles use the new user.
    expect(liveUsers.has('v-ro-1')).toBe(true)
    await manager.openSession({ connectionId: saved.id })
    expect(fake.sessions[1].user).toBe('v-ro-2')

    // PostgreSQL database switch reconnects the console with the current credentials.
    await manager.setDatabase(s1.sessionId, 'other')
    expect(fake.sessions[2]).toMatchObject({ user: 'v-ro-2', database: 'other' })
    await vi.waitFor(() => expect(liveUsers.has('v-ro-1')).toBe(false)) // nothing uses the old lease any more

    await manager.disconnect(saved.id)
    expect(liveUsers.size).toBe(0)
    expect(manager.vaultStatus(saved.id)).toBeNull()
  })

  it('revokes leases on disconnect, delete-style teardown and shutdown', async () => {
    const a = store.save(input({ secrets: { vaultPassword: 'alice-pw' } }))
    const b = store.save(input({ name: 'B', secrets: { vaultPassword: 'alice-pw' } }))
    const keep = store.save(input({ name: 'Keep', vault: vaultConfig({ revokeOnDisconnect: false }), secrets: { vaultPassword: 'alice-pw' } }))
    await manager.connect(a.id)
    await manager.connect(b.id)
    await manager.connect(keep.id)
    expect(liveUsers.size).toBe(3)
    await manager.disconnect(a.id)
    expect(liveUsers.has('v-ro-1')).toBe(false)
    await manager.shutdown()
    expect([...liveUsers]).toEqual(['v-ro-3'])
  })

  it('connections:test logs in, tests with issued credentials and revokes the test lease', async () => {
    const result = await manager.test(input({ secrets: { vaultPassword: 'alice-pw' } }))
    expect(result).toMatchObject({ ok: true, info: { currentUser: 'v-ro-1' } })
    expect(fake.opened).toEqual([{ kind: 'test', user: 'v-ro-1', password: 'db-pw-1' }])
    expect(liveUsers.size).toBe(0)
  })

  it('sends a stored Vault secret only to the same Vault identity', async () => {
    const saved = store.save(input({ secrets: { vaultPassword: 'alice-pw' } }))
    service.logout(vault.address)
    const other = await FakeVault.start()
    try {
      other.on('POST', 'auth/userpass/login/alice', (req) => (req.body?.password ? loginReply('x') : { status: 400 }))
      const moved = await manager.test({ ...input({ vault: vaultConfig({ address: other.address }) }), id: saved.id })
      expect(moved.error).toMatchObject({ kind: 'needs-password', secretField: 'vaultPassword' })
      expect(other.requests).toHaveLength(0)
      const vt = await manager.vaultTest({ ...input({ vault: vaultConfig({ address: other.address }) }), id: saved.id })
      expect(vt.error).toMatchObject({ kind: 'needs-password' })
      expect(other.requests).toHaveLength(0)
      // Same identity: the stored password is used.
      const same = await manager.vaultTest({ ...input(), id: saved.id })
      expect(same).toMatchObject({ ok: true, info: { username: 'v-ro-1' } })
      expect(liveUsers.size).toBe(0)
    } finally {
      await other.close()
    }
  })

  it('vault:status is null for disconnected or password connections; refresh connects when needed', async () => {
    const pw = store.save(input({ authMode: 'password', user: 'me', secrets: { password: 'x' } }))
    expect(manager.vaultStatus(pw.id)).toBeNull()
    await expect(manager.vaultRefresh(pw.id)).rejects.toMatchObject({ info: { kind: 'invalid-input' } })
    const saved = store.save(input({ secrets: { vaultPassword: 'alice-pw' } }))
    expect(manager.vaultStatus(saved.id)).toBeNull()
    const status = await manager.vaultRefresh(saved.id)
    expect(status.info?.username).toBe('v-ro-1')
    expect(manager.isConnected(saved.id)).toBe(true)
  })

  it('reconnects when the Vault settings change', async () => {
    const saved = store.save(input({ secrets: { vaultPassword: 'alice-pw' } }))
    await manager.connect(saved.id)
    const before = store.get(saved.id)
    const after = store.save({ ...input({ vault: vaultConfig({ secretPath: 'database/creds/rw' }) }), id: saved.id })
    await manager.connectionSaved(before, after, false)
    expect(manager.isConnected(saved.id)).toBe(false)
    expect(liveUsers.size).toBe(0)
  })

  it('refreshes expired credentials before opening a console', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const saved = store.save(input({ secrets: { vaultPassword: 'alice-pw' } }))
      await manager.connect(saved.id)
      vi.setSystemTime(Date.now() + 3_600_000) // lease expired (timer did not get a chance: machine asleep)
      // Two consoles opened at once share one refresh.
      await Promise.all([manager.openSession({ connectionId: saved.id }), manager.openSession({ connectionId: saved.id })])
      expect(fake.sessions.map((s) => s.user)).toEqual(['v-ro-2', 'v-ro-2'])
      expect(fake.metadata.at(-1)?.user).toBe('v-ro-2')
      expect(issued).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports incomplete Vault settings and a missing Vault service', async () => {
    const saved = store.save(input({ secrets: { vaultPassword: 'alice-pw' } }))
    const broken = { ...store.get(saved.id)!, vault: { address: 'vault.example.cloud', loginMethod: 'token' as const, secretPath: '' } }
    const source = { ...store, get: () => broken, secrets: () => ({}) } as unknown as ConnectionStore
    const m1 = new SessionManager({ connections: source, drivers: () => fake.driver, history: { add: () => undefined }, emit: () => undefined, openTunnel: async () => Promise.reject(new Error('x')), vault: service, log: quiet })
    await expect(m1.connect(saved.id)).rejects.toMatchObject({ info: { kind: 'invalid-input' } })
    const m2 = new SessionManager({ connections: store, drivers: () => fake.driver, history: { add: () => undefined }, emit: () => undefined, openTunnel: async () => Promise.reject(new Error('x')), log: quiet })
    await expect(m2.connect(saved.id)).rejects.toMatchObject({ info: { kind: 'internal', message: 'HashiCorp Vault support is not available.' } })
    expect(await m2.vaultTest(input())).toMatchObject({ ok: false })
  })
  it('keeps the explorer working after the machine slept past the lease expiry (wall-clock check)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const saved = store.save(input({ secrets: { vaultPassword: 'alice-pw' } }))
      await manager.connect(saved.id)
      await expect(manager.databases(saved.id)).resolves.toHaveLength(1)
      // Lid closed for 8 h: the renewal timer (monotonic clock) has not fired, Vault dropped the expired user.
      vi.setSystemTime(Date.now() + 8 * 3_600_000)
      liveUsers.delete('v-ro-1')
      await expect(manager.databases(saved.id)).resolves.toHaveLength(1)
      expect(fake.metadata.at(-1)?.user).toBe('v-ro-2')
      expect(manager.vaultStatus(saved.id)).toMatchObject({ state: 'valid', info: { username: 'v-ro-2' } })
      // resync() (powerMonitor 'resume') re-arms the timers from the wall clock without failing.
      service.resync()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads the credentials again when the database refuses them (user dropped / password rotated out of band)', async () => {
    const saved = store.save(input({ secrets: { vaultPassword: 'alice-pw' } }))
    await manager.connect(saved.id)
    liveUsers.delete('v-ro-1') // e.g. an admin revoked the lease
    await manager.openSession({ connectionId: saved.id })
    expect(fake.sessions.map((x) => x.user)).toEqual(['v-ro-2'])
    liveUsers.delete('v-ro-2')
    await expect(manager.databases(saved.id)).resolves.toHaveLength(1)
    expect(manager.vaultStatus(saved.id)?.info?.username).toBe('v-ro-3')
  })

  it('moves idle consoles off a superseded lease before it ends; a console in a transaction is closed and reported', { timeout: 15_000 }, async () => {
    // 3 s lease that cannot be renewed: re-issued 1 s before expiry, the superseded lease ends 1 s later.
    vault.on('GET', 'database/creds/short', () => {
      issued++
      liveUsers.add(`v-ro-${issued}`)
      return dynamicCreds(`v-ro-${issued}`, `db-pw-${issued}`, `database/creds/short/l${issued}`, 3, false)
    })
    const saved = store.save(input({ vault: vaultConfig({ secretPath: 'database/creds/short' }), secrets: { vaultPassword: 'alice-pw' } }))
    await manager.connect(saved.id)
    const idle = await manager.openSession({ connectionId: saved.id })
    await manager.setSchema(idle.sessionId, 'sales')
    await manager.setAutoCommit(idle.sessionId, false)
    const busyTx = await manager.openSession({ connectionId: saved.id })
    const tx = fake.sessions[1]
    tx.tx = { autoCommit: false, inTransaction: true }

    await vi.waitFor(() => expect(manager.vaultStatus(saved.id)?.info?.username).toBe('v-ro-2'), { timeout: 5_000, interval: 50 })
    await vi.waitFor(() => expect(manager.sessionInfo(idle.sessionId)).toMatchObject({ schema: 'sales', transaction: { autoCommit: false } }), { timeout: 3_000, interval: 50 })
    await vi.waitFor(() => expect(fake.sessions.some((x) => x.user === 'v-ro-2' && !x.closed)).toBe(true), { timeout: 3_000, interval: 50 })
    const moved = fake.sessions.find((x) => x.user === 'v-ro-2' && !x.closed)
    expect(moved).toMatchObject({ database: 'warehouse', schema: 'sales' })
    expect(fake.sessions[0].closed).toBe(true)
    await vi.waitFor(() =>
      expect(events).toContainEqual({ event: 'event:sessionClosed', payload: { sessionId: busyTx.sessionId, connectionId: saved.id, reason: LEASE_ENDED_REASON } }),
    )
    expect(tx.closed).toBe(true)
    expect(() => manager.sessionInfo(busyTx.sessionId)).toThrow(/closed/)
    await vi.waitFor(() => expect(liveUsers.has('v-ro-1')).toBe(false)) // nothing holds the first lease any more
  })

  it('a console busy with a statement when its lease ends is moved once the statement finishes', async () => {
    const saved = store.save(input({ secrets: { vaultPassword: 'alice-pw' } }))
    await manager.connect(saved.id)
    const s1 = await manager.openSession({ connectionId: saved.id })
    let finish: () => void = () => undefined
    fake.sessions[0].execute = () => new Promise((resolve) => (finish = () => resolve({ results: [], messages: [], cancelled: false })))
    const running = manager.execute(s1.sessionId, 'SELECT pg_sleep(60)', { maxRows: 10 })
    await manager.vaultRefresh(saved.id)
    const retire = (manager as unknown as { retireVaultLease: (id: string, key: string) => Promise<void> }).retireVaultLease.bind(manager)
    const firstLease = (manager as unknown as { sessions: Map<string, { lease?: { key: string } }> }).sessions.get(s1.sessionId)?.lease?.key ?? ''
    await retire(saved.id, firstLease)
    expect(fake.sessions).toHaveLength(1) // not swapped under the running statement
    finish()
    await running
    await vi.waitFor(() => expect(fake.sessions.map((x) => [x.user, x.closed])).toEqual([['v-ro-1', true], ['v-ro-2', false]]))
    expect(manager.sessionInfo(s1.sessionId).connectionId).toBe(saved.id)
  })

  it('disconnect during a pending OIDC sign-in returns at once and abandons the sign-in', { timeout: 15_000 }, async () => {
    vault.on('POST', 'auth/oidc/oidc/auth_url', { body: { data: { auth_url: 'https://idp.example.cloud/authorize?state=st-1&redirect_uri=x' } } })
    const logins: string[] = []
    const oidcService = new VaultService({
      log: quiet,
      oidcPort: await freePort(),
      oidcTimeoutMs: 8_000,
      openExternal: async () => undefined,
      onLogin: (e) => void logins.push(e.state),
      env: () => ({}),
      homeDir: () => dir,
    })
    const oidcManager = new SessionManager({ connections: store, drivers: () => fake.driver, history: { add: () => undefined }, emit: () => undefined, openTunnel: async () => Promise.reject(new Error('x')), vault: oidcService, log: quiet })
    try {
      const saved = store.save(input({ savePassword: false, vault: { address: vault.address, loginMethod: 'oidc', secretPath: 'database/creds/ro' } }))
      const connecting = oidcManager.connect(saved.id).catch((e: unknown) => e)
      await vi.waitFor(() => expect(logins).toContain('browser-opened'))
      const started = Date.now()
      await oidcManager.disconnect(saved.id) // "Disconnect" / connections:delete
      expect(Date.now() - started).toBeLessThan(1_000)
      expect(await connecting).toMatchObject({ info: { kind: 'cancelled' } })
      await vi.waitFor(() => expect(logins).toContain('cancelled'))
    } finally {
      await oidcManager.shutdown()
      await oidcService.dispose()
    }
  })

  it('revokes the leases on quit although closing the database outlasts the shutdown timeout', async () => {
    let release: () => void = () => undefined
    const slowClose = new Promise<void>((resolve) => (release = resolve))
    const slow: DbDriver = {
      ...fake.driver,
      openMetadata: async (c) => {
        const provider = await fake.driver.openMetadata(c)
        return { ...provider, close: () => slowClose } as MetadataProvider
      },
    }
    const quitService = new VaultService({ log: quiet, revokeTimeoutMs: 500 })
    const quitManager = new SessionManager({ connections: store, drivers: () => slow, history: { add: () => undefined }, emit: () => undefined, openTunnel: async () => Promise.reject(new Error('x')), vault: quitService, vaultRetryDelayMs: 5, log: quiet })
    try {
      const saved = store.save(input({ secrets: { vaultPassword: 'alice-pw' } }))
      await quitManager.connect(saved.id)
      // src/main/index.ts before-quit: shutdown(3000), then dispose(), then app.quit().
      await quitManager.shutdown(100)
      await quitService.dispose()
      expect(vault.calls('PUT', 'sys/leases/revoke').map((r) => r.body?.lease_id)).toContain('database/creds/ro/l1')
    } finally {
      release()
    }
  })

  it('never sends a saved Vault password to another Vault after the connection was edited', async () => {
    const attacker = await FakeVault.start()
    try {
      attacker.on('POST', 'auth/userpass/login/alice', loginReply('x'))
      const saved = store.save(input({ secrets: { vaultPassword: 'alice-pw' } }))
      expect(store.get(saved.id)?.hasVaultSecret).toBe(true)
      // The dialog only sends the secrets the user typed: changing the address keeps none.
      store.save({ ...input({ vault: vaultConfig({ address: attacker.address }) }), id: saved.id })
      expect(store.get(saved.id)?.hasVaultSecret).toBe(false)
      await expect(manager.connect(saved.id)).rejects.toMatchObject({ info: { kind: 'needs-password', secretField: 'vaultPassword' } })
      expect(attacker.requests).toHaveLength(0)
    } finally {
      await attacker.close()
    }
  })

  it('never sends the Vault CLI token to an address VAULT_ADDR does not name', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dg-sm-vault-home-'))
    const attacker = await FakeVault.start()
    const cliService = new VaultService({ log: quiet, homeDir: () => home, env: () => ({ VAULT_ADDR: vault.address }) })
    const cliManager = new SessionManager({ connections: store, drivers: () => fake.driver, history: { add: () => undefined }, emit: () => undefined, openTunnel: async () => Promise.reject(new Error('x')), vault: cliService, log: quiet })
    try {
      writeFileSync(join(home, '.vault-token'), 'hvs.CLI-TOKEN-OF-THE-USER')
      for (const v of [vault, attacker]) {
        v.on('GET', 'database/creds/ro', dynamicCreds('v-cli', 'db-pw-cli', 'database/creds/ro/cli'))
        v.on('PUT', 'sys/leases/revoke', { status: 204 })
      }
      const tokenInput = input({ vault: { address: attacker.address, loginMethod: 'token', secretPath: 'database/creds/ro' } })
      expect(await cliManager.vaultTest(tokenInput)).toMatchObject({ ok: false, error: { kind: 'needs-password', secretField: 'vaultToken' } })
      expect(attacker.requests.map((r) => r.token)).not.toContain('hvs.CLI-TOKEN-OF-THE-USER')
      // The VAULT_ADDR server does get it.
      const ok = await cliManager.vaultTest(input({ vault: { address: vault.address, loginMethod: 'token', secretPath: 'database/creds/ro' } }))
      expect(ok).toMatchObject({ ok: true, info: { tokenSource: 'cli' } })
    } finally {
      await cliManager.shutdown()
      await cliService.dispose()
      await attacker.close()
      rmSync(home, { recursive: true, force: true })
    }
  })
})
