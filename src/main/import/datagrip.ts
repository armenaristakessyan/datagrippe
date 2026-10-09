// DataGrip data sources → DataGrippe ConnectionInput. Reads what DataGrip copies to the clipboard (Database Explorer
// › select › ⌘C: "#DataSourceSettings#" blocks) or keeps in a project's .idea/dataSources.xml: <data-source name
// group uuid> with <driver-ref>, <jdbc-url>, <user-name>, <auth-provider>… Pure: no file access. Passwords are never
// imported, not even one written in a connection URL.
import {
  DEFAULT_PORT,
  type ConnectionColor,
  type ConnectionConfig,
  type ConnectionInput,
  type ConnectionOptions,
  type DbeaverImportCandidate,
  type DbeaverScanResult,
  type Dialect,
  type SshConfig,
} from '@shared/types'
import { parseAdoConnectionString, parseJdbcUrl, type ParsedJdbcUrl } from './dbeaver-jdbc'
import { compareCandidates, findDuplicate, looksLikeProduction, postgresSsl, sqlServerSsl } from './dbeaver-map'

/** Pasted text larger than this is refused (hundreds of data sources stay far below). */
export const MAX_DATAGRIP_TEXT = 2 * 1024 * 1024
/** `sourceFile` of the candidates: where the import dialog says they come from. */
export const DATAGRIP_SOURCE = 'DataGrip'

const NOTHING_FOUND =
  'No DataGrip data source in the pasted text. In DataGrip, select data sources or a folder in the Database Explorer, copy them (⌘C) and paste them here.'

const DISABLED_SSH: SshConfig = { enabled: false, host: '', port: 22, username: '', authMethod: 'privateKey' }

interface XmlElement {
  attrs: Record<string, string>
  body: string
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
    const e = entity.toLowerCase()
    try {
      if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16))
      if (e.startsWith('#')) return String.fromCodePoint(Number(e.slice(1)))
    } catch {
      return match
    }
    return ENTITIES[e] ?? match
  })
}

function attributes(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of text.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[(m[1] ?? '').toLowerCase()] = decodeXml(m[2] ?? '')
  return out
}

function dataSources(text: string): XmlElement[] {
  return [...text.matchAll(/<data-source\b([^>]*)>([\s\S]*?)<\/data-source>/g)].map((m) => ({ attrs: attributes(m[1] ?? ''), body: m[2] ?? '' }))
}

/** Text of the first <tag> element (decoded, trimmed); undefined when absent or empty. */
function child(body: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(body)
  const value = m ? decodeXml(m[1] ?? '').trim() : ''
  return value || undefined
}

function childAttributes(body: string, tag: string): Record<string, string> {
  const m = new RegExp(`<${tag}\\b([^>]*)>`).exec(body)
  return m ? attributes(m[1] ?? '') : {}
}

function dialectOf(driverRef: string, dbms: string, url: string): Dialect | null {
  const d = `${driverRef} ${dbms}`.toLowerCase()
  if (d.includes('postgres') || /^jdbc:postgresql:/i.test(url)) return 'postgres'
  if (/sqlserver|mssql|azure|jtds/.test(d) || /^jdbc:(sqlserver|jtds)/i.test(url)) return 'mssql'
  return null
}

/** Databases DataGrip's introspection scope shows (schema-mapping), the default one ("@") aside. */
function scopeDatabases(body: string): string[] {
  const mapping = /<schema-mapping>([\s\S]*?)<\/schema-mapping>/.exec(body)?.[1] ?? ''
  const names = new Set<string>()
  for (const m of mapping.matchAll(/<node\b([^>]*)>/g)) {
    const a = attributes(m[1] ?? '')
    if (a.kind === 'database' && a.qname && a.qname !== '@' && a.negative !== '1') names.add(a.qname)
  }
  return [...names]
}

const PASSWORD_IN_URL = /(?:^|[;?&])\s*(?:password|pwd)\s*=/i

