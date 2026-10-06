// MetadataProvider for SQL Server: one mssql ConnectionPool (max 4); other databases are read
// through three-part names ([db].sys.objects…) without changing the connection's context.

import sql from 'mssql'
import { quoteIdent } from '@shared/sql'
import type {
  ApplyChangesResult,
  CompletionCatalog,
  CompletionObject,
  CompletionSchema,
  DatabaseInfo,
  DbObjectInfo,
  ObjectKind,
  RowChange,
  SchemaInfo,
  ServerInfo,
  TableDataPage,
  TableDataRequest,
  TableDetails,
  TableRef,
} from '@shared/types'
import { DriverError } from '../errors'
import type { MetadataProvider, ResolvedConnection } from '../types'
import {
  bool,
  formatType,
  kindOfSynonymBase,
  kindOfType,
  loadSynonyms,
  loadTableDetails,
  num,
  optNum,
  optStr,
  str,
  typeSpecOf,
  type CatalogQuery,
  type QueryParams,
  type Row,
} from './catalog'
import { mssqlConfig, resolveOptions, type CommonOptions } from './config'
import { closeConnection, openConnection } from './connection'
import { getDdl } from './ddl'
import { toDriverError } from './error-mapping'
import { SERVER_INFO_SQL, serverInfoFromRow } from './session'
import {
  buildEditStatements,
  columnMetas,
  loadTableShape,
  orderByClause,
  readOnlyReason,
  selectList,
  targetName,
  whereClause,
  type EditStatement,
} from './table-data'
import { normalizeValue } from './values'

const POOL_SIZE = 4
const SYSTEM_SCHEMAS = new Set(['sys', 'INFORMATION_SCHEMA', 'guest'])
const SYSTEM_OBJECT_SCHEMAS = new Set(['sys', 'INFORMATION_SCHEMA'])
/** Fixed database role schemas (db_owner … db_denydatawriter) have ids 16384–16399. */
const FIXED_ROLE_SCHEMA_MIN_ID = 16384

const KIND_ORDER: ObjectKind[] = ['table', 'view', 'materialized-view', 'foreign-table', 'function', 'procedure', 'sequence', 'type']

function isSystemSchema(name: string, schemaId: number): boolean {
  return SYSTEM_SCHEMAS.has(name) || schemaId >= FIXED_ROLE_SCHEMA_MIN_ID
}

function compareObjects(a: DbObjectInfo, b: DbObjectInfo): number {
  const kind = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
  if (kind !== 0) return kind
  return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.name.localeCompare(b.name)
}

interface Routine {
  signature: string
  returnType?: string
}

function addInput(request: sql.Request, name: string, value: QueryParams[string]): void {
  if (typeof value === 'number') request.input(name, Number.isInteger(value) ? sql.BigInt : sql.Float, value)
  else if (typeof value === 'boolean') request.input(name, sql.Bit, value)
  else request.input(name, sql.NVarChar(4000), value)
}

function arrayResult(result: unknown): { names: string[]; rows: unknown[][] } {
  const shaped = result as { recordset?: unknown; columns?: unknown }
  const rows = Array.isArray(shaped.recordset) ? (shaped.recordset as unknown[]).filter(Array.isArray) : []
  const firstColumns = Array.isArray(shaped.columns) ? (shaped.columns as unknown[])[0] : undefined
  const names = Array.isArray(firstColumns)
    ? firstColumns.map((column: unknown) =>
        typeof column === 'object' && column !== null && 'name' in column ? String((column as { name: unknown }).name) : '',
      )
    : []
  return { names, rows: rows as unknown[][] }
}

export class MssqlMetadata implements MetadataProvider {
  private readonly query: CatalogQuery = Object.assign((text: string, params?: QueryParams) => this.rows(text, params), {
    major: undefined as number | undefined,
  })

  private constructor(private readonly pool: sql.ConnectionPool) {}

