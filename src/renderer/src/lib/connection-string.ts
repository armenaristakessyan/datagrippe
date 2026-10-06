// Parse pasted connection strings into connection-form values. Supported shapes:
//  - URLs: postgres:// · postgresql:// · jdbc:postgresql:// · sqlserver:// · mssql://
//  - libpq keyword/value: host=… port=… dbname=… user=… password=… sslmode=…
//  - SQL Server ADO.NET / ODBC: Server=host,port;Database=…;User Id=…;Password=…;Encrypt=…
//  - JDBC SQL Server: jdbc:sqlserver://host:port;databaseName=…;user=…;password=…
import type { Dialect, SslMode } from '@shared/types'

export interface ParsedConnection {
  dialect: Dialect
  host?: string
  port?: number
  database?: string
  user?: string
  password?: string
  sslMode?: SslMode
  /** SQL Server named instance (host\instance). */
  instanceName?: string
  applicationName?: string
  connectTimeoutMs?: number
}

export type ParseResult = { ok: true; value: ParsedConnection } | { ok: false; error: string }

const fail = (error: string): ParseResult => ({ ok: false, error })

/** Parse a connection string. Never throws. */
export function parseConnectionString(input: string): ParseResult {
  const text = input.trim()
  if (!text) return fail('Paste a connection string first.')
  const scheme = /^(jdbc:)?([a-z][a-z0-9+.-]*):\/\//i.exec(text)
  if (scheme) {
    const name = scheme[2]!.toLowerCase()
    if (name === 'postgres' || name === 'postgresql') return parseUrl(text.slice(scheme[0].length), 'postgres')
    if (name === 'sqlserver' || name === 'mssql') {
      if (scheme[1]) return parseJdbcSqlServer(text.slice(scheme[0].length))
      return parseUrl(text.slice(scheme[0].length), 'mssql')
    }
    return fail(`Unsupported scheme "${scheme[2]}". Use postgres://, postgresql:// or a SQL Server connection string.`)
  }
  if (text.includes(';') || /^\s*(server|data source|address|addr|network address|driver|initial catalog)\s*=/i.test(text)) {
    return parseAdo(text)
  }
  if (/^\s*[a-z_]+\s*=/i.test(text)) return parseLibpqKeywords(text)
  return fail('Unrecognized format. Try postgres://user@host:5432/db or Server=host,1433;Database=db;User Id=sa.')
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function decode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function parsePort(raw: string | undefined): number | undefined | null {
  if (raw === undefined || raw.trim() === '') return undefined
  if (!/^\d+$/.test(raw.trim())) return null
  const n = Number(raw.trim())
  return n >= 1 && n <= 65535 ? n : null
}

function parseBool(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined
  const v = raw.trim().toLowerCase()
  if (['true', 'yes', '1', 'mandatory', 'strict', 'on'].includes(v)) return true
  if (['false', 'no', '0', 'optional', 'off'].includes(v)) return false
  return undefined
}

function timeoutMs(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return undefined
  const seconds = Number(raw.trim())
  return seconds > 0 ? seconds * 1000 : undefined
}

/** libpq sslmode → our SslMode (verify-ca is mapped to the stricter verify-full). */
function pgSslMode(raw: string | undefined): SslMode | undefined {
  switch (raw?.trim().toLowerCase()) {
    case 'disable':
      return 'disable'
    case 'allow':
    case 'prefer':
      return 'prefer'
    case 'require':
    case 'no-verify':
      return 'require'
    case 'verify-ca':
    case 'verify-full':
      return 'verify-full'
    default:
      return undefined
  }
}

/** SQL Server Encrypt / TrustServerCertificate → SslMode (see SslConfig in @shared/types). */
function mssqlSslMode(encryptRaw: string | undefined, trustRaw: string | undefined): SslMode | undefined {
  const encrypt = parseBool(encryptRaw)
  const strict = encryptRaw?.trim().toLowerCase() === 'strict'
  const trust = parseBool(trustRaw)
  if (encrypt === false) return 'disable'
  if (strict) return 'verify-full'
  if (encrypt === true) return trust === true ? 'require' : 'verify-full'
  if (trust === true) return 'require'
  return undefined
}

function clean<T extends object>(value: T): T {
  for (const key of Object.keys(value) as (keyof T)[]) {
    if (value[key] === undefined || value[key] === '') delete value[key]
  }
  return value
}

/** "host:port", "[::1]:port", "host,port", "host\instance". */
function splitHostPort(raw: string, dialect: Dialect): { host: string; port?: string; instance?: string } {
  let rest = raw.trim()
  if (dialect === 'mssql') rest = rest.replace(/^(tcp|np|lpc):/i, '')
  let instance: string | undefined
  if (dialect === 'mssql') {
    const slash = rest.indexOf('\\')
    if (slash >= 0) {
      const after = rest.slice(slash + 1)
      const portSep = after.search(/[,:]/)
      instance = portSep >= 0 ? after.slice(0, portSep) : after
      rest = rest.slice(0, slash) + (portSep >= 0 ? after.slice(portSep) : '')
    }
  }
  if (rest.startsWith('[')) {
    const end = rest.indexOf(']')
    if (end > 0) {
      const host = rest.slice(1, end)
      const tail = rest.slice(end + 1)
      return { host, port: tail.startsWith(':') || tail.startsWith(',') ? tail.slice(1) : undefined, instance }
    }
  }
  const comma = rest.lastIndexOf(',')
  if (comma >= 0) return { host: rest.slice(0, comma), port: rest.slice(comma + 1), instance }
  const colon = rest.lastIndexOf(':')
  // A bare IPv6 address without brackets has several colons: keep it whole.
  if (colon >= 0 && rest.indexOf(':') === colon) return { host: rest.slice(0, colon), port: rest.slice(colon + 1), instance }
  return { host: rest, instance }
}

function normalizeMssqlHost(host: string): string {
  const h = host.trim()
  if (h === '.' || h.toLowerCase() === '(local)' || h.toLowerCase() === '(localdb)') return 'localhost'
  return h
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

function parseUrl(afterScheme: string, dialect: Dialect): ParseResult {
  const hashless = afterScheme.split('#')[0] ?? ''
  const qIndex = hashless.indexOf('?')
  const beforeQuery = qIndex >= 0 ? hashless.slice(0, qIndex) : hashless
  const query = new URLSearchParams(qIndex >= 0 ? hashless.slice(qIndex + 1) : '')
  const slash = beforeQuery.indexOf('/')
  const authority = slash >= 0 ? beforeQuery.slice(0, slash) : beforeQuery
  const path = slash >= 0 ? beforeQuery.slice(slash + 1) : ''

  const at = authority.lastIndexOf('@')
  const userInfo = at >= 0 ? authority.slice(0, at) : ''
  const hostPart = at >= 0 ? authority.slice(at + 1) : authority

  const value: ParsedConnection = { dialect }
  if (userInfo) {
    const colon = userInfo.indexOf(':')
    value.user = decode(colon >= 0 ? userInfo.slice(0, colon) : userInfo)
    if (colon >= 0) value.password = decode(userInfo.slice(colon + 1))
  }
  // Multi-host URLs (host1,host2): the first host is used.
  const firstHost = dialect === 'postgres' ? (hostPart.split(',')[0] ?? '') : hostPart
  if (firstHost) {
    const hp = splitHostPort(decode(firstHost), dialect)
    const port = parsePort(hp.port)
    if (port === null) return fail(`Invalid port "${hp.port}".`)
    value.host = dialect === 'mssql' ? normalizeMssqlHost(hp.host) : hp.host
    value.port = port
    value.instanceName = hp.instance
  }
  if (path) value.database = decode(path.replace(/\/+$/, ''))

  const q = (key: string) => query.get(key) ?? undefined
  if (dialect === 'postgres') {
    // libpq allows every keyword as a query parameter; they override the URL parts.
    if (q('host') && !q('host')!.startsWith('/')) value.host = q('host')
    if (q('port')) {
      const port = parsePort(q('port'))
      if (port === null) return fail(`Invalid port "${q('port')}".`)
      value.port = port
    }
    value.user = q('user') ?? value.user
    value.password = q('password') ?? value.password
    value.database = q('dbname') ?? value.database
    value.sslMode = pgSslMode(q('sslmode') ?? (parseBool(q('ssl')) ? 'require' : undefined))
    value.applicationName = q('application_name')
    value.connectTimeoutMs = timeoutMs(q('connect_timeout'))
  } else {
    value.user = q('user') ?? value.user
    value.password = q('password') ?? value.password
    value.database = q('database') ?? value.database
    value.sslMode = mssqlSslMode(q('encrypt'), q('trustServerCertificate') ?? q('trustservercertificate'))
    value.instanceName = q('instanceName') ?? value.instanceName
  }
  if (!value.host && !value.database && !value.user) return fail('The URL has no host, user or database.')
  return { ok: true, value: clean(value) }
}

// ---------------------------------------------------------------------------
// key=value formats
// ---------------------------------------------------------------------------

/** Split "k=v;k2='v;2';k3={v}" (ADO.NET / ODBC quoting rules). Keys are lower-cased, inner spaces collapsed. */
export function splitKeyValues(text: string, separator: ';' | 'whitespace'): Map<string, string> | string {
  const out = new Map<string, string>()
  let i = 0
  const n = text.length
  const isSep = (c: string) => (separator === ';' ? c === ';' : /\s/.test(c))
  while (i < n) {
    while (i < n && (isSep(text[i]!) || /\s/.test(text[i]!))) i++
    if (i >= n) break
    const eq = text.indexOf('=', i)
    if (eq < 0) return `Expected "key=value" near "${text.slice(i, i + 20)}".`
    const key = text.slice(i, eq).trim().toLowerCase().replace(/\s+/g, ' ')
    if (!key) return 'Found a value without a key.'
    i = eq + 1
    while (i < n && text[i] === ' ') i++
    let value = ''
    const quote = text[i]
    if (quote === '"' || quote === "'" || (quote === '{' && separator === ';')) {
      const close = quote === '{' ? '}' : quote
      i++
      let closed = false
      while (i < n) {
        const c = text[i]!
        if (c === close) {
          if (text[i + 1] === close) {
            value += close
            i += 2
            continue
          }
          i++
          closed = true
          break
        }
        if (separator === 'whitespace' && c === '\\' && i + 1 < n) {
          value += text[i + 1]
          i += 2
          continue
        }
        value += c
        i++
      }
      if (!closed) return `Unterminated quoted value for "${key}".`
      while (i < n && !isSep(text[i]!)) i++
    } else {
      const start = i
      while (i < n && !isSep(text[i]!)) {
        if (separator === 'whitespace' && text[i] === '\\' && i + 1 < n) {
          value += text[i + 1]
          i += 2
          continue
        }
        if (separator === 'whitespace') value += text[i]
        i++
      }
      if (separator === ';') value = text.slice(start, i).trim()
    }
    out.set(key, value)
  }
  return out
}

function pick(map: Map<string, string>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = map.get(k)
    if (v !== undefined) return v
  }
  return undefined
}

function parseAdo(text: string): ParseResult {
  const map = splitKeyValues(text, ';')
  if (typeof map === 'string') return fail(map)
  const server = pick(map, 'server', 'data source', 'address', 'addr', 'network address')
  const value: ParsedConnection = { dialect: 'mssql' }
  if (server) {
    const hp = splitHostPort(server, 'mssql')
    const port = parsePort(hp.port)
    if (port === null) return fail(`Invalid port "${hp.port}".`)
    value.host = normalizeMssqlHost(hp.host)
    value.port = port
    value.instanceName = hp.instance
  }
  value.database = pick(map, 'database', 'initial catalog')
  value.user = pick(map, 'user id', 'uid', 'user', 'username')
  value.password = pick(map, 'password', 'pwd')
  value.sslMode = mssqlSslMode(pick(map, 'encrypt'), pick(map, 'trustservercertificate', 'trust server certificate'))
  value.applicationName = pick(map, 'application name', 'app')
  value.connectTimeoutMs = timeoutMs(pick(map, 'connect timeout', 'connection timeout', 'timeout'))
  if (!value.host && !value.database) return fail('No "Server" or "Database" found in the connection string.')
  return { ok: true, value: clean(value) }
}

function parseJdbcSqlServer(afterScheme: string): ParseResult {
  const semi = afterScheme.indexOf(';')
  const hostPart = semi >= 0 ? afterScheme.slice(0, semi) : afterScheme
  const map = splitKeyValues(semi >= 0 ? afterScheme.slice(semi + 1) : '', ';')
  if (typeof map === 'string') return fail(map)
  const value: ParsedConnection = { dialect: 'mssql' }
  if (hostPart) {
    const hp = splitHostPort(hostPart, 'mssql')
    const port = parsePort(hp.port)
    if (port === null) return fail(`Invalid port "${hp.port}".`)
    value.host = normalizeMssqlHost(hp.host)
    value.port = port
    value.instanceName = hp.instance
  }
  const server = pick(map, 'servername')
  if (server && !value.host) value.host = normalizeMssqlHost(server)
  const port = parsePort(pick(map, 'portnumber', 'port'))
  if (port === null) return fail('Invalid port.')
  if (port !== undefined) value.port = port
  value.instanceName = pick(map, 'instancename') ?? value.instanceName
  value.database = pick(map, 'databasename', 'database')
  value.user = pick(map, 'user', 'username', 'user id')
  value.password = pick(map, 'password')
  value.sslMode = mssqlSslMode(pick(map, 'encrypt'), pick(map, 'trustservercertificate'))
  value.applicationName = pick(map, 'applicationname')
  value.connectTimeoutMs = timeoutMs(pick(map, 'logintimeout'))
  if (!value.host) return fail('The JDBC URL has no host.')
  return { ok: true, value: clean(value) }
}

function parseLibpqKeywords(text: string): ParseResult {
  const map = splitKeyValues(text, 'whitespace')
  if (typeof map === 'string') return fail(map)
  const value: ParsedConnection = { dialect: 'postgres' }
  const host = pick(map, 'host', 'hostaddr')
  if (host && !host.startsWith('/')) value.host = host.split(',')[0]
  const port = parsePort(pick(map, 'port')?.split(',')[0])
  if (port === null) return fail(`Invalid port "${pick(map, 'port')}".`)
  value.port = port
  value.database = pick(map, 'dbname')
  value.user = pick(map, 'user')
  value.password = pick(map, 'password')
  value.sslMode = pgSslMode(pick(map, 'sslmode'))
  value.applicationName = pick(map, 'application_name')
  value.connectTimeoutMs = timeoutMs(pick(map, 'connect_timeout'))
  if (!value.host && !value.database && !value.user) return fail('No host, dbname or user found.')
  return { ok: true, value: clean(value) }
}

/** Cheap check used to auto-detect a connection string pasted into the Host field. */
export function looksLikeConnectionString(text: string): boolean {
  const t = text.trim()
  if (/^(jdbc:)?(postgres|postgresql|sqlserver|mssql):\/\//i.test(t)) return true
  return /(^|;)\s*(server|data source)\s*=/i.test(t) && t.includes(';')
}
