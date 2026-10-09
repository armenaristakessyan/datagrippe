// DBeaver data-sources*.json → DataGrippe ConnectionInput. Pure: no file access, no secrets.
//
// DBeaver format (modern serializer):
//   { "folders": { "A": {}, "A/B": { "parent": "A" } },
//     "connection-types": { "prod": { "name", "color": "r,g,b", "confirm-execute", … } },
//     "connections": { "<id>": { provider, driver, name, folder, "read-only", "save-password",
//       "navigator-show-system-objects"?, configuration: { host, port, server, database, url, user, type,
//       "auth-model", "auth-properties", "provider-properties", properties, bootstrap, handlers } } } }
// Passwords live in DBeaver's encrypted credentials-config*.json, which is never read.
import {
  CONNECTION_COLORS,
  DEFAULT_PORT,
  type ConnectionColor,
  type ConnectionConfig,
  type ConnectionInput,
  type ConnectionOptions,
  type DbeaverImportCandidate,
  type Dialect,
  type SshAuthMethod,
  type SshConfig,
  type SslConfig,
  type SslMode,
  type VaultConfig,
  type VaultLoginMethod,
} from '@shared/types'
import { normalizeVaultAddress } from '../vault/client'
import { parseJdbcUrl, type ParsedJdbcUrl } from './dbeaver-jdbc'

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Strings, and numbers / booleans DBeaver sometimes writes unquoted. */
function text(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  return ''
}

function bool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  const t = text(value).toLowerCase()
  if (t === 'true' || t === 'yes' || t === '1') return true
  if (t === 'false' || t === 'no' || t === '0') return false
  return undefined
}

function toPort(value: unknown): number | undefined {
  const t = text(value)
  if (!/^\d{1,5}$/.test(t)) return undefined
  const port = Number(t)
  return port >= 1 && port <= 65535 ? port : undefined
}

/** Object keys lower-cased (DBeaver / JDBC property names are case-insensitive in practice). */
function lowerKeys(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!isObject(value)) return out
  for (const [key, raw] of Object.entries(value)) {
    const v = text(raw)
    if (v !== '') out[key.toLowerCase()] = v
  }
  return out
}

