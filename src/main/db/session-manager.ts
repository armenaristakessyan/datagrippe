// Runtime orchestration of connections: SSH tunnels, metadata pools, console sessions, read-only
// enforcement, execution summaries and history. Drivers are only reached through this class.
import { randomUUID } from 'node:crypto'
import type { IpcEventName, IpcEvents } from '@shared/ipc'
import { classifyStatement, splitStatements } from '@shared/sql'
import { isSignificant, tokenize } from '@shared/sql/lexer'
import type {
  ApplyChangesResult,
  CompletionCatalog,
  ConnectionConfig,
  ConnectionInput,
  ConnectionSecrets,
  DatabaseInfo,
  DbObjectInfo,
  DdlRequest,
  ExecuteOptions,
  ExecutionResult,
  ExplainResult,
  FetchMoreResult,
  HistoryEntry,
  OpenSessionRequest,
  QueryMessage,
  RowChange,
  SchemaInfo,
  ServerInfo,
  SessionInfo,
  SetDatabaseOptions,
  TableDataPage,
  TableDataRequest,
  TableDetails,
  TableRef,
  TestConnectionResult,
  TransactionState,
  VaultConfig,
  VaultDiscoverRequest,
  VaultDiscoverResult,
  VaultDiscoverTarget,
  VaultStatus,
  VaultTestResult,
} from '@shared/types'
import { configForTest, type ConnectionSource } from '../store/connections'
import { historySql } from '../store/history'
import { sameVaultIdentity, validateVaultConfig } from '../vault/config'
import type { ActiveCredentials, VaultService } from '../vault/service'
import type { DriverRegistry } from './drivers'
import { DriverError, toErrorInfo } from './errors'
import { buildMessages } from './summary'
import type { Tunnel } from './tunnel'
import type { DbDriver, DriverExecuteResult, DriverSession, MetadataProvider, ResolvedConnection } from './types'

export type EmitFn = <E extends IpcEventName>(event: E, payload: IpcEvents[E]) => void

export interface SessionManagerDeps {
  connections: ConnectionSource
  drivers: DriverRegistry
  history: { add(entry: Omit<HistoryEntry, 'id'>): unknown }
  emit: EmitFn
  openTunnel: (config: ConnectionConfig, secrets: ConnectionSecrets) => Promise<Tunnel>
  /** HashiCorp Vault credentials (connections with authMode 'vault'). */
  vault?: VaultService
  /** Delay before retrying a database login with freshly issued Vault credentials (role propagation). Default 1000. */
  vaultRetryDelayMs?: number
  now?: () => number
  log?: Pick<Console, 'warn' | 'error'>
}

/** Lease holder id of a connection's metadata pool. */
const METADATA_HOLDER = 'metadata'
/** event:sessionClosed reason of a console whose Vault user is about to be dropped and that could not be moved. */
export const LEASE_ENDED_REASON = 'Vault credentials reached their maximum TTL: the temporary database user of this console is being dropped.'

interface ConnectionRuntime {
  id: string
  driver: DbDriver
  resolved: ResolvedConnection
  tunnel?: Tunnel
  metadata: MetadataProvider
  serverInfo: ServerInfo
  sessions: Set<string>
  /** Vault connections: lease of the credentials in `resolved` (used by the metadata pool and new sessions). */
  leaseKey?: string
}

interface SessionRecord {
  id: string
  connectionId: string
  driver: DriverSession
  /** Value last passed to driver.setReadOnly (re-applied when the connection flag changes). */
  readOnly: boolean
  closed: boolean
  /** Vault connections: lease of the credentials this server connection logged in with (and its holder id). */
  lease?: SessionLease
  /** Operations running on the driver (execute, explain, fetchMore): the server connection cannot be swapped. */
  busy: number
  /** Its lease ends: move it to the current credentials once idle. */
  retire?: boolean
}

interface SessionLease {
  key: string
  holder: string
}

const AUTH_ERROR_CODES = new Set(['28P01', '28000', 'ELOGIN', '18456'])
const SECRET_KEYS = ['password', 'sshPassword', 'sshPassphrase', 'vaultToken', 'vaultPassword'] as const
const MAX_ROWS_LIMIT = 100_000
/** Live server messages are sent to the renderer at most this often, and at most this many per run. */
const MESSAGE_FLUSH_MS = 100
const MAX_LIVE_MESSAGES = 1000

/** Driver failure caused by bad / missing credentials (pg 28P01/28000, mssql ELOGIN / 18456). */
export function isAuthenticationError(error: unknown): boolean {
  const info = error instanceof DriverError ? error.info : undefined
  if (info?.kind === 'needs-password') return true
  const raw = error as { code?: unknown; number?: unknown; message?: unknown } | null
  const codes = [info?.code, raw?.code, raw?.number].filter((c) => c !== undefined && c !== null).map(String)
  // SQL Server 4060 "Cannot open database … The login failed." is a wrong database, not a wrong password.
  if (codes.includes('4060')) return false
  if (codes.some((c) => AUTH_ERROR_CODES.has(c))) return true
  const message = info?.message ?? (typeof raw?.message === 'string' ? raw.message : '')
  return /password|login failed/i.test(message)
}

function definedSecrets(secrets: ConnectionSecrets | undefined): ConnectionSecrets {
  const out: ConnectionSecrets = {}
  if (!secrets) return out
  for (const key of SECRET_KEYS) {
    const value = secrets[key]
    if (typeof value === 'string') out[key] = value
  }
  return out
}

/** Secret patch semantics: undefined = keep, '' = clear, value = set. */
const MAX_DISCOVER_TARGETS = 500

/** Discovery targets as sent by the renderer: well-formed, bounded. */
function sanitizeDiscoverTargets(raw: unknown): VaultDiscoverTarget[] {
  if (!Array.isArray(raw)) throw DriverError.of('invalid-input', 'Invalid discovery targets.')
  const str = (value: unknown, max = 512) => (typeof value === 'string' ? value.slice(0, max) : '')
  return raw.slice(0, MAX_DISCOVER_TARGETS).flatMap((item): VaultDiscoverTarget[] => {
    if (!item || typeof item !== 'object') return []
    const t = item as Record<string, unknown>
    const key = str(t.key, 256)
    if (!key || (t.dialect !== 'postgres' && t.dialect !== 'mssql')) return []
    const target: VaultDiscoverTarget = { key, dialect: t.dialect, host: str(t.host), database: str(t.database), name: str(t.name) }
    const group = str(t.group)
    if (group) target.group = group
    return [target]
  })
}