  static async open(resolved: ResolvedConnection): Promise<MssqlMetadata> {
    const options = await resolveOptions(resolved)
    const pool = new sql.ConnectionPool(mssqlConfig(options, POOL_SIZE))
    pool.on('error', () => undefined)
    try {
      await pool.connect()
    } catch (error) {
      await pool.close().catch(() => undefined)
      throw await preciseLoginError(error, options)
    }
    const metadata = new MssqlMetadata(pool)
    metadata.query.major = await metadata.majorVersion().catch(() => undefined)
    return metadata
  }

  async close(): Promise<void> {
    await this.pool.close().catch(() => undefined)
  }

  /** Major version of the server (13 = SQL Server 2016), used to pick catalog columns that exist. */
  private async majorVersion(): Promise<number | undefined> {
    const rows = await this.rows(`SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS version`)
    const major = Number.parseInt(rows[0] ? str(rows[0], 'version') : '', 10)
    return Number.isFinite(major) ? major : undefined
  }

  async serverInfo(): Promise<ServerInfo> {
    const result = await this.run((request) => {
      request.arrayRowMode = true
      return request.query(SERVER_INFO_SQL)
    })
    const row = arrayResult(result).rows[0]
    return serverInfoFromRow(row?.map((value) => normalizeValue(value, { name: 'nvarchar' })))
  }

  async listDatabases(showSystem: boolean): Promise<DatabaseInfo[]> {
    const rows = await this.rows(
      `SELECT d.name, d.database_id,
         (SELECT SUM(CAST(mf.size AS bigint)) * 8192 FROM sys.master_files mf WHERE mf.database_id = d.database_id) AS size_bytes
       FROM sys.databases d
       WHERE d.state_desc = N'ONLINE' AND HAS_DBACCESS(d.name) = 1
       ORDER BY d.name`,
    )
    return rows
      .map((row) => {
        const info: DatabaseInfo = { name: str(row, 'name'), isSystem: num(row, 'database_id') <= 4 }
        const size = optNum(row, 'size_bytes')
        if (size !== undefined) info.sizeBytes = size
        return info
      })
      .filter((db) => showSystem || !db.isSystem)
  }

  async listSchemas(database: string, showSystem: boolean): Promise<SchemaInfo[]> {
    const db = await this.database(database)
    const rows = await this.rows(
      `SELECT s.name, s.schema_id, p.name AS owner
       FROM ${db}.sys.schemas s
       LEFT JOIN ${db}.sys.database_principals p ON p.principal_id = s.principal_id
       ORDER BY s.name`,
    )
    return rows
      .map((row) => {
        const info: SchemaInfo = { name: str(row, 'name'), isSystem: isSystemSchema(str(row, 'name'), num(row, 'schema_id')) }
        const owner = optStr(row, 'owner')
        if (owner) info.owner = owner
        return info
      })
      .filter((schema) => showSystem || !schema.isSystem)
  }

