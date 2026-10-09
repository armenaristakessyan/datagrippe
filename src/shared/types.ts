// Domain types shared by the main process, the preload bridge and the renderer.
// Everything here must be structured-clone friendly (plain objects, no classes).

export type Dialect = 'postgres' | 'mssql'

export const DIALECT_LABEL: Record<Dialect, string> = {
  postgres: 'PostgreSQL',
  mssql: 'SQL Server',
}

export const DEFAULT_PORT: Record<Dialect, number> = {
  postgres: 5432,
  mssql: 1433,
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export type ConnectionColor = 'none' | 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'gray'

export const CONNECTION_COLORS: ConnectionColor[] = ['none', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray']

/**
 * TLS settings. Semantics follow libpq's sslmode; the SQL Server driver maps them to
 * `encrypt` / `trustServerCertificate`:
 *  - disable     → encrypt=false
 *  - prefer      → encrypt=true, trustServerCertificate=true (PG: try TLS, accept any cert)
 *  - require     → encrypt=true, trustServerCertificate=true (PG: TLS mandatory, cert not verified)
 *  - verify-full → encrypt=true, trustServerCertificate=false (cert + hostname verified, optional CA)
 */
export type SslMode = 'disable' | 'prefer' | 'require' | 'verify-full'

export interface SslConfig {
  mode: SslMode
  /** Absolute path to a CA bundle (PEM). Optional, used with verify-full. */
  caPath?: string
  /** Client certificate / key (PEM) for mutual TLS (PostgreSQL only). */
  certPath?: string
  keyPath?: string
}

export type SshAuthMethod = 'password' | 'privateKey' | 'agent'

export interface SshConfig {
  enabled: boolean
  host: string
  port: number
  username: string
  authMethod: SshAuthMethod
  /** Absolute path to a private key file when authMethod === 'privateKey'. */
  privateKeyPath?: string
}

// ---------------------------------------------------------------------------
// HashiCorp Vault (dynamic / static database credentials)
// ---------------------------------------------------------------------------

/** How the database user/password are obtained. */
export type ConnectionAuthMode = 'password' | 'vault'

/**
 * How DataGrippe gets a Vault token:
 *  - token:    VAULT_TOKEN env var, then ~/.vault-token (written by `vault login`), then secrets.vaultToken.
 *              The first two only go to the VAULT_ADDR server, or to a server the user approved (native dialog).
 *  - oidc:     browser SSO, same flow as `vault login -method=oidc` (callback on http://localhost:8250/oidc/callback)
 *  - ldap / userpass: username + password (secrets.vaultPassword, prompted when not stored)
 */
export type VaultLoginMethod = 'token' | 'oidc' | 'ldap' | 'userpass'

export const DEFAULT_VAULT_AUTH_MOUNT: Record<Exclude<VaultLoginMethod, 'token'>, string> = {
  oidc: 'oidc',
  ldap: 'ldap',
  userpass: 'userpass',
}

export interface VaultConfig {
  /** Vault server address, e.g. "https://vault.example.com" (VAULT_ADDR). */
  address: string
  /** Vault Enterprise namespace (X-Vault-Namespace header). */
  namespace?: string
  loginMethod: VaultLoginMethod
  /** Auth method mount path; defaults to DEFAULT_VAULT_AUTH_MOUNT[loginMethod]. */
  authMount?: string
  /** OIDC role; empty = the mount's default role. */
  oidcRole?: string
  /** ldap / userpass username. */
  username?: string
  /**
   * Secret path without the "/v1/" prefix:
   *  - database secrets engine (dynamic):  "database/creds/<role>"  → data.username / data.password + lease
   *  - KV v2 (static):                     "secret/data/<path>"     → data.data[usernameKey/passwordKey]
   *  - KV v1 (static):                     "kv/<path>"              → data[usernameKey/passwordKey]
   * The response shape decides; no engine setting is needed.
   */
  secretPath: string
  /** Keys inside a KV secret. Defaults "username" / "password". */
  usernameKey?: string
  passwordKey?: string
  /** Revoke the dynamic lease on disconnect (drops the temporary database user). Default true. */
  revokeOnDisconnect?: boolean
  /** PEM CA bundle used to verify the Vault server's TLS certificate (else VAULT_CACERT, then the system trust store). */
  caPath?: string
  /**
   * loginMethod 'token' only: when VAULT_TOKEN, ~/.vault-token and the saved token are all missing or expired, sign in
   * with OIDC in the browser (authMount / oidcRole, same flow as `vault login -method=oidc`) instead of asking for a
   * token. Default true.
   */
  oidcFallback?: boolean
}

/**
 * Vault settings of the user's environment, as the vault CLI sees them: VAULT_ADDR / VAULT_NAMESPACE / VAULT_CACERT
 * from the process environment or, when the app was started from Finder, from the user's login shell (~/.zshrc…).
 * Used to prefill new Vault connections. Never contains a token.
 */
export interface VaultDefaults {
  address?: string
  namespace?: string
  caPath?: string
  /** Where the values came from. */
  source: 'env' | 'login-shell' | 'none'
  /** ~/.vault-token exists (written by `vault login`). */
  cliTokenFile: boolean
}

/** A connection whose secret path should be suggested from the Vault mounts the user can see. */
export interface VaultDiscoverTarget {
  /** Caller-chosen key echoed in the suggestions (connection id, import row key…). */
  key: string
  dialect: Dialect
  host: string
  database: string
  name: string
  /** Connection group / DBeaver folder (e.g. "PROD"): tells the environment when nothing else does. */
  group?: string
}

export interface VaultDiscoverRequest {
  /** Vault server + login settings (secretPath is ignored). */
  vault: VaultConfig
  /** Saved connection whose stored Vault secrets may be used to sign in. */
  connectionId?: string
  /** Secrets typed in a dialog and not saved yet (vaultToken / vaultPassword). */
  secrets?: ConnectionSecrets
  /** Role appended to a database mount: "<mount>/creds/<role>". Default "read_only". */
  role?: string
  targets: VaultDiscoverTarget[]
}

/** A secrets engine mount visible to the user's token. */
export interface VaultMountInfo {
  /** Mount path without trailing slash, e.g. "cloud/prod/team/pg-orders-1/orders". */
  path: string
  /** Engine type: "database", "kv"… */
  type: string
  description?: string
}

export interface VaultPathSuggestion {
  key: string
  /** Suggested secret path, e.g. "<mount>/creds/read_only". */
  path: string
  mount: string
  /** 0..1 — how well the mount matches the target (database name, host, connection name). */
  score: number
  /** Short human explanation, e.g. 'mount contains database "orders" and host "pg-orders-1"'. */
  reason: string
}

export interface VaultDiscoverResult {
  /** Database secrets engine mounts visible to the token (sorted). */
  mounts: VaultMountInfo[]
  /** Best suggestion per target (targets without a plausible match are absent). */
  suggestions: VaultPathSuggestion[]
  /** Best mounts per target key, best first (for pickers): at most 12 each. */
  ranking?: Record<string, { mount: string; path: string; score: number }[]>
  warnings: string[]
}

/** Where the Vault token used for a connection came from. */
export type VaultTokenSource = 'env' | 'cli' | 'stored' | 'oidc' | 'ldap' | 'userpass'

/** Credentials obtained from Vault, without the password (never sent to the renderer). */
export interface VaultCredentialsInfo {
  username: string
  /** 'dynamic' = database secrets engine lease; 'static' = KV secret. */
  kind: 'dynamic' | 'static'
  /**
   * Epoch ms when the credentials stop working: lease expiry, capped by the expiry of the Vault token that issued
   * it (Vault revokes a token's leases with it); for a database static role, the next password rotation.
   */
  expiresAt?: number
  leaseDurationSec?: number
  renewable?: boolean
  tokenSource: VaultTokenSource
  /** Epoch ms when the credentials were issued. */
  issuedAt: number
}

export interface VaultTestResult {
  ok: boolean
  info?: VaultCredentialsInfo
  error?: DbErrorInfo
  latencyMs?: number
  /**
   * Things that work differently than configured, e.g. the Vault policy does not allow revoking leases
   * (sys/leases/revoke), so "Revoke on disconnect" cannot drop the temporary user.
   */
  warnings?: string[]
}

export type VaultLeaseState = 'valid' | 'renewing' | 'expiring' | 'expired' | 'error'

export interface VaultStatus {
  connectionId: string
  state: VaultLeaseState
  info: VaultCredentialsInfo | null
  /** Human readable detail (last renewal error…). */
  message?: string
}

/** Progress of an interactive Vault login (OIDC browser flow). */
export interface VaultLoginEvent {
  /** Vault address (+ namespace) being signed in to. */
  address: string
  namespace?: string
  state: 'browser-opened' | 'completed' | 'failed' | 'cancelled'
  /** The URL opened in the browser (so the UI can offer "open again" / copy). */
  url?: string
  message?: string
}

// ---------------------------------------------------------------------------
// DBeaver import
// ---------------------------------------------------------------------------

export interface DbeaverImportCandidate {
  /** DBeaver connection id (key in data-sources*.json). */
  sourceId: string
  sourceFile: string
  /** Original DBeaver name / folder / provider, for display. */
  sourceName: string
  sourceFolder?: string
  sourceProvider: string
  /** Ready-to-save definition (never contains secrets). Null when the provider is not supported. */
  input: ConnectionInput | null
  /** Things the user should know or complete (e.g. "Set the Vault secret path"). */
  notes: string[]
  /** Id of an existing DataGrippe connection to the same dialect/host/port/database. */
  duplicateOf?: string
}

export interface DbeaverScanResult {
  /** data-sources*.json files that were read. */
  files: string[]
  candidates: DbeaverImportCandidate[]
  warnings: string[]
}

export interface ConnectionOptions {
  /** Shown in pg_stat_activity / sys.dm_exec_sessions. Default "DataGrippe". */
  applicationName?: string
  /** Connect timeout in ms. Default 15000. */
  connectTimeoutMs?: number
  /** SQL Server named instance (e.g. SQLEXPRESS). */
  instanceName?: string
  /** Show system schemas/databases in the explorer (pg_catalog, information_schema, sys, master…). */
  showSystemObjects?: boolean
  /** Optional startup schema (PostgreSQL search_path / SQL Server default schema hint). */
  defaultSchema?: string
  /**
   * PostgreSQL session time zone (how timestamptz values are shown). Undefined or 'server' = the server's
   * TimeZone setting; 'local' = this computer's time zone; any other value = a zone name (e.g. 'Europe/Paris').
   */
  timeZone?: string
}

/** Persisted connection definition. Secrets (passwords) are never part of this object. */
export interface ConnectionConfig {
  id: string
  name: string
  dialect: Dialect
  host: string
  port: number
  /** Initial database. PostgreSQL: required (defaults to "postgres"); SQL Server: optional (defaults to login default). */
  database: string
  user: string
  /** If false, the password is asked at connect time and kept in memory only. */
  savePassword: boolean
  /** Computed by the main process: a password is stored for this connection. */
  hasPassword: boolean
  /**
   * Computed by the main process for authMode 'vault': the Vault secret of the login method is stored
   * (vaultToken for 'token', vaultPassword for ldap / userpass). Never persisted in connections.json.
   */
  hasVaultSecret?: boolean
  ssl: SslConfig
  ssh: SshConfig
  color: ConnectionColor
  /** Optional folder name used to group connections in the sidebar. */
  group?: string
  /** Block every statement that may modify data or schema. */
  readOnly: boolean
  /** Ask for confirmation before running destructive statements (DROP, TRUNCATE, DELETE/UPDATE without WHERE…). */
  productionGuard: boolean
  /** 'password' (default when absent) or 'vault' (user/password fetched from HashiCorp Vault at connect time). */
  authMode?: ConnectionAuthMode
  /**
   * Required when authMode === 'vault'. `user` and the database password are ignored then (the user is issued by
   * Vault); savePassword applies to the Vault secret of the login method (vaultToken / vaultPassword) instead.
   */
  vault?: VaultConfig
  options: ConnectionOptions
  createdAt: string
  updatedAt: string
}

/**
 * Secrets travel renderer → main only when saving/testing a connection.
 * `undefined` means "keep what is stored", empty string means "clear".
 */
export interface ConnectionSecrets {
  password?: string
  sshPassword?: string
  sshPassphrase?: string
  /** Vault token for loginMethod 'token' when neither VAULT_TOKEN nor ~/.vault-token is usable. */
  vaultToken?: string
  /** Vault ldap / userpass password. */
  vaultPassword?: string
}

export type ConnectionInput = Omit<ConnectionConfig, 'id' | 'createdAt' | 'updatedAt' | 'hasPassword'> & {
  id?: string
  secrets?: ConnectionSecrets
}

export interface ServerInfo {
  dialect: Dialect
  /** Full version string (SELECT version() / @@VERSION). */
  version: string
  /** Short version, e.g. "16.4" or "16.0.4135". */
  versionShort: string
  currentDatabase: string
  currentUser: string
  currentSchema?: string
}

export interface TestConnectionResult {
  ok: boolean
  info?: ServerInfo
  error?: DbErrorInfo
  latencyMs?: number
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface DbErrorInfo {
  message: string
  /** SQLSTATE (PostgreSQL) or error number (SQL Server) as string. */
  code?: string
  severity?: string
  detail?: string
  hint?: string
  /** 1-based character offset inside the failing statement (PostgreSQL `position`). */
  position?: number
  /** 1-based line number inside the failing statement/batch (SQL Server `lineNumber`). */
  line?: number
  /** Where the error happened inside server-side code, e.g. "PL/pgSQL function f() line 3 at RAISE". */
  context?: string
  /** Name of the error class on the main side, e.g. "NeedsPasswordError", "ReadOnlyViolation". */
  kind?: ErrorKind
  /** kind 'needs-host-key': the SSH server's key that must be confirmed (or that changed). */
  hostKey?: SshHostKeyInfo
  /**
   * kind 'needs-password': which secret to prompt for (default 'password'): the database password,
   * the Vault token ('vaultToken') or the Vault ldap/userpass password ('vaultPassword').
   */
  secretField?: 'password' | 'vaultToken' | 'vaultPassword'
}

/**
 * An SSH host key the user has not trusted yet (first connection) or that differs from the trusted one.
 * The renderer shows the fingerprint, and on confirmation calls `ssh:trustHostKey` then connects again.
 */
export interface SshHostKeyInfo {
  host: string
  port: number
  /** Key algorithm, e.g. "ssh-ed25519". */
  keyType: string
  /** OpenSSH-style fingerprint: "SHA256:<base64 without padding>". */
  fingerprint: string
  /** True when a different key was trusted (or listed in ~/.ssh/known_hosts) for this host: possible attack. */
  changed: boolean
  /** Fingerprint previously trusted for this host, when `changed`. */
  previousFingerprint?: string
}

export type ErrorKind =
  | 'database'
  | 'connection'
  | 'needs-password'
  /** HashiCorp Vault refused or failed (sealed, permission denied, path not found, login failed…). */
  | 'vault'
  /** SSH tunnel: the server's host key is unknown or changed (see DbErrorInfo.hostKey). */
  | 'needs-host-key'
  | 'read-only'
  | 'cancelled'
  | 'not-found'
  | 'invalid-input'
  | 'internal'

// ---------------------------------------------------------------------------
// Explorer / metadata
// ---------------------------------------------------------------------------

export type ObjectKind =
  | 'table'
  | 'view'
  | 'materialized-view'
  | 'foreign-table'
  | 'function'
  | 'procedure'
  | 'sequence'
  | 'type'

export interface DatabaseInfo {
  name: string
  isSystem: boolean
  sizeBytes?: number
}

export interface SchemaInfo {
  name: string
  isSystem: boolean
  owner?: string
}

export interface DbObjectInfo {
  schema: string
  name: string
  kind: ObjectKind
  comment?: string
  /** Approximate row count from statistics (tables / materialized views). */
  rowEstimate?: number
  /** Routines: argument list, e.g. "(customer_id integer, since date)". */
  signature?: string
  /** Routines: return type. */
  returnType?: string
  /** Stable identity used to disambiguate overloads (pg oid / mssql object_id), as string. */
  identity?: string
}

export interface ColumnInfo {
  name: string
  /** 1-based ordinal position. */
  ordinal: number
  /** Formatted type, e.g. "varchar(255)", "numeric(12,2)", "timestamp with time zone". */
  dataType: string
  nullable: boolean
  defaultValue: string | null
  isPrimaryKey: boolean
  /** Identity / serial / auto-increment column. */
  isIdentity: boolean
  /** Computed / generated column (never writable). */
  isGenerated: boolean
  comment?: string
}

export interface IndexInfo {
  name: string
  columns: string[]
  isUnique: boolean
  isPrimary: boolean
  /** btree / gin / hash… (pg) or CLUSTERED / NONCLUSTERED / COLUMNSTORE (mssql). */
  method?: string
  /** Partial-index predicate / filtered-index filter. */
  predicate?: string
  /** Full CREATE INDEX statement when available. */
  definition?: string
}

export type FkAction = 'NO ACTION' | 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT'

export interface ForeignKeyInfo {
  name: string
  schema: string
  table: string
  columns: string[]
  refSchema: string
  refTable: string
  refColumns: string[]
  onUpdate: FkAction
  onDelete: FkAction
}

export interface ConstraintInfo {
  name: string
  type: 'primary-key' | 'unique' | 'check' | 'exclusion' | 'default'
  columns: string[]
  definition?: string
}

export interface TriggerInfo {
  name: string
  /** BEFORE / AFTER / INSTEAD OF */
  timing: string
  /** INSERT / UPDATE / DELETE / TRUNCATE */
  events: string[]
  enabled: boolean
  definition?: string
}

export interface TableDetails {
  schema: string
  name: string
  kind: ObjectKind
  comment?: string
  rowEstimate?: number
  sizeBytes?: number
  columns: ColumnInfo[]
  /** Column names of the primary key, in key order (empty when none). */
  primaryKey: string[]
  indexes: IndexInfo[]
  foreignKeys: ForeignKeyInfo[]
  /** Foreign keys of other tables pointing at this one. */
  referencedBy: ForeignKeyInfo[]
  constraints: ConstraintInfo[]
  triggers: TriggerInfo[]
}

export interface DdlRequest {
  connectionId: string
  database: string
  schema: string
  name: string
  kind: ObjectKind
  identity?: string
}

/** Compact catalog used by the editor's autocompletion. */
export interface CompletionCatalog {
  database: string
  defaultSchema: string
  schemas: CompletionSchema[]
}

export interface CompletionSchema {
  name: string
  objects: CompletionObject[]
}

export interface CompletionObject {
  name: string
  kind: ObjectKind
  /** Present for tables / views / materialized views. */
  columns?: { name: string; dataType: string }[]
  /** Present for routines. */
  signature?: string
}

// ---------------------------------------------------------------------------
// Query execution
// ---------------------------------------------------------------------------

/** Cell values are normalized by the main process so they display faithfully:
 *  - booleans → boolean, small ints / floats → number
 *  - bigint, numeric/decimal (pg), dates/times, uuid, json, arrays, intervals… → string (raw text)
 *  - binary → "\\x…" (pg) / "0x…" (mssql) hex string
 *  - NULL → null
 */
export type CellValue = string | number | boolean | null

export interface ColumnMeta {
  name: string
  /** Database type name, e.g. "int4", "varchar", "timestamptz", "nvarchar", "datetime2". */
  dataType: string
  /** Source table (when the driver can tell). */
  table?: string
  nullable?: boolean
}

export interface ExecuteOptions {
  /** Rows fetched per result set before stopping (the rest is available through fetchMore). */
  maxRows: number
  /** Stop at the first failing statement (default true). */
  stopOnError?: boolean
  /** Per-statement timeout in ms (0 / undefined = none). */
  timeoutMs?: number
  /** Record the run in the query history (default true). */
  history?: boolean
}

export type StatementKind = 'rows' | 'command' | 'error'

export interface StatementResult {
  /** 0-based position of the statement/batch in the execution. */
  index: number
  /** Statement (pg) or batch (mssql) text actually sent. */
  sql: string
  /** Character offset of `sql` inside the text submitted to `session.execute`. */
  offset: number
  kind: StatementKind
  columns: ColumnMeta[]
  rows: CellValue[][]
  /** Rows affected (DML) or rows fetched so far (SELECT). Null when unknown. */
  rowCount: number | null
  /**
   * The result set has more rows than were fetched. With `cursorId`, the rest can be fetched with
   * session.fetchMore(cursorId) (only the last result of the latest execution keeps a cursor).
   * Without `cursorId` the result was truncated at maxRows and the remainder is not fetchable.
   */
  hasMore: boolean
  cursorId?: string
  /** Command tag, e.g. "SELECT", "UPDATE", "CREATE TABLE". */
  command?: string
  durationMs: number
  error?: DbErrorInfo
}

export type MessageLevel = 'info' | 'notice' | 'warning' | 'error'

export interface QueryMessage {
  level: MessageLevel
  text: string
  /** Epoch ms. */
  at: number
  /**
   * Position in the execution's stream: number of StatementResults produced before this message, when the
   * driver knows it. Used to interleave messages and statement summaries exactly.
   */
  resultsBefore?: number
}

export interface TransactionState {
  autoCommit: boolean
  /** A transaction is open (manual mode, or an explicit BEGIN). */
  inTransaction: boolean
}

export interface ExecutionResult {
  executionId: string
  sessionId: string
  results: StatementResult[]
  messages: QueryMessage[]
  durationMs: number
  cancelled: boolean
  transaction: TransactionState
}

export interface FetchMoreResult {
  rows: CellValue[][]
  hasMore: boolean
}

export interface SessionInfo {
  sessionId: string
  connectionId: string
  database: string
  schema?: string
  transaction: TransactionState
}

export interface OpenSessionRequest {
  connectionId: string
  /** Database to connect to; defaults to the connection's database. */
  database?: string
}

export interface SetDatabaseOptions {
  /**
   * PostgreSQL reconnects the session to switch database, which rolls back an open transaction. Without
   * this flag the switch is refused while a transaction is open (the UI asks the user first).
   */
  discardTransaction?: boolean
}

// ---------------------------------------------------------------------------
// Explain
// ---------------------------------------------------------------------------

export interface PlanNode {
  /** e.g. "Seq Scan", "Hash Join", "Clustered Index Seek". */
  operation: string
  /** e.g. "on public.orders o", "Index Cond: (id = 42)". */
  details: string[]
  /** Relation / object involved, when known. */
  relation?: string
  estimatedRows?: number
  estimatedCost?: number
  actualRows?: number
  actualTimeMs?: number
  loops?: number
  children: PlanNode[]
}

export interface ExplainResult {
  format: 'postgres-json' | 'mssql-xml'
  /** Raw plan as returned by the server (JSON text or showplan XML). */
  raw: string
  root: PlanNode | null
  totalTimeMs?: number
  planningTimeMs?: number
}

// ---------------------------------------------------------------------------
// Table data editing
// ---------------------------------------------------------------------------

export interface TableRef {
  connectionId: string
  database: string
  schema: string
  name: string
}

export interface SortSpec {
  column: string
  direction: 'asc' | 'desc'
}

export interface TableDataRequest {
  table: TableRef
  offset: number
  limit: number
  /** Raw SQL predicate typed by the user (without the WHERE keyword). */
  where?: string
  orderBy?: SortSpec[]
  /** Caller-chosen id: `data:cancel(requestId)` stops the query (it then fails with kind 'cancelled'). */
  requestId?: string
}

export interface TableDataPage {
  columns: ColumnMeta[]
  rows: CellValue[][]
  offset: number
  hasMore: boolean
  /** Primary-key column names; empty when the table has none. */
  primaryKey: string[]
  /** False when the table cannot be safely edited (no PK, view, read-only connection…). */
  editable: boolean
  /** Why editing is disabled, for the UI. */
  readOnlyReason?: string
  /** The SELECT that produced this page. */
  sql: string
  durationMs: number
}

/** Marker for "use the column default" in inserts. */
export interface DefaultValue {
  $default: true
}

export type EditValue = CellValue | DefaultValue

export type RowChange =
  | { type: 'update'; key: Record<string, CellValue>; values: Record<string, CellValue> }
  | { type: 'insert'; values: Record<string, EditValue> }
  | { type: 'delete'; key: Record<string, CellValue> }

export interface ApplyChangesResult {
  /** Total rows affected. */
  affected: number
  /** SQL that was executed (literals inlined, for display). */
  statements: string[]
}

// ---------------------------------------------------------------------------
// History, workspace, settings
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  id: string
  connectionId: string
  database?: string
  sql: string
  /** ISO timestamp. */
  executedAt: string
  durationMs: number
  success: boolean
  /** Rows returned/affected by the last statement. */
  rowCount?: number | null
  error?: string
  /** Console schema (PostgreSQL search_path / SQL Server default schema) when the statement ran. */
  schema?: string
  /** `sql` was cut to HISTORY_MAX_SQL_CHARS: re-running the entry would not run the whole script. */
  truncated?: boolean
}

export interface HistoryQuery {
  connectionId?: string
  search?: string
  limit?: number
}

export type TabKind = 'console' | 'table' | 'structure'

export interface PersistedTab {
  id: string
  kind: TabKind
  title: string
  connectionId: string
  database?: string
  schema?: string
  /** Console text. */
  content?: string
  /** Console opened from / saved to this .sql file. */
  filePath?: string
  /** Table / structure tabs. */
  table?: { schema: string; name: string; kind: ObjectKind }
  /** Pinned tabs survive "close others". */
  pinned?: boolean
}

export interface WorkspaceState {
  version: 1
  tabs: PersistedTab[]
  activeTabId?: string
  /** Free-form UI layout values (panel sizes, expanded tree nodes…). */
  layout?: Record<string, unknown>
}

export type ThemePreference = 'dark' | 'light' | 'system'

/** The app icon the bundle carries; Settings › Appearance can show a custom one in the Dock instead. */
export const BUILTIN_APP_ICON = 'datagrippe'

/** A custom app icon: a PNG file of the icons folder ("DataGrip Halo.png" → id "datagrip-halo"). */
export interface AppIconInfo {
  id: string
  label: string
  /** data:image/png;base64,… (the renderer cannot read the file). */
  dataUrl: string
}

/** App icon ids are lower-case slugs of the file names. */
export function isAppIconId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value)
}