function patchSecrets(base: ConnectionSecrets, patch: ConnectionSecrets | undefined): ConnectionSecrets {
  const out: ConnectionSecrets = { ...base }
  for (const key of SECRET_KEYS) {
    const value = patch?.[key]
    if (value === undefined) continue
    if (value === '') delete out[key]
    else out[key] = value
  }
  return out
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** The stored password was rejected (as opposed to a missing database, a locked account…). */
export function isWrongPassword(error: unknown): boolean {
  const info = error instanceof DriverError ? error.info : undefined
  const raw = error as { code?: unknown; number?: unknown; message?: unknown } | null
  const codes = [info?.code, raw?.code, raw?.number].filter((c) => c !== undefined && c !== null).map(String)
  if (codes.includes('28P01') || codes.includes('18456')) return true
  const message = info?.message ?? (typeof raw?.message === 'string' ? raw.message : '')
  return /password authentication failed|login failed for user/i.test(message)
}

const lower = (value: string | undefined) => (value ?? '').trim().toLowerCase()

/** Same database server and login: the stored database password may be sent to it. */
function sameDbEndpoint(a: ConnectionConfig, b: ConnectionConfig): boolean {
  return (
    a.dialect === b.dialect &&
    lower(a.host) === lower(b.host) &&
    a.port === b.port &&
    a.user === b.user &&
    lower(a.options.instanceName) === lower(b.options.instanceName)
  )
}

function isVault(config: ConnectionConfig): boolean {
  return config.authMode === 'vault'
}

/** Same Vault server and identity: the stored Vault token / password may be sent to it. */
function sameVaultEndpoint(a: ConnectionConfig, b: ConnectionConfig): boolean {
  return isVault(a) && isVault(b) && sameVaultIdentity(a.vault, b.vault)
}

/** Same SSH server and user: the stored SSH password / key passphrase may be sent to it. */
function sameSshEndpoint(a: ConnectionConfig, b: ConnectionConfig): boolean {
  return a.ssh.enabled && b.ssh.enabled && lower(a.ssh.host) === lower(b.ssh.host) && a.ssh.port === b.ssh.port && a.ssh.username === b.ssh.username
}

/** SET statements that would turn SHOWPLAN off (and so execute the following batches) or enable execution stats. */
const SHOWPLAN_SETTINGS = /^(SHOWPLAN_|STATISTICS$|PARSEONLY$|NOEXEC$|FMTONLY$)/

function changesShowplan(sql: string): boolean {
  const tokens = tokenize(sql, 'mssql').filter(isSignificant)
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i].kind === 'word' && tokens[i].upper === 'SET' && tokens[i + 1].kind === 'word' && SHOWPLAN_SETTINGS.test(tokens[i + 1].upper)) {
      return true
    }
  }
  return false
}

export class SessionManager {
  private readonly deps: SessionManagerDeps
  private readonly now: () => number
  private readonly log: Pick<Console, 'warn' | 'error'>
  private readonly active = new Map<string, ConnectionRuntime>()
  private readonly connecting = new Map<string, Promise<ConnectionRuntime>>()
  /** Aborts a pending connect (Vault OIDC sign-in) when the connection is disconnected / deleted meanwhile. */
  private readonly connectAborts = new Map<string, AbortController>()
  private readonly sessions = new Map<string, SessionRecord>()
  /** Running table-data requests (data:fetch / data:count) by requestId, for data:cancel. */
  private readonly dataRequests = new Map<string, AbortController>()

  constructor(deps: SessionManagerDeps) {
    this.deps = deps
    this.now = deps.now ?? (() => Date.now())
    this.log = deps.log ?? console
  }

  // -------------------------------------------------------------------------
  // Connections
  // -------------------------------------------------------------------------

  activeConnections(): string[] {
    return [...this.active.keys()]
  }

  isConnected(id: string): boolean {
    return this.active.has(id)
  }

  async connect(id: string, secrets?: ConnectionSecrets): Promise<ServerInfo> {
    const existing = this.active.get(id)
    if (existing) return existing.serverInfo
    return (await this.ensureConnected(id, secrets)).serverInfo
  }

  private ensureConnected(id: string, secrets?: ConnectionSecrets): Promise<ConnectionRuntime> {
    const existing = this.active.get(id)
    if (existing) return Promise.resolve(existing)
    const pending = this.connecting.get(id)
    if (pending) return pending
    const controller = new AbortController()
    const promise = this.openConnection(id, secrets, controller.signal).finally(() => {
      this.connecting.delete(id)
      if (this.connectAborts.get(id) === controller) this.connectAborts.delete(id)
    })
    this.connecting.set(id, promise)
    this.connectAborts.set(id, controller)
    return promise
  }

  private requireConfig(id: string): ConnectionConfig {
    const config = this.deps.connections.get(id)
    if (!config) throw DriverError.of('not-found', 'This connection no longer exists.')
    return config
  }

  private async openConnection(id: string, provided?: ConnectionSecrets, signal?: AbortSignal): Promise<ConnectionRuntime> {
    const config = this.requireConfig(id)
    if (isVault(config)) return this.openVaultConnection(id, config, provided, signal)
    const given = definedSecrets(provided)
    const secrets = { ...this.deps.connections.secrets(id), ...given }
    const passwordSource: 'provided' | 'cache' | 'stored' | 'none' =
      given.password !== undefined
        ? 'provided'
        : secrets.password
          ? this.deps.connections.passwordIsCached(id)
            ? 'cache'
            : 'stored'
          : 'none'
    const driver = this.deps.drivers(config.dialect)
    const tunnel = config.ssh.enabled ? await this.deps.openTunnel(config, secrets) : undefined
    const resolved: ResolvedConnection = {
      config,
      secrets,
      host: tunnel ? tunnel.host : config.host,
      port: tunnel ? tunnel.port : config.port,
    }
    let metadata: MetadataProvider | undefined
    try {
      metadata = await driver.openMetadata(resolved)
      const serverInfo = await metadata.serverInfo()
      const runtime: ConnectionRuntime = { id, driver, resolved, tunnel, metadata, serverInfo, sessions: new Set() }
      if (Object.keys(given).length > 0) this.deps.connections.rememberSecrets(id, given)
      this.active.set(id, runtime)
      tunnel?.onClose((reason) => void this.handleConnectionLost(id, reason))
      return runtime
    } catch (error) {
      await metadata?.close().catch(() => undefined)
      await tunnel?.close().catch(() => undefined)
      if (isAuthenticationError(error) && (passwordSource === 'none' || passwordSource === 'cache')) {
        if (passwordSource === 'cache') this.deps.connections.forgetCachedPassword(id)
        const detail = toErrorInfo(error).message
        throw DriverError.of('needs-password', `A password is required to connect to “${config.name}”.`, { detail })
      }
      if (passwordSource === 'stored' && isWrongPassword(error)) {
        // Prompt again (DataGrip does): the typed password replaces the saved one when it is kept.
        throw DriverError.of('needs-password', `The saved password for “${config.name}” was rejected.`, {
          detail: `The saved password was rejected: ${toErrorInfo(error).message}`,
        })
      }
      throw error
    }
  }