  async listObjects(database: string, schema: string): Promise<DbObjectInfo[]> {
    const db = await this.database(database)
    // System views and procedures of sys / INFORMATION_SCHEMA only appear in sys.all_objects.
    const system = SYSTEM_OBJECT_SCHEMAS.has(schema)
    const [objects, types, routines] = await Promise.all([
      this.rows(
        `SELECT o.object_id, o.name, o.type, CAST(ep.value AS nvarchar(max)) AS comment,
           (SELECT SUM(p.rows) FROM ${db}.sys.partitions p WHERE p.object_id = o.object_id AND p.index_id IN (0, 1)) AS row_estimate
         FROM ${db}.sys.${system ? 'all_objects' : 'objects'} o
         JOIN ${db}.sys.schemas s ON s.schema_id = o.schema_id
         LEFT JOIN ${db}.sys.extended_properties ep
           ON ep.class = 1 AND ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.name = N'MS_Description'
         WHERE s.name = @schema ${system ? '' : 'AND o.is_ms_shipped = 0'}
           AND o.type IN ('U', 'V', 'P', 'PC', 'X', 'FN', 'IF', 'TF', 'FS', 'FT', 'SO', 'SN')`,
        { schema },
      ),
      this.rows(
        `SELECT t.user_type_id, t.name, CAST(ep.value AS nvarchar(max)) AS comment
         FROM ${db}.sys.types t
         JOIN ${db}.sys.schemas s ON s.schema_id = t.schema_id
         LEFT JOIN ${db}.sys.extended_properties ep
           ON ep.class = 6 AND ep.major_id = t.user_type_id AND ep.minor_id = 0 AND ep.name = N'MS_Description'
         WHERE t.is_user_defined = 1 AND s.name = @schema`,
        { schema },
      ),
      this.routines(db, schema, system),
    ])
    const synonyms = objects.some((row) => str(row, 'type').trim() === 'SN')
      ? new Map((await loadSynonyms(this.query, db)).map((row) => [str(row, 'object_id'), row]))
      : new Map<string, Row>()

    const result: DbObjectInfo[] = []
    for (const row of objects) {
      const synonym = synonyms.get(str(row, 'object_id'))
      const isSynonym = str(row, 'type').trim() === 'SN'
      const kind = isSynonym ? kindOfSynonymBase(synonym && optStr(synonym, 'base_type')) : kindOfType(str(row, 'type'))
      if (!kind) continue
      const identity = str(row, 'object_id')
      const info: DbObjectInfo = { schema, name: str(row, 'name'), kind, identity }
      const base = synonym && optStr(synonym, 'base_object_name')
      const comment = [base ? `Synonym for ${base}` : undefined, optStr(row, 'comment')].filter(Boolean).join(' — ')
      if (comment) info.comment = comment
      if (isSynonym) {
        if (kind === 'function' || kind === 'procedure') info.signature = '()'
        result.push(info)
        continue
      }
      if (kind === 'table') {
        const estimate = optNum(row, 'row_estimate')
        if (estimate !== undefined) info.rowEstimate = estimate
      }
      const routine = routines.get(identity)
      if (kind === 'function' || kind === 'procedure') {
        info.signature = routine?.signature ?? '()'
        const type = str(row, 'type').trim()
        if (type === 'IF' || type === 'TF' || type === 'FT') info.returnType = 'TABLE'
        else if (routine?.returnType) info.returnType = routine.returnType
      }
      result.push(info)
    }
    for (const row of types) {
      const info: DbObjectInfo = { schema, name: str(row, 'name'), kind: 'type', identity: str(row, 'user_type_id') }
      const comment = optStr(row, 'comment')
      if (comment) info.comment = comment
      result.push(info)
    }
    return result.sort(compareObjects)
  }

  async tableDetails(database: string, schema: string, name: string): Promise<TableDetails> {
    const db = await this.database(database)
    return loadTableDetails(this.query, db, schema, name)
  }

  async getDdl(database: string, schema: string, name: string, kind: ObjectKind, identity?: string): Promise<string> {
    const db = await this.database(database)
    return getDdl(this.query, db, schema, name, kind, identity)
  }

