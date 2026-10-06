// connections.json — connection definitions (never secrets) + the secrets bookkeeping rules.
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  CONNECTION_COLORS,
  DEFAULT_PORT,
  type ConnectionAuthMode,
  type ConnectionColor,
  type ConnectionConfig,
  type ConnectionInput,
  type ConnectionOptions,
  type ConnectionSecrets,
  type Dialect,
  type SshAuthMethod,
  type SshConfig,
  type SslConfig,
  type SslMode,
} from '@shared/types'
import { DriverError } from '../db/errors'
import { sameVaultIdentity, validateVaultConfig } from '../vault/config'
import { isRecord, JsonFile } from './json-file'
import { SECRET_KEYS, type SecretStore } from './secrets'

type StoredConnection = Omit<ConnectionConfig, 'hasPassword'>

const DIALECTS: Dialect[] = ['postgres', 'mssql']
const SSL_MODES: SslMode[] = ['disable', 'prefer', 'require', 'verify-full']
const SSH_METHODS: SshAuthMethod[] = ['password', 'privateKey', 'agent']
const AUTH_MODES: ConnectionAuthMode[] = ['password', 'vault']
/** Secrets persisted only when the connection saves its password (otherwise kept in memory for the run). */
const SAVE_PASSWORD_KEYS = ['password', 'vaultToken', 'vaultPassword'] as const
const VAULT_SECRET_KEYS = ['vaultToken', 'vaultPassword'] as const

/** Read access used by the session manager. */
export interface ConnectionSource {
  get(id: string): ConnectionConfig | undefined
  /** Stored secrets overridden by those cached for this app run. */
  secrets(id: string): ConnectionSecrets
  /** Secrets typed at connect time: cached in memory, persisted only when the connection saves its password. */
  rememberSecrets(id: string, secrets: ConnectionSecrets): void
  /** Drop a cached password that turned out to be wrong. */
  forgetCachedPassword(id: string): void
  /** Drop any cached secret that turned out to be wrong (e.g. a rejected Vault password). */
  forgetCachedSecret(id: string, key: keyof ConnectionSecrets): void
  /** True when the password currently in use comes from the in-memory cache. */
  passwordIsCached(id: string): boolean
}

export class ConnectionStore implements ConnectionSource {
  private readonly file: JsonFile<StoredConnection[]>
  private readonly secretStore: SecretStore
  private readonly now: () => Date

  constructor(baseDir: string, secretStore: SecretStore, options: { now?: () => Date; log?: Pick<Console, 'warn' | 'error'> } = {}) {
    this.secretStore = secretStore
    this.now = options.now ?? (() => new Date())
    const log = options.log ?? console
    this.file = new JsonFile<StoredConnection[]>(join(baseDir, 'connections.json'), {
      fallback: () => [],
      parse: (raw) => {
        if (!Array.isArray(raw)) throw new Error('expected an array')
        const out: StoredConnection[] = []
        for (const item of raw) {
          const parsed = coerceStoredConnection(item)
          if (parsed) out.push(parsed)
          else log.warn('[connections] Ignoring an invalid connection entry')
        }
        return out
      },
      log,
    })
  }

  list(): ConnectionConfig[] {
    return this.file.get().map((c) => this.withPassword(c))
  }

  get(id: string): ConnectionConfig | undefined {
    const found = this.file.get().find((c) => c.id === id)
    return found ? this.withPassword(found) : undefined
  }

  save(input: ConnectionInput): ConnectionConfig {
    const all = this.file.get()
    const existingIndex = input.id ? all.findIndex((c) => c.id === input.id) : -1
    if (input.id && existingIndex === -1) throw DriverError.of('not-found', 'This connection no longer exists.')
    const existing = existingIndex >= 0 ? all[existingIndex] : undefined
    const nowIso = this.now().toISOString()
    const config = validateConnectionInput(input, {
      id: existing?.id ?? randomUUID(),
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
    })
    const next = [...all]
    if (existing) next[existingIndex] = config
    else next.push(config)
    this.applySecrets(config, input.secrets, existing)
    this.file.set(next)
    return this.withPassword(config)
  }