export interface AppSettings {
  theme: ThemePreference
  /** BUILTIN_APP_ICON or the id of a custom icon (AppIconInfo). */
  appIcon: string
  editorFontSize: number
  editorWordWrap: boolean
  editorTabSize: number
  editorMinimap: boolean
  /** Rows fetched per result set. */
  maxRows: number
  /** Text shown for NULL cells. */
  nullDisplay: string
  /** Ask before destructive statements on connections flagged with productionGuard. */
  confirmDestructive: boolean
  /** Upper-case keywords when formatting. */
  formatKeywordCase: 'upper' | 'lower' | 'preserve'
  /** Show row numbers in grids. */
  gridRowNumbers: boolean
  /** Prompt for values of :name, $1, ?, @name and ${name} placeholders before a run. */
  detectParameters: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  appIcon: BUILTIN_APP_ICON,
  editorFontSize: 13,
  editorWordWrap: false,
  editorTabSize: 2,
  editorMinimap: false,
  maxRows: 500,
  nullDisplay: 'NULL',
  confirmDestructive: true,
  formatKeywordCase: 'upper',
  gridRowNumbers: true,
  detectParameters: true,
}

export interface AppInfo {
  version: string
  platform: string
  userDataPath: string
  electronVersion: string
}

// ---------------------------------------------------------------------------
// Files / export
// ---------------------------------------------------------------------------

