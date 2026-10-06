// MetadataProvider: lazily, per database, one small pool for catalog queries (explorer, structure, DDL,
// completion) and one for the table editor (pages, counts, edits), so slow user filters or counts on big
// tables never make the explorer wait for a connection.
import pg from 'pg'
import type {
  ApplyChangesResult,
  CompletionCatalog,
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
import type { MetadataProvider, ResolvedConnection } from '../types'
import * as catalog from './catalog'
import { clientConfig, connectClient, queryServerInfo, type TlsSetting } from './connect'
import { getDdl } from './ddl'
import { tableDetails } from './details'
import { DriverError } from '../errors'
import { backendKeyOf, sendCancelRequest } from './cancel'
import { toDriverError } from './errors'
import * as tableData from './table-data'
import { TypeNameCache } from './type-names'

type PoolPurpose = 'catalog' | 'data'

const POOL_MAX: Record<PoolPurpose, number> = { catalog: 3, data: 4 }
const POOL_IDLE_MS = 30_000

type TransactionMode = 'READ ONLY' | 'READ WRITE'

export class PostgresMetadata implements MetadataProvider {
  private readonly pools = new Map<string, pg.Pool>()
  private readonly typeCaches = new Map<string, TypeNameCache>()
  private closed = false

  private constructor(
    private readonly connection: ResolvedConnection,
    private readonly tls: TlsSetting,
  ) {}

  /** Verifies the connection (and resolves sslmode=prefer) before handing out pools. */
  static async open(connection: ResolvedConnection): Promise<PostgresMetadata> {
    const { client, tls } = await connectClient(connection, connection.config.database)
    await client.end().catch(() => undefined)
    return new PostgresMetadata(connection, tls)
  }

  private pool(database: string, purpose: PoolPurpose = 'catalog'): pg.Pool {
    const key = `${purpose}:${database}`
    let pool = this.pools.get(key)
    if (!pool) {
      pool = new pg.Pool({
        ...clientConfig(this.connection, database, this.tls),
        max: POOL_MAX[purpose],
        idleTimeoutMillis: POOL_IDLE_MS,
      })
      // Idle clients that lose their connection emit 'error' on the pool; they are discarded automatically.
      pool.on('error', () => undefined)
      this.pools.set(key, pool)
    }
    return pool
  }

  private typeCache(database: string): TypeNameCache {
    let cache = this.typeCaches.get(database)
    if (!cache) {
      cache = new TypeNameCache()
      this.typeCaches.set(database, cache)
    }
    return cache
  }

  /** Run `fn` in a transaction on one pooled client; rolls back when it throws. */
  private async transaction<T>(
    database: string,
    purpose: PoolPurpose,
    mode: TransactionMode,
    fn: (client: pg.PoolClient) => Promise<T>,
    searchPath?: string,
    signal?: AbortSignal,
  ): Promise<T> {
    const cancelled = () => DriverError.of('cancelled', 'The query was cancelled.')
    let client: pg.PoolClient
    try {
      client = await this.pool(database, purpose).connect()
    } catch (error) {
      throw toDriverError(error)
    }
    let broken = false
    // A user cancel: protocol CancelRequest for this pooled backend. The client is then discarded, so a
    // late cancel packet can never hit the next query run on it.
    const onAbort = () => {
      broken = true
      const key = backendKeyOf(client)
      const { host, port } = client as unknown as { host?: unknown; port?: unknown }
      if (key && typeof host === 'string' && typeof port === 'number') void sendCancelRequest(host, port, key).catch(() => undefined)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      if (signal?.aborted) throw cancelled()
      await client.query(`BEGIN TRANSACTION ${mode}`)
      if (searchPath) await client.query(`SET LOCAL search_path = ${searchPath}`)
      const result = await fn(client)
      await client.query(mode === 'READ ONLY' ? 'ROLLBACK' : 'COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {
        broken = true
      })
      if (signal?.aborted) throw cancelled()
      throw toDriverError(error)
    } finally {
      signal?.removeEventListener('abort', onAbort)
      client.release(broken || signal?.aborted === true)
    }
  }

  async serverInfo(): Promise<ServerInfo> {
    return queryServerInfo(this.pool(this.connection.config.database))
  }

  listDatabases(showSystem: boolean): Promise<DatabaseInfo[]> {
    return catalog.listDatabases(this.pool(this.connection.config.database), showSystem)
  }

  listSchemas(database: string, showSystem: boolean): Promise<SchemaInfo[]> {
    return catalog.listSchemas(this.pool(database), showSystem)
  }

  listObjects(database: string, schema: string): Promise<DbObjectInfo[]> {
    return catalog.listObjects(this.pool(database), schema)
  }

  tableDetails(database: string, schema: string, name: string): Promise<TableDetails> {
    return tableDetails(this.pool(database), schema, name)
  }

  getDdl(database: string, schema: string, name: string, kind: ObjectKind, identity?: string): Promise<string> {
    // search_path = pg_catalog makes every deparsed name schema-qualified (as pg_dump does).
    return this.transaction(database, 'catalog', 'READ ONLY', (client) => getDdl(client, schema, name, kind, identity), 'pg_catalog')
  }

  completionCatalog(database: string, showSystem: boolean): Promise<CompletionCatalog> {
    return catalog.completionCatalog(this.pool(database), database, showSystem)
  }

  fetchTableData(request: TableDataRequest, readOnlyConnection: boolean, signal?: AbortSignal): Promise<TableDataPage> {
    const { database } = request.table
    return this.transaction(
      database,
      'data',
      'READ ONLY',
      (client) => tableData.fetchTableData(client, this.typeCache(database), request, readOnlyConnection),
      undefined,
      signal,
    )
  }

  countTableData(request: Omit<TableDataRequest, 'offset' | 'limit' | 'orderBy'>, signal?: AbortSignal): Promise<number> {
    return this.transaction(request.table.database, 'data', 'READ ONLY', (client) => tableData.countTableData(client, request), undefined, signal)
  }

  async previewChanges(table: TableRef, changes: RowChange[]): Promise<string[]> {
    return tableData.previewChanges(table, changes)
  }

  applyChanges(table: TableRef, changes: RowChange[]): Promise<ApplyChangesResult> {
    return this.transaction(table.database, 'data', 'READ WRITE', (client) => tableData.applyChanges(client, table, changes))
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const pools = [...this.pools.values()]
    this.pools.clear()
    await Promise.all(pools.map((pool) => pool.end().catch(() => undefined)))
  }
}