  duplicate(id: string): ConnectionConfig {
    const all = this.file.get()
    const source = all.find((c) => c.id === id)
    if (!source) throw DriverError.of('not-found', 'This connection no longer exists.')
    const nowIso = this.now().toISOString()
    const copy: StoredConnection = {
      ...structuredClone(source),
      id: randomUUID(),
      name: `${source.name} copy`,
      createdAt: nowIso,
      updatedAt: nowIso,
    }
    this.secretStore.copy(source.id, copy.id)
    this.file.set([...all, copy])
    return this.withPassword(copy)
  }

  /** Removes the definition and its secrets (history is kept). */
  delete(id: string): void {
    const all = this.file.get()
    this.secretStore.delete(id)
    if (all.some((c) => c.id === id)) this.file.set(all.filter((c) => c.id !== id))
  }

  secrets(id: string): ConnectionSecrets {
    return this.secretStore.resolve(id)
  }

  rememberSecrets(id: string, secrets: ConnectionSecrets): void {
    const config = this.file.get().find((c) => c.id === id)
    if (!config) return
    const provided = definedSecrets(secrets)
    if (Object.keys(provided).length === 0) return
    this.secretStore.setCached(id, provided)
    const persistable: ConnectionSecrets = { ...provided }
    if (!config.savePassword) for (const key of SAVE_PASSWORD_KEYS) delete persistable[key]
    if (Object.keys(persistable).length > 0) this.secretStore.setStored(id, { ...this.secretStore.getStored(id), ...persistable })
  }

  forgetCachedPassword(id: string): void {
    this.secretStore.forgetCached(id, 'password')
  }

  forgetCachedSecret(id: string, key: keyof ConnectionSecrets): void {
    this.secretStore.forgetCached(id, key)
  }

  passwordIsCached(id: string): boolean {
    return Boolean(this.secretStore.getCached(id).password)
  }

  flush(): void {
    this.file.flush()
    this.secretStore.flush()
  }

  private withPassword(config: StoredConnection): ConnectionConfig {
    const out: ConnectionConfig = { ...structuredClone(config), hasPassword: this.secretStore.hasStoredPassword(config.id) }
    if (config.authMode === 'vault') {
      const key = config.vault?.loginMethod === 'token' ? 'vaultToken' : 'vaultPassword'
      out.hasVaultSecret = this.secretStore.hasStored(config.id, key)
    }
    return out
  }

  /**
   * undefined = keep, '' = clear, value = set. With savePassword=false the DB password and the Vault token /
   * password live in memory only. A saved Vault token / password only belongs to the Vault identity it was typed
   * for: when the address, namespace, login method, mount or user changes, it is dropped (asked again) so a
   * mistyped address never receives it.
   */
  private applySecrets(config: StoredConnection, patch: ConnectionSecrets | undefined, existing?: StoredConnection): void {
    const id = config.id
    const stored = this.secretStore.getStored(id)
    const cached = this.secretStore.getCached(id)
    if (existing && !sameVaultIdentity(existing.vault, config.vault)) {
      for (const key of VAULT_SECRET_KEYS) {
        if (patch?.[key] !== undefined) continue
        delete stored[key]
        delete cached[key]
        this.secretStore.forgetCached(id, key)
      }
    }
    const next: ConnectionSecrets = { ...stored }
    for (const key of SECRET_KEYS) {
      const value = patch?.[key]
      if (value === undefined) continue
      if (value === '') delete next[key]
      else next[key] = value
      this.secretStore.forgetCached(id, key)
    }
    for (const key of SAVE_PASSWORD_KEYS) {
      const keyPatch = patch?.[key]
      if (config.savePassword) {
        // A secret typed earlier for this run becomes persistent once the user opts in.
        if (keyPatch === undefined && next[key] === undefined && cached[key]) next[key] = cached[key]
      } else {
        const inMemory = keyPatch === undefined ? (next[key] ?? cached[key]) : next[key]
        delete next[key]
        if (inMemory) this.secretStore.setCached(id, { [key]: inMemory })
        else this.secretStore.forgetCached(id, key)
      }
    }
    this.secretStore.setStored(id, next)
  }
}