/** Map one <data-source>; `index` names it when it has no name or uuid. */
function mapDataSource(source: XmlElement, index: number): DbeaverImportCandidate {
  const { attrs, body } = source
  const name = attrs.name?.trim() || `Data source ${index + 1}`
  const group = attrs.group?.trim()
  const driverRef = child(body, 'driver-ref') ?? ''
  const info = childAttributes(body, 'database-info')
  const url = child(body, 'jdbc-url') ?? ''
  const candidate: DbeaverImportCandidate = {
    sourceId: attrs.uuid || `datagrip-${index}`,
    sourceFile: DATAGRIP_SOURCE,
    sourceName: name,
    sourceProvider: driverRef || info.product || info.dbms || 'unknown',
    input: null,
    notes: [],
  }
  if (group) candidate.sourceFolder = group
  const notes = candidate.notes

  const dialect = dialectOf(driverRef, info.dbms ?? '', url)
  if (!dialect) {
    notes.push(`${info.product || driverRef || 'This database'} is not supported: only PostgreSQL and SQL Server`)
    return candidate
  }

  // DataGrip keeps everything in the URL: a JDBC URL, or for SQL Server an ADO.NET connection string.
  const parsed: ParsedJdbcUrl | null = parseJdbcUrl(url) ?? (dialect === 'mssql' ? parseAdoConnectionString(url) : null)
  if (url && !parsed) notes.push('The connection URL could not be read: check the host and the database')
  if (parsed && parsed.hosts.length > 1) notes.push(`Only the first host of the URL is used (${parsed.hosts.length} hosts listed)`)
  let host = parsed?.hosts[0]?.host ?? ''
  const port = parsed?.hosts[0]?.port ?? DEFAULT_PORT[dialect]
  if (!host) {
    host = 'localhost'
    notes.push('No host in the DataGrip data source: using localhost')
  }
  let database = parsed?.database ?? ''
  // The URL often names a default database while DataGrip only shows the one the user works in.
  const scope = scopeDatabases(body)
  const onlyShown = scope.length === 1 ? scope[0] : undefined
  if (onlyShown && onlyShown !== database && (!database || (dialect === 'postgres' && database === 'postgres'))) {
    notes.push(database ? `Opens ${onlyShown}, the database DataGrip shows (the URL names ${database})` : `Opens ${onlyShown}, the database DataGrip shows`)
    database = onlyShown
  }
  if (dialect === 'postgres' && !database) database = 'postgres'

  const { ssl, notes: sslNotes } = dialect === 'postgres' ? postgresSsl(null, {}, parsed) : sqlServerSsl(null, {}, {}, parsed)
  notes.push(...sslNotes)
  if (/<ssl-config\b/.test(body)) notes.push('DataGrip’s SSL settings are not imported: check the SSL tab')
  if (/<ssh-properties>[\s\S]*?<enabled>true<\/enabled>/.test(body)) notes.push('The SSH tunnel is not imported: set it up in the SSH tab')

  // Authentication: a user name and a password typed when connecting.
  const user = child(body, 'user-name') ?? parsed?.params.user ?? parsed?.params.username ?? ''
  const authProvider = (child(body, 'auth-provider') ?? '').toLowerCase()
  if (parsed?.params.password !== undefined || PASSWORD_IN_URL.test(url)) {
    notes.push('The URL holds a password: it was not imported, enter it when connecting')
  } else if (authProvider === 'pgpass') {
    notes.push('DataGrip read the password from .pgpass: enter it when connecting')
  } else {
    if (authProvider && authProvider !== 'no-auth' && authProvider !== 'default' && authProvider !== 'credentials') {
      notes.push(`DataGrip authentication "${authProvider}" is not imported: using a user name and password`)
    }
    notes.push('Enter the password when connecting')
  }
  if (!user) notes.push('Set the user name (DataGrip keeps it with its saved credentials)')

  const production = looksLikeProduction(group) || looksLikeProduction(name)
  const color: ConnectionColor = production ? 'red' : 'none'
  if (production) notes.push('Marked as production')

  const options: ConnectionOptions = {}
  if (dialect === 'mssql' && parsed?.instanceName) options.instanceName = parsed.instanceName

  const input: ConnectionInput = {
    name,
    dialect,
    host,
    port,
    database,
    user,
    savePassword: false,
    ssl,
    ssh: { ...DISABLED_SSH },
    color,
    readOnly: child(body, 'read-only') === 'true',
    productionGuard: production,
    options,
    authMode: 'password',
  }
  if (group) input.group = group
  candidate.input = input
  return candidate
}

/** Every data source of the pasted text, mapped; repeated ones (same uuid) once. */
export function parseDatagrip(text: string, existing: readonly ConnectionConfig[]): DbeaverScanResult {
  if (text.length > MAX_DATAGRIP_TEXT) {
    return { files: [], candidates: [], warnings: [`The pasted text is too large (over ${MAX_DATAGRIP_TEXT / 1024 / 1024} MB)`] }
  }
  const sources = dataSources(text)
  if (sources.length === 0) return { files: [], candidates: [], warnings: [NOTHING_FOUND] }
  const warnings: string[] = []
  const candidates: DbeaverImportCandidate[] = []
  const seen = new Set<string>()
  sources.forEach((source, index) => {
    try {
      const candidate = mapDataSource(source, index)
      if (seen.has(candidate.sourceId)) return
      seen.add(candidate.sourceId)
      if (candidate.input) {
        const duplicateOf = findDuplicate(candidate.input, existing)
        if (duplicateOf) candidate.duplicateOf = duplicateOf
      }
      candidates.push(candidate)
    } catch (error) {
      warnings.push(`Skipped data source ${source.attrs.name ?? index + 1}: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  candidates.sort(compareCandidates)
  return { files: [], candidates, warnings }
}