function quote(value: string): string {
  return `"${value}"`
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

interface DialectChoice {
  dialect: Dialect | null
  /** Shown to the user (compatible engine imported as PostgreSQL, or why it is unsupported). */
  note?: string
}

/** PostgreSQL forks / extensions that speak the PostgreSQL protocol and catalog well enough. */
const PG_COMPATIBLE: Array<[RegExp, string]> = [
  [/greenplum/, 'Greenplum'],
  [/timescale/, 'TimescaleDB'],
  [/enterprisedb|^edb\b|edb[-_]/, 'EDB Postgres'],
]

/** Engines that use the PostgreSQL / TDS wire protocol but whose catalogs differ too much. */
const NOT_COMPATIBLE = /redshift|cockroach|yugabyte|babelfish|materialize|yellowbrick|synapse|sybase/

export function chooseDialect(provider: string, driver: string): DialectChoice {
  const p = provider.toLowerCase()
  const d = driver.toLowerCase()
  const unsupported: DialectChoice = { dialect: null, note: `Unsupported provider ${provider || driver || 'unknown'}` }
  if (NOT_COMPATIBLE.test(p) || NOT_COMPATIBLE.test(d)) return unsupported
  for (const [re, label] of PG_COMPATIBLE) {
    if (re.test(p) || re.test(d)) {
      return { dialect: 'postgres', note: `${label} connection imported as PostgreSQL: some features may not work` }
    }
  }
  if (p === 'postgresql' || p === 'postgres' || p === 'postgre') return { dialect: 'postgres' }
  if (p === 'sqlserver' || p === 'mssql' || /^azure[-_ ]?sql/.test(p)) return { dialect: 'mssql' }
  return unsupported
}

// ---------------------------------------------------------------------------
// Colors and production heuristics
// ---------------------------------------------------------------------------

interface Rgb {
  r: number
  g: number
  b: number
}

export function parseDbeaverColor(value: unknown): Rgb | null {
  const t = text(value)
  if (!t) return null
  const hex = /^#?([0-9a-f]{6})$/i.exec(t)
  if (hex) {
    const n = parseInt(hex[1], 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
  }
  const parts = t.split(',').map((s) => s.trim())
  if (parts.length !== 3 || !parts.every((s) => /^\d{1,3}$/.test(s))) return null
  const [r, g, b] = parts.map(Number)
  if (r > 255 || g > 255 || b > 255) return null
  return { r, g, b }
}

function hsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  const delta = max - min
  if (delta === 0) return { h: 0, s: 0, l }
  const s = delta / (1 - Math.abs(2 * l - 1))
  let h: number
  if (max === rn) h = ((gn - bn) / delta) % 6
  else if (max === gn) h = (bn - rn) / delta + 2
  else h = (rn - gn) / delta + 4
  h *= 60
  if (h < 0) h += 360
  return { h, s, l }
}

/** Nearest ConnectionColor for an "r,g,b" DBeaver color; null when it is white / black / ambiguous. */
export function nearestConnectionColor(value: unknown): ConnectionColor | null {
  const rgb = parseDbeaverColor(value)
  if (!rgb) return null
  const { h, s, l } = hsl(rgb)
  if (s < 0.15 || l > 0.93 || l < 0.07) {
    // Greys: white is DBeaver's "no color" (the default "dev" type), black is not a meaningful choice.
    return l >= 0.2 && l <= 0.85 ? 'gray' : null
  }
  if (s < 0.25) return null
  if (h >= 340 || h < 20) return 'red'
  if (h < 45) return 'orange'
  if (h < 70) return 'yellow'
  if (h < 170) return 'green'
  if (h < 255) return 'blue'
  if (h < 340) return 'purple'
  return null
}

function isRedish(value: unknown): boolean {
  return nearestConnectionColor(value) === 'red'
}

/** "prod" / "production" as a word ("billing-prod", "PROD", "prod_eu") but not "preprod" / "non-prod". */
const PROD_RE = /(?<![a-z0-9])(?<!(?:non|pre|not)[-_ ]?)prod(?:uction)?(?![a-z0-9])/i

export function looksLikeProduction(value: string | undefined): boolean {
  return Boolean(value && PROD_RE.test(value))
}

// ---------------------------------------------------------------------------
// SSL
// ---------------------------------------------------------------------------

function firstOf(props: Record<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = props[key.toLowerCase()]
    if (v) return v
  }
  return undefined
}

export interface SslResult {
  ssl: SslConfig
  notes: string[]
}

function pgSslMode(raw: string, notes: string[]): SslMode | undefined {
  switch (raw.trim().toLowerCase()) {
    case 'disable':
      return 'disable'
    case 'allow':
      notes.push('SSL mode "allow" imported as "prefer"')
      return 'prefer'
    case 'prefer':
      return 'prefer'
    case 'require':
      return 'require'
    case 'verify-ca':
    case 'verify_ca':
      notes.push('SSL mode "verify-ca" imported as "verify-full" (the host name is verified too)')
      return 'verify-full'
    case 'verify-full':
    case 'verify_full':
      return 'verify-full'
    default:
      return undefined
  }
}

export function postgresSsl(sslHandler: Json | null, driverProps: Record<string, string>, url: ParsedJdbcUrl | null): SslResult {
  const notes: string[] = []
  const handlerProps = sslHandler ? lowerKeys(sslHandler.properties) : {}
  const merged: Record<string, string> = { ...(url?.params ?? {}), ...driverProps, ...handlerProps }
  const modeKeys = ['sslMode', 'ssl.mode', 'ssl_mode']
  const rawMode = firstOf(handlerProps, modeKeys) ?? firstOf(driverProps, modeKeys) ?? firstOf(url?.params ?? {}, modeKeys)
  const caPath = firstOf(merged, ['sslRootCert', 'ssl.ca.cert', 'ssl.root.cert', 'sslrootcert'])
  const certPath = firstOf(merged, ['sslClientCert', 'ssl.client.cert', 'sslcert'])
  const keyPath = firstOf(merged, ['sslClientKey', 'ssl.client.key', 'sslkey'])
  const sslOn = sslHandler !== null || bool(merged.ssl) === true

  let mode: SslMode | undefined = rawMode ? pgSslMode(rawMode, notes) : undefined
  if (rawMode && !mode) notes.push(`Unknown SSL mode ${quote(rawMode)}: using "prefer"`)
  if (!mode) {
    if (sslOn) mode = caPath ? 'verify-full' : 'require'
    else mode = 'prefer'
  }
  const ssl: SslConfig = { mode }
  if (mode !== 'disable') {
    if (caPath) ssl.caPath = caPath
    if (certPath) ssl.certPath = certPath
    if (keyPath) ssl.keyPath = keyPath
    if (keyPath && /\.(pk8|der|p12|pfx)$/i.test(keyPath)) notes.push('The SSL client key must be a PEM file: convert it if needed')
  }
  return { ssl, notes }
}