function definedSecrets(secrets: ConnectionSecrets): ConnectionSecrets {
  const out: ConnectionSecrets = {}
  for (const key of SECRET_KEYS) {
    const value = secrets[key]
    if (typeof value === 'string' && value !== '') out[key] = value
  }
  return out
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function invalid(message: string): DriverError {
  return DriverError.of('invalid-input', message)
}

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function optStr(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Validate a renderer-provided definition and turn it into the persisted shape. Throws DriverError('invalid-input'). */
export function validateConnectionInput(
  input: ConnectionInput,
  meta: { id: string; createdAt: string; updatedAt: string },
  { lenient = false }: { lenient?: boolean } = {},
): StoredConnection {
  if (!isRecord(input)) throw invalid('Invalid connection definition.')
  const name = str(input.name).trim()
  if (!name) throw invalid('Connection name is required.')
  if (!DIALECTS.includes(input.dialect)) throw invalid('Unknown database type.')
  const host = str(input.host).trim()
  if (!host) throw invalid('Host is required.')
  if (!isPort(input.port)) throw invalid('Port must be a number between 1 and 65535.')

  const sslRaw: Partial<SslConfig> = isRecord(input.ssl) ? input.ssl : {}
  const sslMode = SSL_MODES.includes(sslRaw.mode as SslMode) ? (sslRaw.mode as SslMode) : 'prefer'
  const ssl: SslConfig = { mode: sslMode }
  const caPath = optStr(sslRaw.caPath)
  const certPath = optStr(sslRaw.certPath)
  const keyPath = optStr(sslRaw.keyPath)
  if (caPath) ssl.caPath = caPath
  if (certPath) ssl.certPath = certPath
  if (keyPath) ssl.keyPath = keyPath

  const ssh = validateSsh(isRecord(input.ssh) ? input.ssh : {})
  const color: ConnectionColor = CONNECTION_COLORS.includes(input.color) ? input.color : 'none'
  const options = sanitizeOptions(isRecord(input.options) ? input.options : {})
  const database = str(input.database).trim() || (input.dialect === 'postgres' ? 'postgres' : '')

  const config: StoredConnection = {
    id: meta.id,
    name,
    dialect: input.dialect,
    host,
    port: input.port,
    database,
    user: str(input.user).trim(),
    savePassword: input.savePassword !== false,
    ssl,
    ssh,
    color,
    readOnly: input.readOnly === true,
    productionGuard: input.productionGuard === true,
    options,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  }
  const group = optStr(input.group)
  if (group) config.group = group

  // Authentication: legacy entries (no authMode) use a password.
  if (input.authMode !== undefined && input.authMode !== null && !AUTH_MODES.includes(input.authMode)) {
    if (!lenient) throw invalid('Unknown authentication mode.')
  }
  const authMode: ConnectionAuthMode = input.authMode === 'vault' ? 'vault' : 'password'
  config.authMode = authMode
  if (authMode === 'vault') {
    config.vault = validateVaultConfig(input.vault, { lenient })
  } else if (isRecord(input.vault)) {
    // Kept (unchecked) so switching back to Vault does not lose the settings.
    const kept = validateVaultConfig(input.vault, { lenient: true })
    if (kept.address || kept.secretPath) config.vault = kept
  }
  return config
}

function validateSsh(raw: Partial<SshConfig>): SshConfig {
  const enabled = raw.enabled === true
  const authMethod = SSH_METHODS.includes(raw.authMethod as SshAuthMethod) ? (raw.authMethod as SshAuthMethod) : 'password'
  const ssh: SshConfig = {
    enabled,
    host: str(raw.host).trim(),
    port: isPort(raw.port) ? raw.port : 22,
    username: str(raw.username).trim(),
    authMethod,
  }
  const keyPath = optStr(raw.privateKeyPath)
  if (keyPath) ssh.privateKeyPath = keyPath
  if (!enabled) return ssh
  if (!ssh.host) throw invalid('SSH host is required.')
  if (raw.port !== undefined && !isPort(raw.port)) throw invalid('SSH port must be a number between 1 and 65535.')
  if (!ssh.username) throw invalid('SSH user is required.')
  if (!SSH_METHODS.includes(raw.authMethod as SshAuthMethod)) throw invalid('Unknown SSH authentication method.')
  if (authMethod === 'privateKey' && !ssh.privateKeyPath) throw invalid('SSH private key file is required.')
  return ssh
}

function sanitizeOptions(raw: Partial<ConnectionOptions>): ConnectionOptions {
  const options: ConnectionOptions = {}
  const applicationName = optStr(raw.applicationName)
  if (applicationName) options.applicationName = applicationName
  if (typeof raw.connectTimeoutMs === 'number' && Number.isFinite(raw.connectTimeoutMs) && raw.connectTimeoutMs > 0) {
    options.connectTimeoutMs = Math.min(Math.round(raw.connectTimeoutMs), 600_000)
  }
  const instanceName = optStr(raw.instanceName)
  if (instanceName) options.instanceName = instanceName
  if (typeof raw.showSystemObjects === 'boolean') options.showSystemObjects = raw.showSystemObjects
  const defaultSchema = optStr(raw.defaultSchema)
  if (defaultSchema) options.defaultSchema = defaultSchema
  const timeZone = optStr(raw.timeZone)
  if (timeZone && timeZone.toLowerCase() !== 'server') {
    if (!/^[A-Za-z0-9_+\-/:.]{1,64}$/.test(timeZone)) throw invalid('Time zone must be a zone name such as Europe/Paris, or "local".')
    options.timeZone = timeZone.toLowerCase() === 'local' ? 'local' : timeZone
  }
  return options
}

/** Lenient reader for connections.json entries (older/hand-edited files). */
function coerceStoredConnection(raw: unknown): StoredConnection | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) return null
  const dialect = DIALECTS.includes(raw.dialect as Dialect) ? (raw.dialect as Dialect) : null
  if (!dialect) return null
  const port = isPort(raw.port) ? raw.port : DEFAULT_PORT[dialect]
  try {
    const ssh = isRecord(raw.ssh) ? (raw.ssh as Partial<SshConfig>) : {}
    let validSsh: SshConfig
    try {
      validSsh = validateSsh(ssh)
    } catch {
      validSsh = { ...validateSsh({ ...ssh, enabled: false }), enabled: false }
    }
    const config = validateConnectionInput(
      {
        ...(raw as unknown as ConnectionInput),
        name: str(raw.name).trim() || 'Untitled',
        host: str(raw.host).trim() || 'localhost',
        dialect,
        port,
        ssh: validSsh,
      },
      {
        id: raw.id,
        createdAt: str(raw.createdAt) || new Date(0).toISOString(),
        updatedAt: str(raw.updatedAt) || str(raw.createdAt) || new Date(0).toISOString(),
      },
      // Incomplete Vault settings are kept (connecting reports them) rather than dropping the connection.
      { lenient: true },
    )
    return config
  } catch {
    return null
  }
}

/** Build a transient config for connections:test (validates like save). */
export function configForTest(input: ConnectionInput, existing?: ConnectionConfig): ConnectionConfig {
  const nowIso = new Date().toISOString()
  const config = validateConnectionInput(input, {
    id: input.id ?? existing?.id ?? randomUUID(),
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
  })
  return { ...config, hasPassword: false }
}
