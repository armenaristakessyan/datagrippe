// JDBC URL parsing for the DBeaver import: host / port / database / instance and the URL properties.
// Only the PostgreSQL (pgjdbc) and SQL Server (Microsoft driver, jTDS) syntaxes are understood.
// Credentials that may appear in a URL (password=…) are parsed like any property but never used by the
// mapper; callers only read the keys they need.

export interface JdbcHost {
  host: string
  port?: number
}

export interface ParsedJdbcUrl {
  kind: 'postgres' | 'sqlserver' | 'jtds'
  /** Every host of a multi-host URL, in order (pgjdbc failover lists). */
  hosts: JdbcHost[]
  database?: string
  /** SQL Server named instance (host\INSTANCE, instanceName=…, instance=…). */
  instanceName?: string
  /** URL properties, keys lower-cased. */
  params: Record<string, string>
}

function toPort(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d{1,5}$/.test(value.trim())) return undefined
  const port = Number(value.trim())
  return port >= 1 && port <= 65535 ? port : undefined
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** "host", "host:port", "[v6]", "[v6]:port". */
function parseHostPort(text: string): JdbcHost | null {
  const t = text.trim()
  if (!t) return null
  if (t.startsWith('[')) {
    const end = t.indexOf(']')
    if (end < 0) return null
    const host = t.slice(1, end)
    const rest = t.slice(end + 1)
    const port = rest.startsWith(':') ? toPort(rest.slice(1)) : undefined
    return host ? { host, ...(port ? { port } : {}) } : null
  }
  const colon = t.lastIndexOf(':')
  if (colon > 0 && t.indexOf(':') === colon) {
    const port = toPort(t.slice(colon + 1))
    return { host: t.slice(0, colon), ...(port ? { port } : {}) }
  }
  return { host: t }
}

/** jdbc:postgresql://h1[:p1][,h2[:p2]]/[db][?k=v&…] · jdbc:postgresql:db · jdbc:postgresql:/ */
function parsePostgres(rest: string): ParsedJdbcUrl {
  const out: ParsedJdbcUrl = { kind: 'postgres', hosts: [], params: {} }
  let body = rest
  const q = body.indexOf('?')
  if (q >= 0) {
    for (const pair of body.slice(q + 1).split('&')) {
      if (!pair) continue
      const eq = pair.indexOf('=')
      const key = decode(eq >= 0 ? pair.slice(0, eq) : pair).trim().toLowerCase()
      if (key) out.params[key] = decode(eq >= 0 ? pair.slice(eq + 1) : '')
    }
    body = body.slice(0, q)
  }
  if (body.startsWith('//')) {
    const authorityEnd = body.indexOf('/', 2)
    const authority = authorityEnd >= 0 ? body.slice(2, authorityEnd) : body.slice(2)
    for (const part of authority.split(',')) {
      const parsed = parseHostPort(part)
      if (parsed) out.hosts.push(parsed)
    }
    body = authorityEnd >= 0 ? body.slice(authorityEnd + 1) : ''
  } else if (body.startsWith('/')) {
    body = body.slice(1)
  }
  const database = decode(body).trim()
  if (database) out.database = database
  return out
}

/** Strip the optional {…} quoting of SQL Server property values. */
function unbrace(value: string): string {
  const v = value.trim()
  return v.startsWith('{') && v.endsWith('}') ? v.slice(1, -1) : v
}

/** Splits "a=1;b={x;y};c=3" honouring {…} quoting. */
function splitSemicolonProps(text: string): Record<string, string> {
  const params: Record<string, string> = {}
  let i = 0
  while (i < text.length) {
    let end = i
    let depth = 0
    while (end < text.length) {
      const ch = text[end]
      if (ch === '{') depth++
      else if (ch === '}' && depth > 0) depth--
      else if (ch === ';' && depth === 0) break
      end++
    }
    const pair = text.slice(i, end)
    const eq = pair.indexOf('=')
    if (eq > 0) {
      const key = pair.slice(0, eq).trim().toLowerCase()
      if (key) params[key] = unbrace(pair.slice(eq + 1))
    }
    i = end + 1
  }
  return params
}

/** "host", "host:port", "host\instance", "host\instance:port". */
function parseSqlServerHost(text: string): { host?: string; port?: number; instanceName?: string } {
  const out: { host?: string; port?: number; instanceName?: string } = {}
  let t = text.trim()
  if (!t) return out
  if (t.startsWith('[')) {
    const parsed = parseHostPort(t)
    if (parsed) {
      out.host = parsed.host
      if (parsed.port) out.port = parsed.port
    }
    return out
  }
  const colon = t.lastIndexOf(':')
  if (colon > 0) {
    const port = toPort(t.slice(colon + 1))
    if (port) {
      out.port = port
      t = t.slice(0, colon)
    }
  }
  const slash = t.indexOf('\\')
  if (slash >= 0) {
    const instance = t.slice(slash + 1).trim()
    if (instance) out.instanceName = instance
    t = t.slice(0, slash)
  }
  if (t.trim()) out.host = t.trim()
  return out
}