  async completionCatalog(database: string, showSystem: boolean): Promise<CompletionCatalog> {
    const db = await this.database(database)
    const objectsView = showSystem ? 'all_objects' : 'objects'
    const shippedFilter = showSystem ? '' : 'AND o.is_ms_shipped = 0'
    const [schemas, columns, routines, defaults, synonyms] = await Promise.all([
      this.listSchemas(database, showSystem),
      this.rows(
        `SELECT s.name AS schema_name, o.name AS object_name, o.type, c.name AS column_name,
           t.name AS type_name, t.is_user_defined, ts.name AS type_schema, c.max_length, c.precision, c.scale
         FROM ${db}.sys.${objectsView} o
         JOIN ${db}.sys.schemas s ON s.schema_id = o.schema_id
         JOIN ${db}.sys.${showSystem ? 'all_columns' : 'columns'} c ON c.object_id = o.object_id
         JOIN ${db}.sys.types t ON t.user_type_id = c.user_type_id
         JOIN ${db}.sys.schemas ts ON ts.schema_id = t.schema_id
         WHERE o.type IN ('U', 'V') ${shippedFilter}
         ORDER BY s.name, o.name, c.column_id`,
      ),
      this.rows(
        `SELECT o.object_id, s.name AS schema_name, o.name, o.type
         FROM ${db}.sys.${objectsView} o JOIN ${db}.sys.schemas s ON s.schema_id = o.schema_id
         WHERE o.type IN ('P', 'PC', 'X', 'FN', 'IF', 'TF', 'FS', 'FT') ${shippedFilter}
         ORDER BY s.name, o.name`,
      ),
      // Evaluated in the target database without changing the pooled connection's context.
      this.rows(`EXEC ${db}.sys.sp_executesql N'SELECT SCHEMA_NAME() AS default_schema'`),
      loadSynonyms(this.query, db),
    ])
    const signatures = await this.routines(db, undefined, showSystem)

    const bySchema = new Map<string, CompletionSchema>()
    for (const schema of schemas) bySchema.set(schema.name, { name: schema.name, objects: [] })
    const objectIndex = new Map<string, CompletionObject>()
    for (const row of columns) {
      const schemaName = str(row, 'schema_name')
      const schema = bySchema.get(schemaName)
      if (!schema) continue
      const key = `${schemaName}\u0000${str(row, 'object_name')}`
      let object = objectIndex.get(key)
      if (!object) {
        object = { name: str(row, 'object_name'), kind: str(row, 'type').trim() === 'V' ? 'view' : 'table', columns: [] }
        objectIndex.set(key, object)
        schema.objects.push(object)
      }
      object.columns?.push({ name: str(row, 'column_name'), dataType: formatType(typeSpecOf(row)) })
    }
    for (const row of routines) {
      const schema = bySchema.get(str(row, 'schema_name'))
      const kind = kindOfType(str(row, 'type'))
      if (!schema || !kind) continue
      schema.objects.push({ name: str(row, 'name'), kind, signature: signatures.get(str(row, 'object_id'))?.signature ?? '()' })
    }
    // Synonyms complete like their base object (columns / signature when it lives in this database).
    for (const row of synonyms) {
      const schema = bySchema.get(str(row, 'schema_name'))
      if (!schema) continue
      const kind = kindOfSynonymBase(optStr(row, 'base_type'))
      const local = !optStr(row, 'db_part') && !optStr(row, 'server_part')
      const base = local ? objectIndex.get(`${str(row, 'base_schema')}\u0000${str(row, 'base_name')}`) : undefined
      const object: CompletionObject = { name: str(row, 'name'), kind }
      if (kind === 'view') object.columns = base?.columns ? [...base.columns] : []
      else object.signature = (local && signatures.get(str(row, 'base_id'))?.signature) || '()'
      schema.objects.push(object)
    }
    return {
      database: unquote(db),
      defaultSchema: (defaults[0] && optStr(defaults[0], 'default_schema')) || 'dbo',
      schemas: [...bySchema.values()].filter((schema) => schema.objects.length > 0 || !showSystem),
    }
  }

  async fetchTableData(request: TableDataRequest, readOnlyConnection: boolean, signal?: AbortSignal): Promise<TableDataPage> {
    const started = performance.now()
    const db = await this.database(request.table.database)
    const shape = await loadTableShape(this.query, db, request.table.schema, request.table.name)
    const offset = Math.max(0, Math.trunc(request.offset))
    const limit = Math.max(1, Math.trunc(request.limit))
    const base = `SELECT ${selectList(shape)} FROM ${targetName(db, shape)} ${whereClause(request.where)} ${orderByClause(shape, request.orderBy)}`
      .replace(/\s+$/, '')
      .replace(/ {2,}/g, ' ')
    const text = `${base} OFFSET @offset ROWS FETCH NEXT @limitPlusOne ROWS ONLY`

    const result = await this.run((r) => {
      r.arrayRowMode = true
      r.input('offset', sql.BigInt, offset)
      r.input('limitPlusOne', sql.BigInt, limit + 1)
      return r.query(text)
    }, signal)
    const { rows } = arrayResult(result)
    // The select list is shape.columns, in order: values and metadata come from the same list.
    const types = shape.columns.map((column) => ({
      name: column.baseType === 'hierarchyid' ? 'nvarchar' : column.baseType,
      scale: column.type.scale,
    }))
    const page = rows.slice(0, limit).map((row) => row.map((value, i) => normalizeValue(value, types[i] ?? { name: '' })))
    const reason = readOnlyReason(shape, readOnlyConnection)
    const data: TableDataPage = {
      columns: columnMetas(shape),
      rows: page,
      offset,
      hasMore: rows.length > limit,
      primaryKey: shape.primaryKey,
      editable: reason === undefined,
      sql: `${base} OFFSET ${offset} ROWS FETCH NEXT ${limit + 1} ROWS ONLY`,
      durationMs: Math.round(performance.now() - started),
    }
    if (reason) data.readOnlyReason = reason
    return data
  }

