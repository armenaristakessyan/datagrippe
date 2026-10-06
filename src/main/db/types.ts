// Driver contract implemented by src/main/db/postgres and src/main/db/mssql.
// The session manager (src/main/db/session-manager.ts) is the only consumer.

import type {
  ApplyChangesResult,
  CompletionCatalog,
  ConnectionConfig,
  ConnectionSecrets,
  DatabaseInfo,
  DbObjectInfo,
  Dialect,
  ExecuteOptions,
  ExplainResult,
  FetchMoreResult,
  ObjectKind,
  QueryMessage,
  RowChange,
  SchemaInfo,
  ServerInfo,
  StatementResult,
  TableDataPage,
  TableDataRequest,
  TableDetails,
  TableRef,
  TransactionState,
} from '@shared/types'

/** Everything a driver needs to open a server connection. */
export interface ResolvedConnection {
  config: ConnectionConfig
  secrets: ConnectionSecrets
  /** Host/port to dial — differs from config when an SSH tunnel is active (127.0.0.1:<local port>). */
  host: string
  port: number
}

export interface DriverExecuteOptions extends ExecuteOptions {
  /** Server notices / PRINT / RAISERROR(low severity) as they arrive. */
  onMessage?: (message: QueryMessage) => void
}

export interface DriverExecuteResult {
  results: StatementResult[]
  messages: QueryMessage[]
  cancelled: boolean
}

/**
 * One dedicated server connection (a console tab). Statements run strictly one at a time.
 * Implementations must:
 *  - split scripts with splitStatements() from @shared/sql (pg: per statement, mssql: per GO batch)
 *  - fetch at most `maxRows` rows per result set and keep the remainder reachable via fetchMore
 *    (only the cursor of the LAST execution needs to stay open; any new execute/close discards it)
 *  - normalize values to CellValue (see @shared/types) and columns to ColumnMeta
 *  - honour cancel() while a statement runs (pg: pg_cancel_backend / client.cancel; mssql: request.cancel)
 *  - never throw for SQL errors inside execute(): report them as StatementResult{kind:'error'}
 *    (connection-level failures may throw a DriverError)
 */
export interface DriverSession {
  readonly dialect: Dialect
  readonly database: string
  readonly schema: string | undefined
  serverInfo(): Promise<ServerInfo>
  execute(sql: string, options: DriverExecuteOptions): Promise<DriverExecuteResult>
  fetchMore(cursorId: string, count: number): Promise<FetchMoreResult>
  cancel(): Promise<void>
  transactionState(): TransactionState
  setAutoCommit(autoCommit: boolean): Promise<TransactionState>
  commit(): Promise<TransactionState>
  rollback(): Promise<TransactionState>
  /** pg: SET search_path TO <schema>, public; mssql: remember only. */
  setSchema(schema: string): Promise<void>
  /** mssql: USE [db] and return true. pg: return false (the manager reopens a session on the new database). */
  useDatabase(database: string): Promise<boolean>
  /** pg: EXPLAIN (FORMAT JSON[, ANALYZE, BUFFERS]); mssql: SET SHOWPLAN_XML ON / STATISTICS XML ON. */
  explain(sql: string, analyze: boolean): Promise<ExplainResult>
  /** Make the session reject writes (pg: default_transaction_read_only). mssql: no-op (manager blocks statements). */
  setReadOnly(readOnly: boolean): Promise<void>
  close(): Promise<void>
  /** Called once when the server connection drops unexpectedly. */
  onUnexpectedClose(listener: (reason: string) => void): void
}

/** Pooled access used by the explorer, the structure view and the table data editor. */
export interface MetadataProvider {
  serverInfo(): Promise<ServerInfo>
  listDatabases(showSystem: boolean): Promise<DatabaseInfo[]>
  listSchemas(database: string, showSystem: boolean): Promise<SchemaInfo[]>
  listObjects(database: string, schema: string): Promise<DbObjectInfo[]>
  tableDetails(database: string, schema: string, name: string): Promise<TableDetails>
  getDdl(database: string, schema: string, name: string, kind: ObjectKind, identity?: string): Promise<string>
  completionCatalog(database: string, showSystem: boolean): Promise<CompletionCatalog>
  /** SELECT a page. `where` is user SQL inserted verbatim inside parentheses; ORDER BY columns are quoted. */
  /** `signal` aborts the running query (the promise then rejects with kind 'cancelled'). */
  fetchTableData(request: TableDataRequest, readOnlyConnection: boolean, signal?: AbortSignal): Promise<TableDataPage>
  countTableData(request: Omit<TableDataRequest, 'offset' | 'limit' | 'orderBy'>, signal?: AbortSignal): Promise<number>
  /** SQL that applyChanges would run, with literals inlined (display only). */
  previewChanges(table: TableRef, changes: RowChange[]): Promise<string[]>
  /** Parameterized statements in one transaction; every UPDATE/DELETE must affect exactly one row or everything rolls back. */
  applyChanges(table: TableRef, changes: RowChange[]): Promise<ApplyChangesResult>
  close(): Promise<void>
}

export interface DbDriver {
  readonly dialect: Dialect
  /** Connect, run a trivial query, disconnect. Throws DriverError on failure. */
  test(connection: ResolvedConnection): Promise<ServerInfo>
  openMetadata(connection: ResolvedConnection): Promise<MetadataProvider>
  openSession(connection: ResolvedConnection, database: string): Promise<DriverSession>
}