  // -------------------------------------------------------------------------
  // HashiCorp Vault
  // -------------------------------------------------------------------------

  private requireVault(): VaultService {
    if (!this.deps.vault) throw DriverError.of('internal', 'HashiCorp Vault support is not available.')
    return this.deps.vault
  }

  /** The connection's Vault settings, checked strictly (connections.json may hold incomplete ones). */
  private vaultConfigOf(config: ConnectionConfig): VaultConfig {
    return validateVaultConfig(config.vault)
  }

  /** What the drivers get for a Vault connection: the issued user / password (Vault secrets never reach a driver). */
  private vaultResolved(
    config: ConnectionConfig,
    secrets: ConnectionSecrets,
    creds: { username: string; password: string },
    tunnel: Tunnel | undefined,
  ): ResolvedConnection {
    const dbSecrets: ConnectionSecrets = { password: creds.password }
    if (secrets.sshPassword !== undefined) dbSecrets.sshPassword = secrets.sshPassword
    if (secrets.sshPassphrase !== undefined) dbSecrets.sshPassphrase = secrets.sshPassphrase
    return {
      config: { ...config, user: creds.username },
      secrets: dbSecrets,
      host: tunnel ? tunnel.host : config.host,
      port: tunnel ? tunnel.port : config.port,
    }
  }