  async countTableData(request: Omit<TableDataRequest, 'offset' | 'limit' | 'orderBy'>, signal?: AbortSignal): Promise<number> {
    const db = await this.database(request.table.database)
    const shape = await loadTableShape(this.query, db, request.table.schema, request.table.name)
    const rows = await this.rows(`SELECT COUNT_BIG(*) AS total FROM ${targetName(db, shape)} ${whereClause(request.where)}`, {}, signal)
    return rows[0] ? num(rows[0], 'total') : 0
  }

  async previewChanges(table: TableRef, changes: RowChange[]): Promise<string[]> {
    const statements = await this.editStatements(table, changes)
    return statements.map((statement) => statement.preview)
  }

  async applyChanges(table: TableRef, changes: RowChange[]): Promise<ApplyChangesResult> {
    const statements = await this.editStatements(table, changes)
    if (statements.length === 0) return { affected: 0, statements: [] }
    const transaction = new sql.Transaction(this.pool)
    try {
      await transaction.begin()
    } catch (error) {
      throw toDriverError(error)
    }
    let affected = 0
    try {
      for (const statement of statements) {
        const request = new sql.Request(transaction)
        for (const param of statement.params) {
          if (param.kind === 'bit') request.input(param.name, sql.Bit, param.value)
          else if (param.kind === 'int') request.input(param.name, sql.Int, param.value === null ? null : Number(param.value))
          else if (param.kind === 'text4000') request.input(param.name, sql.NVarChar(4000), param.value)
          else request.input(param.name, sql.NVarChar(sql.MAX), param.value)
        }
        // @@ROWCOUNT right after the statement ignores rows touched by triggers. A trigger may also
        // return result sets of its own: read the count from the recordset that has it.
        const result = await request.query(
          `${statement.text};\nDECLARE @datagrippe_affected int = @@ROWCOUNT;\nSELECT @datagrippe_affected AS datagrippe_affected;`,
        )
        const recordsets = (Array.isArray(result.recordsets) ? result.recordsets : []) as unknown as Row[][]
        const counted = [...recordsets].reverse().find((set) => set[0] && 'datagrippe_affected' in set[0])
        const count = counted?.[0] ? num(counted[0], 'datagrippe_affected') : 0
        if (statement.expectOne && count !== 1) {
          throw DriverError.of(
            'invalid-input',
            `${statement.type === 'update' ? 'UPDATE' : 'DELETE'} matched ${count} rows instead of 1; all changes were rolled back`,
          )
        }
        affected += count
      }
      await transaction.commit()
    } catch (error) {
      await transaction.rollback().catch(() => undefined)
      throw toDriverError(error)
    }
    return { affected, statements: statements.map((statement) => statement.preview) }
  }

  // -------------------------------------------------------------------------

  private async editStatements(table: TableRef, changes: RowChange[]): Promise<EditStatement[]> {
    const db = await this.database(table.database)
    const shape = await loadTableShape(this.query, db, table.schema, table.name)
    if (shape.kind !== 'table') throw DriverError.of('invalid-input', 'Views are not editable')
    return buildEditStatements(db, shape, changes)
  }