/** jdbc:sqlserver://[host[\instance][:port]][;key=value…] */
function parseSqlServer(rest: string): ParsedJdbcUrl {
  const out: ParsedJdbcUrl = { kind: 'sqlserver', hosts: [], params: {} }
  if (!rest.startsWith('//')) return out
  const body = rest.slice(2)
  const semi = body.indexOf(';')
  const hostPart = semi >= 0 ? body.slice(0, semi) : body
  out.params = semi >= 0 ? splitSemicolonProps(body.slice(semi + 1)) : {}
  const fromHost = parseSqlServerHost(hostPart)
  const p = out.params
  const serverName = p.servername ?? p.server
  const fromProp = serverName ? parseSqlServerHost(serverName) : {}
  const host = fromHost.host ?? fromProp.host
  const port = toPort(p.portnumber ?? p.port) ?? fromHost.port ?? fromProp.port
  if (host) out.hosts.push({ host, ...(port ? { port } : {}) })
  const instance = p.instancename?.trim() || fromHost.instanceName || fromProp.instanceName
  if (instance) out.instanceName = instance
  const database = (p.databasename ?? p.database)?.trim()
  if (database) out.database = database
  return out
}

/** jdbc:jtds:sqlserver://host[:port][/database][;key=value…] */
function parseJtds(rest: string): ParsedJdbcUrl {
  const out: ParsedJdbcUrl = { kind: 'jtds', hosts: [], params: {} }
  if (!rest.startsWith('//')) return out
  const body = rest.slice(2)
  const semi = body.indexOf(';')
  const main = semi >= 0 ? body.slice(0, semi) : body
  out.params = semi >= 0 ? splitSemicolonProps(body.slice(semi + 1)) : {}
  const slash = main.indexOf('/')
  const hostPart = slash >= 0 ? main.slice(0, slash) : main
  const database = slash >= 0 ? main.slice(slash + 1).trim() : ''
  const parsed = parseHostPort(hostPart)
  if (parsed) out.hosts.push(parsed)
  const instance = out.params.instance?.trim()
  if (instance) out.instanceName = instance
  const db = database || out.params.databasename?.trim()
  if (db) out.database = db
  return out
}

const ADO_HOST_KEYS = ['data source', 'server', 'address', 'addr', 'network address']
const ADO_DATABASE_KEYS = ['initial catalog', 'database']
const ADO_USER_KEYS = ['user id', 'uid', 'user', 'username']
const ADO_PASSWORD_KEYS = ['password', 'pwd']

/**
 * SQL Server connection string in the ADO.NET syntax DataGrip accepts as a URL:
 * "data source=host[\instance][,port];initial catalog=db;user id=…;TrustServerCertificate=True". Its keys map to
 * the JDBC ones (user, password, encrypt, trustservercertificate) so callers read both the same way. Null when the
 * text names no server.
 */
export function parseAdoConnectionString(text: unknown): ParsedJdbcUrl | null {
  if (typeof text !== 'string' || !text.includes('=')) return null
  const raw = splitSemicolonProps(text)
  // Keys are case- and space-insensitive in ADO.NET ("Initial Catalog", "initial  catalog").
  const props: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) props[key.replace(/\s+/g, ' ').trim()] = value.trim().replace(/^(["'])(.*)\1$/, '$2')
  const first = (keys: string[]) => keys.map((k) => props[k]).find((v) => v !== undefined && v !== '')
  const server = first(ADO_HOST_KEYS)
  if (!server) return null
  const out: ParsedJdbcUrl = { kind: 'sqlserver', hosts: [], params: {} }
  // "tcp:host,port", "host,port", "host\instance".
  let spec = server.replace(/^tcp:/i, '')
  let port: number | undefined
  const comma = spec.lastIndexOf(',')
  if (comma > 0) {
    port = toPort(spec.slice(comma + 1))
    spec = spec.slice(0, comma)
  }
  const parsed = parseSqlServerHost(spec)
  if (parsed.host) out.hosts.push({ host: parsed.host, ...((port ?? parsed.port) ? { port: port ?? parsed.port } : {}) })
  if (parsed.instanceName) out.instanceName = parsed.instanceName
  const database = first(ADO_DATABASE_KEYS)
  if (database) out.database = database
  const user = first(ADO_USER_KEYS)
  if (user) out.params.user = user
  if (first(ADO_PASSWORD_KEYS) !== undefined) out.params.password = '(set)'
  if (props.encrypt !== undefined) out.params.encrypt = props.encrypt
  const trust = props.trustservercertificate ?? props['trust server certificate']
  if (trust !== undefined) out.params.trustservercertificate = trust
  return out
}

/** Parse a PostgreSQL or SQL Server JDBC URL; null for anything else. */
export function parseJdbcUrl(url: unknown): ParsedJdbcUrl | null {
  if (typeof url !== 'string') return null
  const text = url.trim()
  const pg = /^jdbc:postgresql:/i.exec(text)
  if (pg) return parsePostgres(text.slice(pg[0].length))
  const ms = /^jdbc:sqlserver:/i.exec(text)
  if (ms) return parseSqlServer(text.slice(ms[0].length))
  const jtds = /^jdbc:jtds:sqlserver:/i.exec(text)
  if (jtds) return parseJtds(text.slice(jtds[0].length))
  return null
}
