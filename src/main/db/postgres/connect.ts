// Client configuration (auth, TLS per SslMode) and connection establishment.
import { readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { checkServerIdentity, type ConnectionOptions as TlsOptions } from 'node:tls'
import pg from 'pg'
import type { ClientConfig } from 'pg'
import type { ServerInfo } from '@shared/types'
import { DriverError } from '../errors'
import type { ResolvedConnection } from '../types'
import { toConnectionError } from './errors'
import { select, str, optStr } from './rows'
import { pgTypes } from './values'

export const DEFAULT_APPLICATION_NAME = 'DataGrippe'
export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000
/**
 * Idle time before the first TCP keepalive probe. pg's default (0) keeps the OS default (2 h on macOS / Linux),
 * far beyond the idle timeouts of NAT gateways, VPNs, cloud load balancers (AWS NLB: 350 s) and SSH tunnels.
 */
export const KEEPALIVE_INITIAL_DELAY_MS = 30_000

/** TLS options as resolved for a connection: false = plain TCP. */
export type TlsSetting = false | TlsOptions

function readPem(path: string | undefined, label: string): string | undefined {
  if (!path) return undefined
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw DriverError.of('invalid-input', `Cannot read SSL ${label} file "${path}": ${reason}`)
  }
}

/** TLS options for the first connection attempt (prefer starts with TLS, see connectClient). */
export function initialTls(connection: ResolvedConnection): TlsSetting {
  const { ssl, host } = connection.config
  switch (ssl.mode) {
    case 'disable':
      return false
    case 'prefer':
    case 'require':
      return { rejectUnauthorized: false }
    case 'verify-full': {
      const options: TlsOptions = {
        rejectUnauthorized: true,
        ca: readPem(ssl.caPath, 'CA'),
        cert: readPem(ssl.certPath, 'certificate'),
        key: readPem(ssl.keyPath, 'key'),
      }
      // Through an SSH tunnel we dial 127.0.0.1: verify the certificate against the configured host.
      if (isIP(host) === 0) options.servername = host
      options.checkServerIdentity = (_dialed, cert) => checkServerIdentity(host, cert)
      return options
    }
  }
}

/**
 * Session time zone requested by the connection options: undefined = the server's TimeZone setting,
 * "local" = this computer's zone, anything else = a zone name passed to the server as is.
 * Read structurally: the option is optional in the connection settings (ConnectionOptions.timeZone).
 */
export function sessionTimeZone(options: ResolvedConnection['config']['options']): string | undefined {
  const raw = 'timeZone' in options && typeof options.timeZone === 'string' ? options.timeZone.trim() : ''
  if (raw === '' || raw.toLowerCase() === 'server') return undefined
  if (raw.toLowerCase() === 'local') return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  return raw
}

/** One `-c name=value` startup option; spaces and backslashes are backslash-escaped as the server expects. */
function startupOption(name: string, value: string): string {
  return `-c ${name}=${value.replace(/[\\\s]/g, (ch) => `\\${ch}`)}`
}

export function clientConfig(connection: ResolvedConnection, database: string, tls: TlsSetting): ClientConfig {
  const { config, secrets } = connection
  const result: ClientConfig = {
    host: connection.host,
    port: connection.port,
    user: config.user,
    database,
    application_name: config.options.applicationName || DEFAULT_APPLICATION_NAME,
    connectionTimeoutMillis: config.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    keepAlive: true,
    keepAliveInitialDelayMillis: KEEPALIVE_INITIAL_DELAY_MS,
    ssl: tls,
    types: pgTypes,
  }
  if (secrets.password !== undefined) result.password = secrets.password
  const timeZone = sessionTimeZone(config.options)
  if (timeZone) result.options = startupOption('TimeZone', timeZone)
  return result
}

function serverRejectedTls(error: unknown): boolean {
  return error instanceof Error && /does not support SSL/i.test(error.message)
}

export interface ConnectedClient {
  client: pg.Client
  /** The TLS setting that worked (prefer may have fallen back to plain TCP). */
  tls: TlsSetting
}

async function attempt(connection: ResolvedConnection, database: string, tls: TlsSetting): Promise<pg.Client> {
  const client = new pg.Client(clientConfig(connection, database, tls))
  // Errors after connect are surfaced by the owner; this guard prevents an unhandled 'error' event.
  client.on('error', () => undefined)
  try {
    await client.connect()
    return client
  } catch (error) {
    await client.end().catch(() => undefined)
    throw error
  }
}

/**
 * Open a client. With sslmode=prefer, a server without TLS support is retried without TLS.
 * Pass `tls` to reuse the setting resolved by an earlier connection.
 */
export async function connectClient(
  connection: ResolvedConnection,
  database: string,
  tls: TlsSetting = initialTls(connection),
): Promise<ConnectedClient> {
  try {
    return { client: await attempt(connection, database, tls), tls }
  } catch (error) {
    if (connection.config.ssl.mode === 'prefer' && tls !== false && serverRejectedTls(error)) {
      try {
        return { client: await attempt(connection, database, false), tls: false }
      } catch (retryError) {
        throw toConnectionError(retryError)
      }
    }
    throw toConnectionError(error)
  }
}

const SERVER_INFO_SQL = `SELECT version() AS version, current_setting('server_version') AS short,
  current_database() AS db, current_user AS usr, current_schema() AS sch`

export async function queryServerInfo(q: pg.ClientBase | pg.Pool): Promise<ServerInfo> {
  const [row] = await select(q, SERVER_INFO_SQL)
  if (!row) throw DriverError.of('internal', 'Server info query returned no rows')
  return {
    dialect: 'postgres',
    version: str(row, 'version'),
    versionShort: str(row, 'short').split(' ')[0] ?? '',
    currentDatabase: str(row, 'db'),
    currentUser: str(row, 'usr'),
    currentSchema: optStr(row, 'sch'),
  }
}

/** Run `fn` on a short-lived client and always disconnect it. */
export async function withClient<T>(
  connection: ResolvedConnection,
  database: string,
  tls: TlsSetting,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const { client } = await connectClient(connection, database, tls)
  try {
    return await fn(client)
  } finally {
    await client.end().catch(() => undefined)
  }
}