export function sqlServerSsl(
  sslHandler: Json | null,
  driverProps: Record<string, string>,
  providerProps: Record<string, string>,
  url: ParsedJdbcUrl | null,
): SslResult {
  const notes: string[] = []
  const props: Record<string, string> = { ...(url?.params ?? {}), ...driverProps }
  if (url?.kind === 'jtds' || props.ssl) {
    const jtds = (props.ssl ?? '').toLowerCase()
    if (jtds === 'off') return { ssl: { mode: 'disable' }, notes }
    if (jtds === 'request' || jtds === 'require') return { ssl: { mode: 'require' }, notes }
    if (jtds === 'authenticate') return { ssl: { mode: 'verify-full' }, notes }
  }
  const encryptRaw = (props.encrypt ?? '').toLowerCase()
  const encrypt = encryptRaw === 'mandatory' || encryptRaw === 'strict' ? true : encryptRaw === 'optional' ? false : bool(encryptRaw)
  const trust = bool(providerProps.ssltrustservercertificate) ?? bool(props.trustservercertificate)
  if (encrypt === false && trust !== true) return { ssl: { mode: 'disable' }, notes }
  if (trust === true) return { ssl: { mode: 'require' }, notes }
  if (encrypt === true || trust === false || sslHandler !== null) {
    if (props.truststore) notes.push('Java trust stores are not imported: set a PEM CA file if the server certificate is private')
    return { ssl: { mode: 'verify-full' }, notes }
  }
  return { ssl: { mode: 'require' }, notes }
}

// ---------------------------------------------------------------------------
// SSH
// ---------------------------------------------------------------------------

const DISABLED_SSH: SshConfig = { enabled: false, host: '', port: 22, username: '', authMethod: 'privateKey' }

function mapSsh(handler: Json): { ssh: SshConfig; notes: string[] } {
  const notes: string[] = []
  const props = isObject(handler.properties) ? handler.properties : {}
  const lower = lowerKeys(props)
  const host = lower.host ?? ''
  const port = toPort(lower.port) ?? 22
  const username = text(handler.user) || lower.user || lower.username || ''
  const authType = (lower.authtype ?? '').toUpperCase()
  const authMethod: SshAuthMethod = authType === 'PASSWORD' ? 'password' : authType === 'AGENT' ? 'agent' : 'privateKey'
  const privateKeyPath = lower.keypath || lower.privatekeypath || lower.key || ''
  const ssh: SshConfig = { enabled: true, host, port, username, authMethod }
  if (authMethod === 'privateKey' && privateKeyPath) ssh.privateKeyPath = privateKeyPath

  const missing: string[] = []
  if (!host) missing.push('host')
  if (!username) missing.push('user')
  if (authMethod === 'privateKey' && !privateKeyPath) missing.push('private key file')
  if (Object.entries(props).some(([key, value]) => /jump/i.test(key) && text(value) !== '' && bool(value) !== false)) {
    notes.push('SSH jump hosts are not imported: only the first SSH host is used')
  }
  if (missing.length > 0) {
    ssh.enabled = false
    const where = host ? ` via ${host}` : ''
    notes.push(`SSH tunnel${where}: set the SSH ${missing.join(' and ')}, then enable the tunnel`)
  } else {
    if (authMethod === 'password') notes.push('Enter the SSH password when connecting')
    if (authMethod === 'privateKey') notes.push('Enter the SSH key passphrase when connecting, if it has one')
  }
  return { ssh, notes }
}

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