export type ExportFormat = 'csv' | 'tsv' | 'json' | 'sql' | 'markdown'

export interface SaveTextRequest {
  defaultName: string
  content: string
  filters?: { name: string; extensions: string[] }[]
}

export interface ExportQueryRequest {
  connectionId: string
  database?: string
  /** Console schema (search_path on PostgreSQL) so unqualified names resolve as they do in the console. */
  schema?: string
  /**
   * Caller-chosen id: progress is reported through `event:exportProgress` and `files:cancelExport(exportId)`
   * stops the export (the partial file is removed).
   */
  exportId?: string
  sql: string
  format: Exclude<ExportFormat, 'markdown'>
  /** Table name used for SQL INSERT export. */
  tableName?: string
  defaultName: string
}

export interface ExportResult {
  /** Null when the user cancelled the save dialog. */
  path: string | null
  rows: number
}

export interface WriteTextRequest {
  /** Absolute path of a file the user opened or saved in this run. */
  path: string
  content: string
}

export interface OpenTextResult {
  path: string
  content: string
}

export interface ExportProgress {
  exportId: string
  /** Rows written so far. */
  rows: number
}

// ---------------------------------------------------------------------------
// Unsaved work (quit / window close guard)
// ---------------------------------------------------------------------------

/**
 * Work the renderer would lose on quit (pending table edits, unsaved console files…), reported with
 * `app:setUnsavedWork`. Main adds the consoles with an open transaction and asks before quitting.
 */
