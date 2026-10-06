// ResolvedConnection → tedious / mssql configuration.

import { readFile } from 'node:fs/promises'
import type { config as MssqlConfig } from 'mssql'
import type { ConnectionConfiguration } from 'tedious'
import { DriverError } from '../errors'
import type { ResolvedConnection } from '../types'

export const DEFAULT_APP_NAME = 'DataGrippe'
export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000

/** Options shared by the session connection and the metadata pool. */
export interface CommonOptions {
  server: string
  port?: number
  instanceName?: string
  database?: string
  userName: string
  password: string
  encrypt: boolean
  trustServerCertificate: boolean
  ca?: Buffer
  /** TLS server name when dialing through a tunnel (certificate checks use the real host). */
  serverName?: string
  appName: string
  connectTimeout: number
}

export async function resolveOptions(connection: ResolvedConnection, database?: string): Promise<CommonOptions> {
  const { config, secrets } = connection
  // Through an SSH tunnel the driver dials the local forward (always 127.0.0.1, even when the database
  // host is 127.0.0.1 too), which leads to config.host:config.port. SQL Browser cannot be asked through
  // it, so a named instance is reached by its TCP port (the connection's port) and its name is not used.
  const tunnelled = config.ssh?.enabled === true || connection.host !== config.host
  const instanceName = config.options.instanceName?.trim()
  const useInstance = Boolean(instanceName) && !tunnelled
  const mode = config.ssl.mode

  let ca: Buffer | undefined
  if (mode === 'verify-full' && config.ssl.caPath) {
    try {
      ca = await readFile(config.ssl.caPath)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw DriverError.of('invalid-input', `Cannot read CA certificate ${config.ssl.caPath}: ${reason}`)
    }
  }

  const db = (database ?? config.database).trim()
  return {
    server: connection.host,
    port: useInstance ? undefined : connection.port,
    instanceName: useInstance ? instanceName : undefined,
    database: db === '' ? undefined : db,
    userName: config.user,
    password: secrets.password ?? '',
    encrypt: mode !== 'disable',
    trustServerCertificate: mode !== 'verify-full',
    ca,
    serverName: tunnelled && mode === 'verify-full' ? config.host : undefined,
    appName: config.options.applicationName?.trim() || DEFAULT_APP_NAME,
    connectTimeout: config.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
  }
}

export function tediousConfig(options: CommonOptions): ConnectionConfiguration {
  return {
    server: options.server,
    authentication: { type: 'default', options: { userName: options.userName, password: options.password } },
    options: {
      ...(options.port !== undefined ? { port: options.port } : {}),
      ...(options.instanceName ? { instanceName: options.instanceName } : {}),
      ...(options.database ? { database: options.database } : {}),
      ...(options.ca ? { cryptoCredentialsDetails: { ca: options.ca } } : {}),
      ...(options.serverName ? { serverName: options.serverName } : {}),
      encrypt: options.encrypt,
      trustServerCertificate: options.trustServerCertificate,
      appName: options.appName,
      connectTimeout: options.connectTimeout,
      requestTimeout: 0,
      cancelTimeout: 5000,
      useUTC: true,
      enableArithAbort: true,
      useColumnNames: false,
      rowCollectionOnDone: false,
      rowCollectionOnRequestCompletion: false,
    },
  }
}

export function mssqlConfig(options: CommonOptions, maxConnections: number): MssqlConfig {
  return {
    server: options.server,
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.database ? { database: options.database } : {}),
    user: options.userName,
    password: options.password,
    connectionTimeout: options.connectTimeout,
    requestTimeout: 0,
    pool: { max: maxConnections, min: 0, idleTimeoutMillis: 60_000 },
    options: {
      ...(options.instanceName ? { instanceName: options.instanceName } : {}),
      ...(options.ca ? { cryptoCredentialsDetails: { ca: options.ca } } : {}),
      ...(options.serverName ? { serverName: options.serverName } : {}),
      encrypt: options.encrypt,
      trustServerCertificate: options.trustServerCertificate,
      appName: options.appName,
      useUTC: true,
      enableArithAbort: true,
    },
  }
}