  /** Vault has just created the database user: the server may reject it for a moment (role propagation). Retry once. */
  private async retryVaultLogin<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error) {
      if (!isAuthenticationError(error)) throw error
      await new Promise((resolve) => setTimeout(resolve, this.deps.vaultRetryDelayMs ?? 1000))
      return run()
    }
  }

  /** A cached Vault token / password Vault rejected must not be offered again. */
  private forgetRejectedVaultSecret(id: string, error: unknown): void {
    if (!(error instanceof DriverError) || error.info.kind !== 'needs-password') return
    const field = error.info.secretField
    if (field === 'vaultToken' || field === 'vaultPassword') this.deps.connections.forgetCachedSecret(id, field)
  }

  private async openVaultConnection(id: string, config: ConnectionConfig, provided?: ConnectionSecrets, signal?: AbortSignal): Promise<ConnectionRuntime> {
    const vault = this.requireVault()
    const vaultConfig = this.vaultConfigOf(config)
    const given = definedSecrets(provided)
    const secrets = { ...this.deps.connections.secrets(id), ...given }
    const driver = this.deps.drivers(config.dialect)
    let tunnel: Tunnel | undefined
    let metadata: MetadataProvider | undefined
    let creds: ActiveCredentials | undefined
    try {
      creds = await vault.acquire(id, vaultConfig, secrets, {
        secrets: () => this.deps.connections.secrets(id),
        onRotated: () => this.rotateVaultCredentials(id),
        onLeaseEnding: (leaseKey) => this.retireVaultLease(id, leaseKey),
        signal,
      })
      if (signal?.aborted) throw DriverError.of('cancelled', 'The connection was closed while connecting.')
      // Vault accepted the typed token / password: keep it for this run (and on disk when savePassword).
      if (Object.keys(given).length > 0) this.deps.connections.rememberSecrets(id, given)
      tunnel = config.ssh.enabled ? await this.deps.openTunnel(config, secrets) : undefined
      const resolved = this.vaultResolved(config, secrets, creds, tunnel)
      metadata = await this.retryVaultLogin(() => driver.openMetadata(resolved))
      const serverInfo = await metadata.serverInfo()
      const runtime: ConnectionRuntime = { id, driver, resolved, tunnel, metadata, serverInfo, sessions: new Set(), leaseKey: creds.leaseKey }
      vault.retain(id, creds.leaseKey, METADATA_HOLDER)
      this.active.set(id, runtime)
      tunnel?.onClose((reason) => void this.handleConnectionLost(id, reason))
      return runtime
    } catch (error) {
      await metadata?.close().catch(() => undefined)
      await tunnel?.close().catch(() => undefined)
      if (creds) await vault.end(id, creds.leaseKey).catch(() => undefined)
      this.forgetRejectedVaultSecret(id, error)
      throw error
    }
  }

  /** New Vault credentials were installed (renewal re-issue, refresh): reopen the metadata pool with them. */
  private async rotateVaultCredentials(id: string): Promise<void> {
    const runtime = this.active.get(id)
    const vault = this.deps.vault
    if (!runtime || !vault) return
    const creds = vault.current(id)
    if (!creds || creds.leaseKey === runtime.leaseKey) return
    const config = this.currentConfig(id, runtime)
    const resolved = this.vaultResolved(config, runtime.resolved.secrets, creds, runtime.tunnel)
    vault.retain(id, creds.leaseKey, METADATA_HOLDER)
    let metadata: MetadataProvider
    try {
      metadata = await this.retryVaultLogin(() => runtime.driver.openMetadata(resolved))
    } catch (error) {
      vault.release(id, creds.leaseKey, METADATA_HOLDER)
      throw error
    }
    if (this.active.get(id) !== runtime) {
      await metadata.close().catch(() => undefined)
      vault.release(id, creds.leaseKey, METADATA_HOLDER)
      return
    }
    const previous = runtime.metadata
    const previousKey = runtime.leaseKey
    runtime.metadata = metadata
    runtime.resolved = resolved
    runtime.leaseKey = creds.leaseKey
    try {
      await previous.close()
    } catch (error) {
      this.log.warn(`[session-manager] closing the previous metadata pool of ${id} failed`, error)
    }
    if (previousKey) vault.release(id, previousKey, METADATA_HOLDER)
  }

  /**
   * Vault connections: expired (or about to expire) credentials are refreshed before they are used. It checks the
   * wall clock, so it also covers lease timers that have not fired yet after the machine slept.
   */
  private async ensureFreshCredentials(runtime: ConnectionRuntime, { interactive = true }: { interactive?: boolean } = {}): Promise<void> {
    const vault = this.deps.vault
    if (!runtime.leaseKey || !vault || !vault.needsRefresh(runtime.id)) return
    await vault.refresh(runtime.id, { ifNeeded: true, interactive })
  }

  /**
   * The database refused the Vault credentials although the propagation retry ran: the user was dropped (lease
   * revoked by an admin or with its token) or the password changed (static role rotated, KV secret edited). Read
   * the secret again / issue a new lease once. False when this is not such a failure.
   */
  private async recoverVaultLogin(runtime: ConnectionRuntime, error: unknown, interactive: boolean): Promise<boolean> {
    const vault = this.deps.vault
    if (!runtime.leaseKey || !vault || !isWrongPassword(error) || this.active.get(runtime.id) !== runtime) return false
    await vault.refresh(runtime.id, { interactive })
    return this.active.get(runtime.id) === runtime
  }

  /** The metadata pool of a connection, with fresh Vault credentials (explorer, table data, data edits). */
  private async withMetadata<T>(connectionId: string, run: (metadata: MetadataProvider, runtime: ConnectionRuntime) => Promise<T>): Promise<T> {
    const runtime = await this.ensureConnected(connectionId)
    await this.ensureFreshCredentials(runtime)
    try {
      return await run(runtime.metadata, runtime)
    } catch (error) {
      if (!(await this.recoverVaultLogin(runtime, error, true))) throw error
      return run(runtime.metadata, runtime)
    }
  }

  /** Credentials for a new server connection: the connection's current Vault lease (it may be newer than `resolved`). */
  private sessionCredentials(runtime: ConnectionRuntime): { resolved: ResolvedConnection; leaseKey?: string } {
    const vault = this.deps.vault
    if (!runtime.leaseKey || !vault) return { resolved: runtime.resolved }
    const current = vault.current(runtime.id)
    if (!current || current.leaseKey === runtime.leaseKey) return { resolved: runtime.resolved, leaseKey: runtime.leaseKey }
    const config = this.currentConfig(runtime.id, runtime)
    return { resolved: this.vaultResolved(config, runtime.resolved.secrets, current, runtime.tunnel), leaseKey: current.leaseKey }
  }

  /** vault:test — Vault login + credentials (dynamic lease revoked right away), without touching the database. */
  async vaultTest(input: ConnectionInput): Promise<VaultTestResult> {
    try {
      const vault = this.requireVault()
      const vaultConfig = validateVaultConfig(input?.vault)
      const existing = typeof input.id === 'string' ? this.deps.connections.get(input.id) : undefined
      const stored: ConnectionSecrets = {}
      if (existing && isVault(existing) && sameVaultIdentity(existing.vault, vaultConfig)) {
        const saved = this.deps.connections.secrets(existing.id)
        if (saved.vaultToken !== undefined) stored.vaultToken = saved.vaultToken
        if (saved.vaultPassword !== undefined) stored.vaultPassword = saved.vaultPassword
      }
      return await vault.test(vaultConfig, patchSecrets(stored, input.secrets))
    } catch (error) {
      return { ok: false, error: toErrorInfo(error) }
    }
  }

  /** vault:discover — suggest secret paths from the Vault mounts the user's token can see. */
  async vaultDiscover(req: VaultDiscoverRequest): Promise<VaultDiscoverResult> {
    const vault = this.requireVault()
    if (!req || typeof req !== 'object') throw DriverError.of('invalid-input', 'Invalid discovery request.')
    const vaultConfig = validateVaultConfig(req.vault, { requireSecretPath: false })
    const role = typeof req.role === 'string' && req.role.trim() ? req.role.trim() : undefined
    if (role !== undefined && !/^[A-Za-z0-9_.@-]{1,128}$/.test(role)) throw DriverError.of('invalid-input', 'The Vault role name contains invalid characters.')
    const targets = sanitizeDiscoverTargets(req.targets)
    const existing = typeof req.connectionId === 'string' ? this.deps.connections.get(req.connectionId) : undefined
    const stored: ConnectionSecrets = {}
    if (existing && isVault(existing) && sameVaultIdentity(existing.vault, vaultConfig)) {
      const saved = this.deps.connections.secrets(existing.id)
      if (saved.vaultToken !== undefined) stored.vaultToken = saved.vaultToken
      if (saved.vaultPassword !== undefined) stored.vaultPassword = saved.vaultPassword
    }
    return vault.discover(vaultConfig, patchSecrets(stored, req.secrets), targets, role)
  }

  /** Lease state of a connected Vault connection (null otherwise). */
  vaultStatus(connectionId: string): VaultStatus | null {
    const runtime = this.active.get(connectionId)
    if (!runtime?.leaseKey || !this.deps.vault) return null
    return this.deps.vault.status(connectionId)
  }

  /** Fresh credentials now: connects when needed, otherwise re-issues and reopens the metadata pool. */
  async vaultRefresh(connectionId: string): Promise<VaultStatus> {
    const config = this.requireConfig(connectionId)
    if (!isVault(config)) throw DriverError.of('invalid-input', 'This connection does not use HashiCorp Vault.')
    const vault = this.requireVault()
    if (this.active.has(connectionId)) return vault.refresh(connectionId)
    await this.ensureConnected(connectionId)
    const status = vault.status(connectionId)
    if (!status) throw DriverError.of('connection', 'The connection was closed.')
    return status
  }

  /** Abort a pending OIDC browser sign-in. */
  vaultCancelLogin(): void {
    this.deps.vault?.cancelLogin()
  }

  /** Forget cached Vault tokens of a server (never touches ~/.vault-token). */
  vaultLogout(address: string, namespace?: string): void {
    this.deps.vault?.logout(address, namespace)
  }

  async disconnect(id: string, reason?: string): Promise<void> {
    await this.teardown(id, { reason, emit: true })
  }

  private async teardown(id: string, options: { reason?: string; emit: boolean }): Promise<void> {
    const pending = this.connecting.get(id)
    if (pending) {
      // Abandon a pending Vault sign-in (OIDC waits for the browser up to 5 min) instead of waiting for it.
      this.connectAborts.get(id)?.abort(DriverError.of('cancelled', 'The connection was closed while connecting.'))
      await pending.catch(() => undefined)
    }
    const runtime = this.active.get(id)
    if (!runtime) return
    this.active.delete(id)
    await Promise.allSettled([...runtime.sessions].map((sid) => this.closeRecord(sid)))
    try {
      await runtime.metadata.close()
    } catch (error) {
      this.log.warn(`[session-manager] closing metadata of ${id} failed`, error)
    }
    try {
      await runtime.tunnel?.close()
    } catch (error) {
      this.log.warn(`[session-manager] closing tunnel of ${id} failed`, error)
    }
    if (runtime.leaseKey) {
      // Revokes the dynamic leases (drops the temporary database users) unless revokeOnDisconnect is false.
      try {
        await this.deps.vault?.end(id, runtime.leaseKey)
      } catch (error) {
        this.log.warn(`[session-manager] ending the Vault leases of ${id} failed`, error)
      }
    }
    if (options.emit) {
      this.deps.emit('event:connectionClosed', options.reason ? { connectionId: id, reason: options.reason } : { connectionId: id })
    }
  }

  /** The SSH tunnel (or another transport) dropped: every session of the connection is gone. */
  private async handleConnectionLost(id: string, reason: string): Promise<void> {
    const runtime = this.active.get(id)
    if (!runtime) return
    for (const sid of runtime.sessions) {
      const record = this.sessions.get(sid)
      if (record && !record.closed) {
        this.deps.emit('event:sessionClosed', { sessionId: sid, connectionId: id, reason })
      }
    }
    await this.teardown(id, { reason, emit: true })
  }

  /** Called after connections:save — reconnecting is required when the endpoint or credentials changed. */
  async connectionSaved(before: ConnectionConfig | undefined, after: ConnectionConfig, secretsPatched: boolean): Promise<void> {
    if (!before || !this.active.has(after.id)) return
    const endpoint = (c: ConnectionConfig) => ({
      dialect: c.dialect,
      host: c.host,
      port: c.port,
      database: c.database,
      user: c.user,
      ssl: c.ssl,
      ssh: c.ssh,
      authMode: c.authMode ?? 'password',
      vault: c.authMode === 'vault' ? c.vault : undefined,
      applicationName: c.options.applicationName,
      instanceName: c.options.instanceName,
      connectTimeoutMs: c.options.connectTimeoutMs,
    })
    if (secretsPatched || !sameJson(endpoint(before), endpoint(after))) {
      await this.disconnect(after.id, 'Connection settings changed')
    }
  }

  async test(input: ConnectionInput): Promise<TestConnectionResult> {
    if (input?.authMode === 'vault') return this.testVault(input)
    let tunnel: Tunnel | undefined
    /** A saved password exists but was not sent because the endpoint changed. */
    let passwordWithheld = false
    try {
      const existing = input.id ? this.deps.connections.get(input.id) : undefined
      const config = configForTest(input, existing)
      const stored = existing ? this.storedSecretsFor(existing, config) : {}
      passwordWithheld = existing !== undefined && stored.password === undefined && Boolean(this.deps.connections.secrets(existing.id).password)
      const secrets = patchSecrets(stored, input.secrets)
      const driver = this.deps.drivers(config.dialect)
      const started = this.now()
      tunnel = config.ssh.enabled ? await this.deps.openTunnel(config, secrets) : undefined
      const info = await driver.test({
        config,
        secrets,
        host: tunnel ? tunnel.host : config.host,
        port: tunnel ? tunnel.port : config.port,
      })
      return { ok: true, info, latencyMs: Math.max(0, Math.round(this.now() - started)) }
    } catch (error) {
      if (passwordWithheld && input.secrets?.password === undefined && isAuthenticationError(error)) {
        return {
          ok: false,
          error: {
            kind: 'needs-password',
            message: 'The saved password is only sent to the saved server. Type the password to test the new settings.',
            detail: toErrorInfo(error).message,
          },
        }
      }
      return { ok: false, error: toErrorInfo(error) }
    } finally {
      if (tunnel) await tunnel.close().catch(() => undefined)
    }
  }

  /** connections:test for a Vault connection: login, issue, test the database, revoke the test lease. */
  private async testVault(input: ConnectionInput): Promise<TestConnectionResult> {
    let tunnel: Tunnel | undefined
    try {
      const vault = this.requireVault()
      const existing = input.id ? this.deps.connections.get(input.id) : undefined
      const config = configForTest(input, existing)
      const stored = existing ? this.storedSecretsFor(existing, config) : {}
      const secrets = patchSecrets(stored, input.secrets)
      const driver = this.deps.drivers(config.dialect)
      return await vault.withTestCredentials(this.vaultConfigOf(config), secrets, async (creds) => {
        tunnel = config.ssh.enabled ? await this.deps.openTunnel(config, secrets) : undefined
        const resolved = this.vaultResolved(config, secrets, creds, tunnel)
        const started = this.now()
        const info = await this.retryVaultLogin(() => driver.test(resolved))
        return { ok: true, info, latencyMs: Math.max(0, Math.round(this.now() - started)) }
      })
    } catch (error) {
      return { ok: false, error: toErrorInfo(error) }
    } finally {
      if (tunnel) await tunnel.close().catch(() => undefined)
    }
  }

  /**
   * Stored secrets that may be sent to the endpoint being tested: the database password only to the saved
   * server / login, SSH secrets only to the saved SSH server / user. A mistyped host (or a compromised
   * renderer) must not receive the saved production password.
   */
  private storedSecretsFor(saved: ConnectionConfig, target: ConnectionConfig): ConnectionSecrets {
    const stored = this.deps.connections.secrets(saved.id)
    const out: ConnectionSecrets = {}
    if (stored.password !== undefined && sameDbEndpoint(saved, target)) out.password = stored.password
    if (sameVaultEndpoint(saved, target)) {
      if (stored.vaultToken !== undefined) out.vaultToken = stored.vaultToken
      if (stored.vaultPassword !== undefined) out.vaultPassword = stored.vaultPassword
    }
    if (sameSshEndpoint(saved, target)) {
      if (stored.sshPassword !== undefined) out.sshPassword = stored.sshPassword
      if (stored.sshPassphrase !== undefined) out.sshPassphrase = stored.sshPassphrase
    }
    return out
  }

  /**
   * Close every console session (open transactions are rolled back) but keep the connections: used when
   * the renderer that owned the sessions reloads or crashes. No events are emitted.
   */
  async closeAllSessions(): Promise<void> {
    await Promise.allSettled([...this.sessions.keys()].map((sid) => this.closeRecord(sid)))
  }

  /** Consoles with an open transaction (asked about before quitting). */
  openTransactions(): { sessionId: string; connectionId: string }[] {
    const out: { sessionId: string; connectionId: string }[] = []
    for (const record of this.sessions.values()) {
      if (record.closed) continue
      try {
        if (record.driver.transactionState().inTransaction) out.push({ sessionId: record.id, connectionId: record.connectionId })
      } catch {
        // a broken session has nothing to keep
      }
    }
    return out
  }

  /** Close everything; gives up waiting after `timeoutMs`. */
  async shutdown(timeoutMs = 3000): Promise<void> {
    const ids = new Set([...this.active.keys(), ...this.connecting.keys()])
    const all = Promise.allSettled([...ids].map((id) => this.teardown(id, { emit: false })))
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        this.log.warn('[session-manager] shutdown timed out')
        resolve()
      }, timeoutMs)
    })
    await Promise.race([all.then(() => undefined), timeout])
    if (timer) clearTimeout(timer)
  }

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------

  private showSystem(runtime: ConnectionRuntime): boolean {
    const config = this.deps.connections.get(runtime.id) ?? runtime.resolved.config
    return config.options.showSystemObjects === true
  }

  async databases(connectionId: string): Promise<DatabaseInfo[]> {
    return this.withMetadata(connectionId, (metadata, rt) => metadata.listDatabases(this.showSystem(rt)))
  }

  async schemas(connectionId: string, database: string): Promise<SchemaInfo[]> {
    return this.withMetadata(connectionId, (metadata, rt) => metadata.listSchemas(database, this.showSystem(rt)))
  }

  async objects(connectionId: string, database: string, schema: string): Promise<DbObjectInfo[]> {
    return this.withMetadata(connectionId, (metadata) => metadata.listObjects(database, schema))
  }

  async tableDetails(connectionId: string, database: string, schema: string, name: string): Promise<TableDetails> {
    return this.withMetadata(connectionId, (metadata) => metadata.tableDetails(database, schema, name))
  }

  async ddl(req: DdlRequest): Promise<string> {
    return this.withMetadata(req.connectionId, (metadata) => metadata.getDdl(req.database, req.schema, req.name, req.kind, req.identity))
  }

  async completionCatalog(connectionId: string, database: string): Promise<CompletionCatalog> {
    return this.withMetadata(connectionId, (metadata, rt) => metadata.completionCatalog(database, this.showSystem(rt)))
  }

  // -------------------------------------------------------------------------
  // Table data
  // -------------------------------------------------------------------------

  private currentConfig(connectionId: string, runtime?: ConnectionRuntime): ConnectionConfig {
    const config = this.deps.connections.get(connectionId) ?? runtime?.resolved.config
    if (!config) throw DriverError.of('not-found', 'This connection no longer exists.')
    return config
  }

  /** Run a table-data request that `cancelTableData(requestId)` can stop. */
  private async cancellable<T>(requestId: unknown, run: (signal: AbortSignal | undefined) => Promise<T>): Promise<T> {
    if (typeof requestId !== 'string' || requestId === '') return run(undefined)
    const controller = new AbortController()
    this.dataRequests.get(requestId)?.abort()
    this.dataRequests.set(requestId, controller)
    try {
      const result = await run(controller.signal)
      if (controller.signal.aborted) throw DriverError.of('cancelled', 'The query was cancelled.')
      return result
    } finally {
      if (this.dataRequests.get(requestId) === controller) this.dataRequests.delete(requestId)
    }
  }

  async fetchTableData(req: TableDataRequest): Promise<TableDataPage> {
    return this.cancellable(req.requestId, async (signal) => {
      return this.withMetadata(req.table.connectionId, (metadata, rt) => metadata.fetchTableData(req, this.currentConfig(rt.id, rt).readOnly, signal))
    })
  }

  async countTableData(req: Omit<TableDataRequest, 'offset' | 'limit' | 'orderBy'>): Promise<number> {
    return this.cancellable(req.requestId, async (signal) => {
      return this.withMetadata(req.table.connectionId, (metadata) => metadata.countTableData(req, signal))
    })
  }

  /** Stop a running data:fetch / data:count (no-op when it already finished). */
  cancelTableData(requestId: string): void {
    this.dataRequests.get(requestId)?.abort()
  }

  async previewChanges(table: TableRef, changes: RowChange[]): Promise<string[]> {
    return this.withMetadata(table.connectionId, (metadata) => metadata.previewChanges(table, changes))
  }

  async applyChanges(table: TableRef, changes: RowChange[]): Promise<ApplyChangesResult> {
    const config = this.requireConfig(table.connectionId)
    if (config.readOnly) {
      throw DriverError.of('read-only', `“${config.name}” is a read-only connection — data changes are blocked.`)
    }
    // A refused login happens before any statement runs: retrying with re-read credentials is safe.
    return this.withMetadata(table.connectionId, (metadata) => metadata.applyChanges(table, changes))
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  private requireSession(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId)
    if (!record || record.closed) throw DriverError.of('not-found', 'This console session is closed. Reconnect to continue.')
    return record
  }

  private info(record: SessionRecord): SessionInfo {
    const info: SessionInfo = {
      sessionId: record.id,
      connectionId: record.connectionId,
      database: record.driver.database,
      transaction: record.driver.transactionState(),
    }
    if (record.driver.schema !== undefined) info.schema = record.driver.schema
    return info
  }

  /**
   * Open a server connection with the connection's current credentials. Vault connections refresh expired
   * credentials first and hold the lease (released with releaseLease) so it is not revoked while in use.
   */
  private async openDriverSession(
    runtime: ConnectionRuntime,
    config: ConnectionConfig,
    database: string,
    applyDefaultSchema: boolean,
    { interactive = true }: { interactive?: boolean } = {},
  ): Promise<{ session: DriverSession; lease?: SessionLease }> {
    await this.ensureFreshCredentials(runtime, { interactive })
    const open = async (): Promise<{ session: DriverSession; lease?: SessionLease }> => {
      const { resolved, leaseKey } = this.sessionCredentials(runtime)
      const lease: SessionLease | undefined = leaseKey ? { key: leaseKey, holder: randomUUID() } : undefined
      if (lease) this.deps.vault?.retain(runtime.id, lease.key, lease.holder)
      try {
        const session = lease ? await this.retryVaultLogin(() => runtime.driver.openSession(resolved, database)) : await runtime.driver.openSession(resolved, database)
        return lease ? { session, lease } : { session }
      } catch (error) {
        this.releaseLease(runtime.id, lease)
        throw error
      }
    }
    let opened: { session: DriverSession; lease?: SessionLease }
    try {
      opened = await open()
    } catch (error) {
      if (!(await this.recoverVaultLogin(runtime, error, interactive))) throw error
      opened = await open()
    }
    const { session, lease } = opened
    try {
      if (config.readOnly) await session.setReadOnly(true)
      if (applyDefaultSchema && config.options.defaultSchema) await session.setSchema(config.options.defaultSchema)
    } catch (error) {
      await session.close().catch(() => undefined)
      this.releaseLease(runtime.id, lease)
      throw error
    }
    return lease ? { session, lease } : { session }
  }

  private releaseLease(connectionId: string, lease: SessionLease | undefined): void {
    if (lease) this.deps.vault?.release(connectionId, lease.key, lease.holder)
  }

  private watch(record: SessionRecord, session: DriverSession): void {
    session.onUnexpectedClose((reason) => {
      if (record.closed || record.driver !== session) return
      record.closed = true
      this.sessions.delete(record.id)
      this.active.get(record.connectionId)?.sessions.delete(record.id)
      this.releaseLease(record.connectionId, record.lease)
      this.deps.emit('event:sessionClosed', { sessionId: record.id, connectionId: record.connectionId, reason })
    })
  }

  /** Install a new server connection in a console (same session id) and close the previous one. */
  private async swapDriver(record: SessionRecord, next: DriverSession, lease: SessionLease | undefined, config: ConnectionConfig): Promise<void> {
    const previous = record.driver
    const previousLease = record.lease
    record.driver = next
    record.readOnly = config.readOnly
    if (lease) record.lease = lease
    else delete record.lease
    this.watch(record, next)
    try {
      await previous.close()
    } catch (error) {
      this.log.warn(`[session-manager] closing previous session of ${record.id} failed`, error)
    }
    this.releaseLease(record.connectionId, previousLease)
  }

  /** Run a console operation; a console whose Vault lease ends meanwhile is moved once it is idle again. */
  private async running<T>(record: SessionRecord, run: () => Promise<T>): Promise<T> {
    record.busy++
    try {
      return await run()
    } finally {
      record.busy--
      if (record.busy === 0 && record.retire && !record.closed) {
        record.retire = false
        const runtime = this.active.get(record.connectionId)
        if (runtime) void this.retireRecord(record, runtime)
      }
    }
  }

  /**
   * A superseded Vault lease is about to end (Vault drops its user at its max TTL): move the consoles still using
   * it to the current credentials. Idle consoles are reopened in place (database, schema and commit mode kept);
   * a console inside a transaction cannot be moved and is closed (event:sessionClosed); a busy one is moved
   * once its statement finishes.
   */
  private async retireVaultLease(connectionId: string, leaseKey: string): Promise<void> {
    const runtime = this.active.get(connectionId)
    if (!runtime) return
    const records = [...runtime.sessions]
      .map((sid) => this.sessions.get(sid))
      .filter((r): r is SessionRecord => r !== undefined && !r.closed && r.lease?.key === leaseKey)
    await Promise.allSettled(records.map((record) => this.retireRecord(record, runtime)))
  }

  private inTransaction(record: SessionRecord): boolean {
    try {
      return record.driver.transactionState().inTransaction
    } catch {
      return false
    }
  }

  private async retireRecord(record: SessionRecord, runtime: ConnectionRuntime): Promise<void> {
    if (record.closed || this.active.get(record.connectionId) !== runtime) return
    if (record.busy > 0) {
      record.retire = true
      return
    }
    if (this.inTransaction(record)) {
      await this.closeLostSession(record, LEASE_ENDED_REASON)
      return
    }
    const previous = record.driver
    try {
      const { autoCommit } = previous.transactionState()
      const schema = previous.schema
      const config = this.currentConfig(record.connectionId, runtime)
      // Background work: never opens a browser (OIDC); a refused sign-in closes the console instead.
      const { session: next, lease } = await this.openDriverSession(runtime, config, previous.database, false, { interactive: false })
      try {
        if (!autoCommit) await next.setAutoCommit(false)
        if (schema !== undefined && schema !== next.schema) await next.setSchema(schema)
      } catch (error) {
        await next.close().catch(() => undefined)
        this.releaseLease(record.connectionId, lease)
        throw error
      }
      // The console changed meanwhile (statement started, transaction opened, database switched, closed).
      if (record.closed || record.driver !== previous || record.busy > 0 || this.inTransaction(record)) {
        await next.close().catch(() => undefined)
        this.releaseLease(record.connectionId, lease)
        if (!record.closed && record.driver === previous) {
          if (record.busy > 0) record.retire = true
          else await this.closeLostSession(record, LEASE_ENDED_REASON)
        }
        return
      }
      await this.swapDriver(record, next, lease, config)
    } catch (error) {
      this.log.warn(`[session-manager] moving console ${record.id} to new Vault credentials failed`, error)
      if (!record.closed && record.driver === previous) await this.closeLostSession(record, `${LEASE_ENDED_REASON} ${toErrorInfo(error).message}`)
    }
  }

  /** Close a console the renderer still shows, telling it why. */
  private async closeLostSession(record: SessionRecord, reason: string): Promise<void> {
    if (record.closed) return
    await this.closeRecord(record.id)
    this.deps.emit('event:sessionClosed', { sessionId: record.id, connectionId: record.connectionId, reason })
  }

  async openSession(req: OpenSessionRequest): Promise<SessionInfo> {
    const runtime = await this.ensureConnected(req.connectionId)
    const config = this.currentConfig(req.connectionId, runtime)
    const database = req.database ?? config.database
    const { session, lease } = await this.openDriverSession(runtime, config, database, true)
    if (this.active.get(req.connectionId) !== runtime) {
      // Disconnected while the session was opening.
      await session.close().catch(() => undefined)
      this.releaseLease(req.connectionId, lease)
      throw DriverError.of('connection', 'The connection was closed while opening the session.')
    }
    const record: SessionRecord = {
      id: randomUUID(),
      connectionId: req.connectionId,
      driver: session,
      readOnly: config.readOnly,
      closed: false,
      busy: 0,
    }
    if (lease) record.lease = lease
    this.sessions.set(record.id, record)
    runtime.sessions.add(record.id)
    this.watch(record, session)
    return this.info(record)
  }

  private async closeRecord(sessionId: string): Promise<void> {
    const record = this.sessions.get(sessionId)
    if (!record) return
    record.closed = true
    this.sessions.delete(sessionId)
    this.active.get(record.connectionId)?.sessions.delete(sessionId)
    try {
      await record.driver.close()
    } catch (error) {
      this.log.warn(`[session-manager] closing session ${sessionId} failed`, error)
    }
    this.releaseLease(record.connectionId, record.lease)
  }

  /** Closing an unknown / already closed session is a no-op. */
  async closeSession(sessionId: string): Promise<void> {
    await this.closeRecord(sessionId)
  }

  sessionInfo(sessionId: string): SessionInfo {
    return this.info(this.requireSession(sessionId))
  }

  private assertReadOnlySql(config: ConnectionConfig, sql: string): void {
    for (const unit of splitStatements(sql, config.dialect)) {
      const classification = classifyStatement(unit.text, config.dialect)
      if (!classification.readOnly) {
        const command = classification.command || 'this statement'
        throw DriverError.of('read-only', `“${config.name}” is a read-only connection — ${command} is blocked.`)
      }
    }
  }

  /**
   * Server-side read-only layer (PostgreSQL default_transaction_read_only). It is re-asserted before every
   * run because user SQL the classifier missed could have turned it off. A console that was inside a
   * transaction when its connection became read-only is refused until it commits or rolls back: SET SESSION
   * CHARACTERISTICS only applies to the next transaction.
   */
  private async enforceReadOnly(record: SessionRecord, config: ConnectionConfig): Promise<void> {
    if (!config.readOnly) {
      if (record.readOnly) {
        await record.driver.setReadOnly(false)
        record.readOnly = false
      }
      return
    }
    const { inTransaction } = record.driver.transactionState()
    if (inTransaction && !record.readOnly) {
      throw DriverError.of(
        'read-only',
        `“${config.name}” became read-only while this console had an open transaction. Commit or roll back to continue.`,
      )
    }
    // Inside a transaction started read-only there is nothing to re-assert (and an aborted transaction
    // would reject the SET); BEGIN READ WRITE and friends are blocked by the classifier.
    if (!inTransaction) await record.driver.setReadOnly(true)
    record.readOnly = true
  }

  /** Batched live delivery of server messages for one execution. */
  private messageStream(sessionId: string): { push: (message: QueryMessage) => void; close: () => void } {
    let buffer: QueryMessage[] = []
    let sent = 0
    let timer: NodeJS.Timeout | undefined
    const flush = () => {
      timer = undefined
      if (buffer.length === 0) return
      const messages = buffer
      buffer = []
      this.deps.emit('event:sessionMessages', { sessionId, messages })
    }
    return {
      push: (message) => {
        if (sent >= MAX_LIVE_MESSAGES) return
        sent++
        buffer.push(message)
        if (!timer) timer = setTimeout(flush, MESSAGE_FLUSH_MS)
      },
      close: () => {
        if (timer) clearTimeout(timer)
        flush()
      },
    }
  }

  /** `history: false` for internal runs (exports) that should not appear in the query history. */
  async execute(sessionId: string, sql: string, options: ExecuteOptions, { history = true }: { history?: boolean } = {}): Promise<ExecutionResult> {
    const record = this.requireSession(sessionId)
    const config = this.currentConfig(record.connectionId, this.active.get(record.connectionId))
    if (config.readOnly) this.assertReadOnlySql(config, sql)
    await this.enforceReadOnly(record, config)

    const maxRows = Math.min(MAX_ROWS_LIMIT, Math.max(1, Math.floor(options.maxRows) || 1))
    const executionId = randomUUID()
    const startedAt = this.now()
    const session = record.driver
    const database = session.database
    const historyBase: Omit<HistoryEntry, 'id' | 'durationMs' | 'success'> = {
      connectionId: record.connectionId,
      database,
      ...historySql(sql, config.dialect),
      executedAt: new Date(startedAt).toISOString(),
    }
    if (session.schema !== undefined) historyBase.schema = session.schema

    const recordHistory = (entry: Omit<HistoryEntry, 'id'>) => history && this.recordHistory(entry)

    let outcome: DriverExecuteResult
    const live = this.messageStream(sessionId)
    try {
      outcome = await this.running(record, () => session.execute(sql, { ...options, maxRows, onMessage: live.push }))
    } catch (error) {
      recordHistory({
        ...historyBase,
        durationMs: Math.max(0, this.now() - startedAt),
        success: false,
        rowCount: null,
        error: toErrorInfo(error).message,
      })
      throw error
    } finally {
      live.close()
    }
    const durationMs = Math.max(0, Math.round(this.now() - startedAt))
    const firstError = outcome.results.find((r) => r.kind === 'error')
    const last = outcome.results[outcome.results.length - 1]
    recordHistory({
      ...historyBase,
      durationMs,
      success: !firstError && !outcome.cancelled,
      rowCount: last ? last.rowCount : null,
      ...(firstError ? { error: firstError.error?.message ?? 'Statement failed' } : outcome.cancelled ? { error: 'Cancelled' } : {}),
    })
    return {
      executionId,
      sessionId,
      results: outcome.results,
      messages: buildMessages(outcome.results, outcome.messages, startedAt),
      durationMs,
      cancelled: outcome.cancelled,
      transaction: session.transactionState(),
    }
  }

  private recordHistory(entry: Omit<HistoryEntry, 'id'>): void {
    try {
      this.deps.history.add(entry)
    } catch (error) {
      this.log.error('[session-manager] cannot record history', error)
    }
  }

  async fetchMore(sessionId: string, cursorId: string, count: number): Promise<FetchMoreResult> {
    const n = Math.min(MAX_ROWS_LIMIT, Math.max(1, Math.floor(count) || 1))
    const record = this.requireSession(sessionId)
    return this.running(record, () => record.driver.fetchMore(cursorId, n))
  }

  async cancel(sessionId: string): Promise<void> {
    const record = this.sessions.get(sessionId)
    if (!record || record.closed) return
    await record.driver.cancel()
  }

  async setAutoCommit(sessionId: string, autoCommit: boolean): Promise<TransactionState> {
    return this.requireSession(sessionId).driver.setAutoCommit(autoCommit)
  }

  async commit(sessionId: string): Promise<TransactionState> {
    return this.requireSession(sessionId).driver.commit()
  }

  async rollback(sessionId: string): Promise<TransactionState> {
    return this.requireSession(sessionId).driver.rollback()
  }

  async setDatabase(sessionId: string, database: string, options: SetDatabaseOptions = {}): Promise<SessionInfo> {
    const record = this.requireSession(sessionId)
    if (await record.driver.useDatabase(database)) return this.info(record)
    // The driver cannot switch in place (PostgreSQL): reopen on the new database under the same id.
    const { autoCommit, inTransaction } = record.driver.transactionState()
    if (inTransaction && options.discardTransaction !== true) {
      throw DriverError.of('invalid-input', 'Commit or roll back the open transaction before switching database.')
    }
    const runtime = await this.ensureConnected(record.connectionId)
    const config = this.currentConfig(record.connectionId, runtime)
    // Vault: the new server connection logs in with the connection's current credentials.
    const { session: next, lease } = await this.openDriverSession(runtime, config, database, false)
    try {
      // Keep the mode the user chose: a manual-commit console must not silently start auto-committing.
      if (!autoCommit) await next.setAutoCommit(false)
    } catch (error) {
      await next.close().catch(() => undefined)
      this.releaseLease(record.connectionId, lease)
      throw error
    }
    if (record.closed) {
      await next.close().catch(() => undefined)
      this.releaseLease(record.connectionId, lease)
      throw DriverError.of('not-found', 'This console session is closed. Reconnect to continue.')
    }
    await this.swapDriver(record, next, lease, config)
    return this.info(record)
  }

  async setSchema(sessionId: string, schema: string): Promise<SessionInfo> {
    const record = this.requireSession(sessionId)
    await record.driver.setSchema(schema)
    return this.info(record)
  }

  async explain(sessionId: string, sql: string, analyze: boolean): Promise<ExplainResult> {
    const record = this.requireSession(sessionId)
    const config = this.currentConfig(record.connectionId, this.active.get(record.connectionId))
    // Estimated SQL Server plans run every batch with SHOWPLAN_XML on: a batch turning it off would make
    // the following ones really execute.
    if (config.dialect === 'mssql' && changesShowplan(sql)) {
      throw DriverError.of('invalid-input', 'Explain cannot run SET SHOWPLAN / STATISTICS statements: remove them and try again.')
    }
    // EXPLAIN ANALYZE / STATISTICS XML actually run the statement. SQL Server estimated plans run every
    // batch too (with SHOWPLAN on), so they are checked as well; a PostgreSQL EXPLAIN without ANALYZE never
    // executes anything.
    if (config.readOnly && (analyze || config.dialect === 'mssql')) {
      this.assertReadOnlySql(config, sql)
      await this.enforceReadOnly(record, config)
    }
    return this.running(record, () => record.driver.explain(sql, analyze))
  }

  /** The connection is flagged read-only (imports and other internal writes check it first). */
  isReadOnly(connectionId: string): boolean {
    return this.requireConfig(connectionId).readOnly
  }

  /** Dialect of a connection (for export formatting). */
  dialectOf(connectionId: string): ConnectionConfig['dialect'] {
    return this.requireConfig(connectionId).dialect
  }
}