export interface UnsavedWorkItem {
  kind: 'table-edits' | 'console' | 'other'
  /** Tab / object title, e.g. "public.orders". */
  title: string
  /** e.g. "3 pending changes". */
  detail?: string
}

// ---------------------------------------------------------------------------
// CSV import
// ---------------------------------------------------------------------------

export interface CsvParseOptions {
  /** Field separator (default ","). "\t" for TSV. */
  delimiter?: string
  /** First line holds the column names (default true). */
  header?: boolean
  /** Field text read as NULL (default: empty unquoted field). Quoted "" is always an empty string. */
  nullText?: string
  /** Lines to skip before the header / first row (default 0). */
  skipLines?: number
}

/** files:pickImportFile — a CSV / TSV file chosen by the user, with a preview of its first rows. */
export interface ImportFilePreview {
  path: string
  /** File name for display. */
  name: string
  sizeBytes: number
  /** Options detected from the content (delimiter, header) and used for the preview. */
  options: Required<CsvParseOptions>
  /** Column names from the header (or column_1…). */
  headers: string[]
  /** Up to 50 rows, as text (null = NULL). */
  rows: (string | null)[][]
}

export interface ImportColumnMapping {
  /** 0-based index of the source field in each CSV record. */
  source: number
  /** Target column name. */
  column: string
}

export interface ImportCsvRequest {
  /** Caller-chosen id for `event:importProgress` and `files:cancelImport`. */
  importId: string
  table: TableRef
  path: string
  options: CsvParseOptions
  /** Target columns; unmapped table columns get their default. */
  mapping: ImportColumnMapping[]
  /** Rows per INSERT statement (default 500, capped by the server's parameter limit). */
  batchSize?: number
}

export interface ImportProgress {
  importId: string
  /** Rows inserted so far. */
  rows: number
  /** Bytes of the file read so far (for a progress bar). */
  bytesRead: number
  totalBytes: number
}

export interface ImportCsvResult {
  /** Rows inserted (all-or-nothing: the import runs in one transaction). */
  rows: number
  durationMs: number
}