/** Keys that may hold secrets: never read, whatever their value. */
const SECRET_KEY = /token|password|passwd|pwd|secret[-_.]?id|credential|private|api[-_.]?key|client[-_.]?secret/i

const LOGIN_METHODS: VaultLoginMethod[] = ['token', 'oidc', 'ldap', 'userpass']

function mapVault(authProps: unknown, notes: string[]): VaultConfig {
  const vault: VaultConfig = { address: '', loginMethod: 'oidc', secretPath: '', revokeOnDisconnect: true }
  const hints: string[] = []
  let methodHinted = false
  if (isObject(authProps)) {
    for (const [key, raw] of Object.entries(authProps)) {
      if (SECRET_KEY.test(key)) continue
      const value = text(raw)
      if (!value) continue
      const k = key.toLowerCase()
      if (/namespace/.test(k)) {
        if (!vault.namespace && /^[\w./-]+$/.test(value)) {
          vault.namespace = value.replace(/^\/+|\/+$/g, '')
          hints.push(`namespace (${quote(key)})`)
        }
      } else if (/mount|auth[-_.]?path/.test(k)) {
        if (!vault.authMount && /^[\w./-]+$/.test(value)) {
          vault.authMount = value.replace(/^\/+|\/+$/g, '')
          hints.push(`auth mount (${quote(key)})`)
        }
      } else if (/method|auth[-_.]?type|login/.test(k)) {
        const method = value.toLowerCase()
        if (method === 'token') {
          // The token method sends the user's Vault CLI token: a shared or hostile file must not choose it.
          methodHinted = true
          notes.push('Vault sign-in method "token" from DBeaver is not applied: using OIDC, choose "Token" yourself if you want it')
        } else if (LOGIN_METHODS.includes(method as VaultLoginMethod)) {
          vault.loginMethod = method as VaultLoginMethod
          methodHinted = true
          hints.push(`sign-in method (${quote(key)})`)
        } else {
          notes.push(`Vault sign-in method ${quote(value)} is not supported: using OIDC`)
        }
      } else if (/address|url|host|server|endpoint/.test(k)) {
        if (!vault.address && /^https?:\/\/[^\s]+$/i.test(value)) {
          try {
            vault.address = normalizeVaultAddress(value)
            hints.push(`address (${quote(key)})`)
          } catch (error) {
            // e.g. plain http:// to a remote host: tokens and passwords would travel in clear.
            notes.push(`Vault address ${quote(value)} is not used: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      } else if (/path|secret|role/.test(k)) {
        if (vault.secretPath || /\s/.test(value)) continue
        const path = value.replace(/^\/+/, '').replace(/^v1\//, '')
        if (path.includes('/')) {
          vault.secretPath = path
          hints.push(`secret path (${quote(key)})`)
        } else if (/role/.test(k)) {
          vault.secretPath = `database/creds/${path}`
          hints.push(`secret path from the role (${quote(key)})`)
        }
      } else if (/user/.test(k)) {
        if (!vault.username && /^[^\s]+$/.test(value)) vault.username = value
      }
    }
  }
  if (hints.length > 0) notes.push(`Vault ${hints.join(', ')} taken from the DBeaver authentication settings`)
  if (!vault.address && !vault.secretPath) notes.push('Set the Vault address and secret path')
  else if (!vault.address) notes.push('Set the Vault address')
  else if (!vault.secretPath) notes.push('Set the Vault secret path')
  if (!methodHinted) notes.push('Vault sign-in uses OIDC (browser) by default: change it if your Vault uses another method')
  if (vault.loginMethod === 'oidc' || vault.loginMethod === 'token') delete vault.username
  return vault
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export interface DbeaverFileContext {
  file: string
  /** Top-level "connection-types" of the file (custom types, colors, confirm-execute). */
  connectionTypes: Json
}

export function fileContext(file: string, root: Json): DbeaverFileContext {
  return { file, connectionTypes: isObject(root['connection-types']) ? root['connection-types'] : {} }
}

function authModelKind(model: string): 'native' | 'vault' | 'pgpass' | 'other' {
  const m = model.toLowerCase()
  if (!m || m === 'native' || m.endsWith('_native') || m.endsWith('-native')) return 'native'
  if (m.includes('vault')) return 'vault'
  if (m.includes('pgpass')) return 'pgpass'
  return 'other'
}

function connectionTypeIsProduction(typeId: string, entry: Json | null): boolean {
  if (typeId.toLowerCase() === 'prod') return true
  if (!entry) return false
  if (bool(entry['confirm-execute']) === true || bool(entry.confirmExecute) === true) return true
  if (looksLikeProduction(text(entry.name))) return true
  return isRedish(entry.color)
}

/** Map one DBeaver connection. `id` is its key in "connections". */
export function mapConnection(id: string, raw: unknown, ctx: DbeaverFileContext): DbeaverImportCandidate {
  const conn = isObject(raw) ? raw : {}
  const cfg = isObject(conn.configuration) ? conn.configuration : {}
  const provider = text(conn.provider)
  const driver = text(conn.driver)
  const sourceName = text(conn.name) || id
  const folder = text(conn.folder)
  const candidate: DbeaverImportCandidate = {
    sourceId: id,
    sourceFile: ctx.file,
    sourceName,
    sourceProvider: provider || driver || 'unknown',
    input: null,
    notes: [],
  }
  if (folder) candidate.sourceFolder = folder
  const notes = candidate.notes

  const choice = chooseDialect(provider, driver)
  if (choice.note) notes.push(choice.note)
  const dialect = choice.dialect
  if (!dialect) return candidate

  // Host / port / database: explicit fields first (MANUAL), the URL when DBeaver was given a URL.
  const url = parseJdbcUrl(cfg.url)
  const urlFirst = text(cfg.configurationType).toUpperCase() === 'URL'
  const urlHost = url?.hosts[0]
  if (url && url.hosts.length > 1) notes.push(`Only the first host of the URL is used (${url.hosts.length} hosts listed)`)
  let host = urlFirst ? (urlHost?.host ?? text(cfg.host)) : text(cfg.host) || text(cfg.server) || urlHost?.host || ''
  const cfgPort = toPort(cfg.port)
  if (text(cfg.port) && !cfgPort) notes.push(`Invalid port ${quote(text(cfg.port))}: using ${DEFAULT_PORT[dialect]}`)
  const port = (urlFirst ? (urlHost?.port ?? cfgPort) : (cfgPort ?? urlHost?.port)) ?? DEFAULT_PORT[dialect]
  let database = urlFirst ? (url?.database ?? text(cfg.database)) : text(cfg.database) || url?.database || ''
  let instanceName = url?.instanceName
  if (dialect === 'mssql') {
    // "host\INSTANCE" / "host\INSTANCE:port" in the host field.
    const slash = host.indexOf('\\')
    if (slash >= 0) {
      instanceName = host.slice(slash + 1).trim() || instanceName
      host = host.slice(0, slash).trim()
    }
  }
  if (!host) {
    host = 'localhost'
    notes.push('No host in the DBeaver connection: using localhost')
  }
  if (dialect === 'postgres' && !database) database = 'postgres'

  const driverProps = lowerKeys(cfg.properties)
  const providerProps = lowerKeys(cfg['provider-properties'])

  // Network handlers.
  const handlers = isObject(cfg.handlers) ? cfg.handlers : {}
  let ssh: SshConfig = { ...DISABLED_SSH }
  let sslHandler: Json | null = null
  for (const [handlerId, value] of Object.entries(handlers)) {
    if (!isObject(value) || bool(value.enabled) !== true) continue
    const hid = handlerId.toLowerCase()
    if (hid === 'ssh_tunnel' || hid.startsWith('ssh')) {
      if (ssh.enabled || ssh.host) {
        notes.push('Only one SSH tunnel is imported')
        continue
      }
      const mapped = mapSsh(value)
      ssh = mapped.ssh
      notes.push(...mapped.notes)
    } else if (hid.includes('ssl') || hid.includes('tls')) {
      sslHandler = value
    } else {
      notes.push(`Network handler ${quote(handlerId)} is not supported`)
    }
  }

  const { ssl, notes: sslNotes } =
    dialect === 'postgres' ? postgresSsl(sslHandler, driverProps, url) : sqlServerSsl(sslHandler, driverProps, providerProps, url)
  notes.push(...sslNotes)

  // Authentication.
  const user = text(cfg.user) || text(url?.params.user) || text(url?.params.username)
  const authModel = text(cfg['auth-model'])
  const authKind = authModelKind(authModel)
  let vault: VaultConfig | undefined
  if (authKind === 'vault') {
    vault = mapVault(cfg['auth-properties'], notes)
  } else {
    if (authKind === 'pgpass') notes.push('DBeaver read the password from .pgpass: enter it when connecting')
    else if (authKind === 'other') notes.push(`DBeaver authentication ${quote(authModel)} is not supported: using a user name and password`)
    else notes.push('Enter the password when connecting')
    if (!user) notes.push('Set the user name (DBeaver keeps it with its saved credentials)')
  }

  // Production / color.
  const typeId = text(cfg.type)
  const typeEntry = typeId && isObject(ctx.connectionTypes[typeId]) ? (ctx.connectionTypes[typeId] as Json) : null
  const production = connectionTypeIsProduction(typeId, typeEntry) || looksLikeProduction(folder) || looksLikeProduction(sourceName)
  let color: ConnectionColor = 'none'
  if (production) {
    color = 'red'
    notes.push('Marked as production')
  } else {
    const explicit = nearestConnectionColor(cfg.color) ?? nearestConnectionColor(conn.color)
    color = explicit ?? nearestConnectionColor(typeEntry?.color) ?? 'none'
  }
  if (!CONNECTION_COLORS.includes(color)) color = 'none'

  // Options.
  const options: ConnectionOptions = {}
  if (instanceName && dialect === 'mssql') options.instanceName = instanceName
  const navSystem = bool(conn['navigator-show-system-objects'])
  if (navSystem !== undefined) options.showSystemObjects = navSystem
  else if (dialect === 'mssql') {
    const allSchemas = bool(providerProps['@dbeaver-show-all-schemas@'])
    if (allSchemas !== undefined) options.showSystemObjects = allSchemas
  }
  const bootstrap = isObject(cfg.bootstrap) ? cfg.bootstrap : {}
  const defaultSchema = text(bootstrap.defaultSchema)
  if (defaultSchema) options.defaultSchema = defaultSchema

  const input: ConnectionInput = {
    name: sourceName,
    dialect,
    host,
    port,
    database,
    user,
    savePassword: false,
    ssl,
    ssh,
    color,
    readOnly: bool(conn['read-only']) === true || bool(cfg['read-only']) === true,
    productionGuard: production,
    options,
  }
  if (folder) input.group = folder
  if (vault) {
    input.authMode = 'vault'
    input.vault = vault
  } else {
    input.authMode = 'password'
  }
  candidate.input = input
  return candidate
}

// ---------------------------------------------------------------------------
// Duplicates and ordering
// ---------------------------------------------------------------------------

function sameDatabase(dialect: Dialect, a: string, b: string): boolean {
  const norm = (v: string) => (dialect === 'postgres' ? v.trim() || 'postgres' : v.trim().toLowerCase())
  return norm(a) === norm(b)
}

export function findDuplicate(input: ConnectionInput, existing: readonly ConnectionConfig[]): string | undefined {
  const host = input.host.trim().toLowerCase()
  return existing.find(
    (c) =>
      c.dialect === input.dialect &&
      c.host.trim().toLowerCase() === host &&
      c.port === input.port &&
      sameDatabase(input.dialect, c.database, input.database),
  )?.id
}

function compareText(a: string, b: string): number {
  const c = a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true })
  if (c !== 0) return c
  return a < b ? -1 : a > b ? 1 : 0
}

/** Stable order: folder (ungrouped first), name, then file and DBeaver id. */
export function compareCandidates(a: DbeaverImportCandidate, b: DbeaverImportCandidate): number {
  return (
    compareText(a.sourceFolder ?? '', b.sourceFolder ?? '') ||
    compareText(a.sourceName, b.sourceName) ||
    compareText(a.sourceFile, b.sourceFile) ||
    compareText(a.sourceId, b.sourceId)
  )
}