  /** Validate a database name against sys.databases and return it quoted for three-part names. */
  private async database(name: string): Promise<string> {
    const rows = name.trim()
      ? await this.rows('SELECT name FROM sys.databases WHERE name = @name', { name })
      : await this.rows('SELECT DB_NAME() AS name')
    const found = rows[0] ? optStr(rows[0], 'name') : undefined
    if (!found) throw DriverError.of('not-found', `Database ${name} was not found`)
    return quoteIdent(found, 'mssql')
  }

  private async routines(db: string, schema: string | undefined, includeSystem: boolean): Promise<Map<string, Routine>> {
    const rows = await this.rows(
      `SELECT p.object_id, p.parameter_id, p.name, p.is_output, p.is_readonly,
         t.name AS type_name, t.is_user_defined, ts.name AS type_schema, p.max_length, p.precision, p.scale
       FROM ${db}.sys.${includeSystem ? 'all_parameters' : 'parameters'} p
       JOIN ${db}.sys.${includeSystem ? 'all_objects' : 'objects'} o ON o.object_id = p.object_id
       JOIN ${db}.sys.schemas s ON s.schema_id = o.schema_id
       JOIN ${db}.sys.types t ON t.user_type_id = p.user_type_id
       JOIN ${db}.sys.schemas ts ON ts.schema_id = t.schema_id
       WHERE o.type IN ('P', 'PC', 'X', 'FN', 'IF', 'TF', 'FS', 'FT') ${includeSystem ? '' : 'AND o.is_ms_shipped = 0'}
         ${schema !== undefined ? 'AND s.name = @schema' : ''}
       ORDER BY p.object_id, p.parameter_id`,
      schema !== undefined ? { schema } : {},
    )
    const parts = new Map<string, { params: string[]; returnType?: string }>()
    for (const row of rows) {
      const id = str(row, 'object_id')
      let entry = parts.get(id)
      if (!entry) {
        entry = { params: [] }
        parts.set(id, entry)
      }
      const type = formatType(typeSpecOf(row))
      if (num(row, 'parameter_id') === 0) {
        entry.returnType = type
        continue
      }
      let text = `${str(row, 'name')} ${type}`
      if (bool(row, 'is_readonly')) text += ' READONLY'
      if (bool(row, 'is_output')) text += ' OUTPUT'
      entry.params.push(text)
    }
    const result = new Map<string, Routine>()
    for (const [id, entry] of parts) {
      const routine: Routine = { signature: `(${entry.params.join(', ')})` }
      if (entry.returnType) routine.returnType = entry.returnType
      result.set(id, routine)
    }
    return result
  }

  private async rows(text: string, params: QueryParams = {}, signal?: AbortSignal): Promise<Row[]> {
    const result = await this.run((request) => {
      for (const [name, value] of Object.entries(params)) addInput(request, name, value)
      return request.query(text)
    }, signal)
    const recordset: unknown = result.recordset
    return Array.isArray(recordset) ? (recordset as Row[]) : []
  }

  /** `signal` cancels the request (attention) and makes it reject with kind 'cancelled'. */
  private async run<T>(task: (request: sql.Request) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const request = this.pool.request()
    const onAbort = () => request.cancel()
    if (signal?.aborted) throw DriverError.of('cancelled', 'The query was cancelled.')
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      return await task(request)
    } catch (error) {
      if (signal?.aborted) throw DriverError.of('cancelled', 'The query was cancelled.')
      throw toDriverError(error)
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }
}

/**
 * The pool reports every login failure as "Login failed for user" (tedious keeps only the last
 * login error); a direct tedious login collects them all and names the real cause (4060…).
 */
async function preciseLoginError(error: unknown, options: CommonOptions): Promise<DriverError> {
  const mapped = toDriverError(error)
  const code = (error as { code?: unknown } | null)?.code
  if (code !== 'ELOGIN') return mapped
  try {
    await closeConnection(await openConnection(options))
  } catch (probe) {
    if (probe instanceof DriverError) return probe
  }
  return mapped
}

function unquote(name: string): string {
  return name.startsWith('[') && name.endsWith(']') ? name.slice(1, -1).replace(/]]/g, ']') : name
}
