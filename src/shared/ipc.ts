// Single source of truth for renderer ⇄ main communication.
//
// - Every request/response call is listed in `IpcContract` as `channel: (...args) => result`.
// - The main process registers one handler per channel (src/main/ipc.ts).
// - The preload exposes a generic `invoke(channel, ...args)` that resolves to an `IpcEnvelope`.
// - The renderer uses the typed client in src/renderer/src/lib/api.ts, which unwraps envelopes
//   and throws `ApiError` (carrying a DbErrorInfo) on failure.
// - Main → renderer push events are listed in `IpcEvents`.

import type {
  AppIconInfo,
  AppInfo,
  AppSettings,
  ApplyChangesResult,
  CompletionCatalog,
  ConnectionConfig,
  ConnectionInput,
  ConnectionSecrets,
  CsvParseOptions,
  DatabaseInfo,
  DbErrorInfo,
  DbObjectInfo,
  DbeaverScanResult,
  DdlRequest,
  ExecuteOptions,
  ExecutionResult,
  ExplainResult,
  ExportProgress,
  ExportQueryRequest,
  ExportResult,
  FetchMoreResult,
  HistoryEntry,
  HistoryQuery,
  ImportCsvRequest,
  ImportCsvResult,
  ImportFilePreview,
  ImportProgress,
  OpenSessionRequest,
  OpenTextResult,
  QueryMessage,
  RowChange,
  SaveTextRequest,
  SchemaInfo,
  ServerInfo,
  SessionInfo,
  SetDatabaseOptions,
  SshHostKeyInfo,
  TableDataPage,
  TableDataRequest,
  TableDetails,
  TableRef,
  TestConnectionResult,
  TransactionState,
  UnsavedWorkItem,
  VaultDefaults,
  VaultDiscoverRequest,
  VaultDiscoverResult,
  VaultLoginEvent,
  VaultStatus,
  VaultTestResult,
  WorkspaceState,
  WriteTextRequest,
} from './types'

/** What `files:pickPath` lets the user choose. */
export type PickPathKind = 'file' | 'folder' | 'any'

export interface IpcContract {
  // --- app -----------------------------------------------------------------
  'app:info': () => AppInfo
  'app:openExternal': (url: string) => void
  'app:showItemInFolder': (path: string) => void
  /** Custom app icons: the PNG files of <userData>/icons. */
  'app:icons': () => AppIconInfo[]
  /** Open the icons folder in Finder (created when missing). */
  'app:openIconsFolder': () => void
  /**
   * Work that would be lost on quit / window close (pending table edits…). Main asks the user before
   * quitting when this list is not empty or a console has an open transaction. Send [] once saved.
   */
  'app:setUnsavedWork': (items: UnsavedWorkItem[]) => void

  // --- settings ------------------------------------------------------------
  'settings:get': () => AppSettings
  'settings:update': (patch: Partial<AppSettings>) => AppSettings

  // --- connections ---------------------------------------------------------
  'connections:list': () => ConnectionConfig[]
  /** Create (no id) or update a connection. Secrets: undefined = keep, '' = clear. */
  'connections:save': (input: ConnectionInput) => ConnectionConfig
  'connections:delete': (id: string) => void
  'connections:duplicate': (id: string) => ConnectionConfig
  /** Test an unsaved (or edited) definition. When input.id is set, stored secrets fill in missing ones. */
  'connections:test': (input: ConnectionInput) => TestConnectionResult
  /**
   * Open the metadata pool (and SSH tunnel) for a saved connection.
   * Fails with kind 'needs-password' when no password is stored and none was provided;
   * the renderer then prompts and calls again with `secrets`.
   */
  'connections:connect': (id: string, secrets?: ConnectionSecrets) => ServerInfo
  /** Close every session, pool and tunnel of the connection. */
  'connections:disconnect': (id: string) => void
  /** Ids of connections currently connected. */
  'connections:active': () => string[]
  /**
   * Trust an SSH host key after the user checked its fingerprint (from a 'needs-host-key' error), then
   * connect again. `fingerprint` must be the one reported for host:port, so a key presented later by
   * another server is never trusted by accident.
   */
  'ssh:trustHostKey': (key: SshHostKeyInfo) => void

  // --- HashiCorp Vault ---------------------------------------------------------
  /**
   * Log in to Vault (interactive OIDC when needed) and fetch credentials for an unsaved/edited definition
   * (input.vault). Dynamic leases obtained by a test are revoked right away. Never throws.
   */
  'vault:test': (input: ConnectionInput) => VaultTestResult
  /** Current lease state of a connected Vault connection; null when not connected or not a Vault connection. */
  'vault:status': (connectionId: string) => VaultStatus | null
  /**
   * Fetch fresh credentials now (revoking the old dynamic lease once nothing uses it): the metadata pool is
   * reopened; console sessions keep their server connection and pick the new credentials when they reconnect.
   */
  'vault:refresh': (connectionId: string) => VaultStatus
  /** Abort a pending OIDC browser login (connect / test then fail with kind 'cancelled'). */
  'vault:cancelLogin': () => void
  /** Forget the cached Vault token for this server (next use logs in again). Never touches ~/.vault-token. */
  'vault:logout': (address: string, namespace?: string) => void
  /** VAULT_ADDR / VAULT_NAMESPACE / VAULT_CACERT of the user's environment (login shell when started from Finder). */
  'vault:defaults': () => VaultDefaults
  /**
   * Sign in (same rules as connect) and list the database secrets engine mounts the token can see
   * (sys/internal/ui/mounts), then suggest "<mount>/creds/<role>" for each target. Never throws for a refused
   * listing: returns warnings instead.
   */
  'vault:discover': (req: VaultDiscoverRequest) => VaultDiscoverResult

  // --- import from other tools ---------------------------------------------------
  /**
   * Read DBeaver connection definitions (data-sources*.json). Without `path`, scans the default workspace
   * (~/Library/DBeaverData/workspace6/<project>/.dbeaver/ on macOS, %APPDATA%\DBeaverData\… on Windows,
   * ${XDG_DATA_HOME:-~/.local/share}/DBeaverData/… plus the Flatpak / Snap locations on Linux). `path` may be a
   * data-sources*.json file, a .dbeaver folder, a project, a workspace or the DBeaverData folder.
   * DBeaver's credentials files are never read: passwords are not imported.
   */
  'import:dbeaverScan': (path?: string) => DbeaverScanResult
  /** Data sources copied in DataGrip (or a dataSources.xml), pasted as text. */
  'import:datagripParse': (text: string) => DbeaverScanResult

  // --- metadata (uses the connection's metadata pool; connects lazily) ------
  'meta:databases': (connectionId: string) => DatabaseInfo[]
  'meta:schemas': (connectionId: string, database: string) => SchemaInfo[]
  'meta:objects': (connectionId: string, database: string, schema: string) => DbObjectInfo[]
  'meta:tableDetails': (connectionId: string, database: string, schema: string, name: string) => TableDetails
  'meta:ddl': (req: DdlRequest) => string
  'meta:completionCatalog': (connectionId: string, database: string) => CompletionCatalog

  // --- sessions (one dedicated server connection per console tab) ----------
  'session:open': (req: OpenSessionRequest) => SessionInfo
  'session:close': (sessionId: string) => void
  /** Execute one or more statements. Script splitting happens in main (see src/shared/sql). */
  'session:execute': (sessionId: string, sql: string, options: ExecuteOptions) => ExecutionResult
  'session:fetchMore': (sessionId: string, cursorId: string, count: number) => FetchMoreResult
  /** Cancel the running statement of the session (no-op when idle). */
  'session:cancel': (sessionId: string) => void
  'session:setAutoCommit': (sessionId: string, autoCommit: boolean) => TransactionState
  'session:commit': (sessionId: string) => TransactionState
  'session:rollback': (sessionId: string) => TransactionState
  /**
   * Switch database. PostgreSQL reconnects the session (keeping the auto-commit mode) and refuses while a
   * transaction is open unless `options.discardTransaction`; SQL Server issues USE.
   */
  'session:setDatabase': (sessionId: string, database: string, options?: SetDatabaseOptions) => SessionInfo
  /** PostgreSQL: SET search_path; SQL Server: remembered as the default schema for unqualified names in the UI. */
  'session:setSchema': (sessionId: string, schema: string) => SessionInfo
  'session:explain': (sessionId: string, sql: string, analyze: boolean) => ExplainResult

  // --- table data editor (uses the metadata pool) ----------------------------
  'data:fetch': (req: TableDataRequest) => TableDataPage
  'data:count': (req: Omit<TableDataRequest, 'offset' | 'limit' | 'orderBy'>) => number
  /** Stop a running data:fetch / data:count started with this `requestId` (no-op when done). */
  'data:cancel': (requestId: string) => void
  /** Render the SQL that applyChanges would run (literals inlined) without executing it. */
  'data:previewChanges': (table: TableRef, changes: RowChange[]) => string[]
  /** Apply all changes in a single transaction (all-or-nothing). */
  'data:applyChanges': (table: TableRef, changes: RowChange[]) => ApplyChangesResult

  // --- history ---------------------------------------------------------------
  'history:list': (query: HistoryQuery) => HistoryEntry[]
  'history:clear': (connectionId?: string) => void

  // --- workspace persistence -------------------------------------------------
  'workspace:load': () => WorkspaceState | null
  'workspace:save': (state: WorkspaceState) => void

  // --- files -----------------------------------------------------------------
  /** Show a save dialog and write the text. Resolves to the path, or null when cancelled. */
  'files:saveText': (req: SaveTextRequest) => string | null
  /** Show an open dialog for .sql files. Null when cancelled. */
  'files:openText': () => OpenTextResult | null
  /**
   * Save in place (UTF-8) a .sql file the user opened or saved before (Cmd+S on a console bound to a file).
   * Resolves to the path. Fails with 'not-found' when the folder no longer exists.
   */
  'files:writeText': (req: WriteTextRequest) => string
  /** Run a query on a temporary session and stream every row to a file chosen by the user. */
  'files:exportQuery': (req: ExportQueryRequest) => ExportResult
  /** Stop a running export started with `exportId` (it then fails with kind 'cancelled'). No-op when done. */
  'files:cancelExport': (exportId: string) => void
  /** Choose a CSV / TSV file to import and preview it. `options` overrides the detected ones. Null when cancelled. */
  'files:pickImportFile': (options?: CsvParseOptions) => ImportFilePreview | null
  /** Re-read the preview of an already chosen file with other parsing options. */
  'files:previewImport': (path: string, options: CsvParseOptions) => ImportFilePreview
  /** Insert every CSV record into a table, in one transaction (all-or-nothing), in batches. */
  'files:importCsv': (req: ImportCsvRequest) => ImportCsvResult
  /** Stop a running import (rolled back; nothing is inserted). No-op when done. */
  'files:cancelImport': (importId: string) => void
  /** Native file picker for SSL certs / SSH keys. Null when cancelled. */
  /**
   * Native open dialog (hidden files shown). `kind` (default 'file'): 'folder' picks a folder; 'any' lets the
   * user pick a file or a folder on macOS and falls back to a file picker elsewhere (Windows / Linux dialogs
   * cannot do both).
   */
  'files:pickPath': (title: string, kind?: PickPathKind) => string | null
}

export type IpcChannel = keyof IpcContract
export type IpcArgs<C extends IpcChannel> = Parameters<IpcContract[C]>
export type IpcResult<C extends IpcChannel> = ReturnType<IpcContract[C]>

export type IpcEnvelope<T> = { ok: true; value: T } | { ok: false; error: DbErrorInfo }

/** Commands sent by the native application menu. */
export type MenuCommand =
  | 'new-console'
  | 'new-connection'
  | 'open-file'
  | 'save-file'
  | 'save-file-as'
  | 'close-tab'
  | 'next-tab'
  | 'previous-tab'
  | 'run-statement'
  | 'run-script'
  | 'cancel-query'
  | 'format-sql'
  | 'command-palette'
  | 'go-to-object'
  | 'toggle-sidebar'
  | 'toggle-results'
  | 'open-settings'
  | 'open-history'
  | 'focus-explorer'
  | 'focus-editor'
  | 'focus-results'
  /** File ▸ Import from DBeaver… (no accelerator). */
  | 'import-dbeaver'
  | 'import-datagrip'

export interface IpcEvents {
  /** A session lost its server connection unexpectedly. */
  'event:sessionClosed': { sessionId: string; connectionId: string; reason: string }
  /** A connection's metadata pool was closed (disconnect, error). */
  'event:connectionClosed': { connectionId: string; reason?: string }
  'event:menu': { command: MenuCommand }
  /** OS appearance changed (for theme "system"). */
  'event:nativeTheme': { dark: boolean }
  /**
   * Server messages (RAISE NOTICE, PRINT, RAISERROR … WITH NOWAIT) of a running execution, as they arrive
   * (batched). The final ExecutionResult.messages still holds every message, so the renderer can show these
   * live and then replace them with the final list.
   */
  'event:sessionMessages': { sessionId: string; messages: QueryMessage[] }
  /** Rows written by a running `files:exportQuery` with an exportId. */
  'event:exportProgress': ExportProgress
  /** Rows inserted by a running `files:importCsv`. */
  'event:importProgress': ImportProgress
  /** Interactive Vault login progress (OIDC browser flow). */
  'event:vaultLogin': VaultLoginEvent
  /** A Vault lease was renewed, re-issued, is about to expire or failed. */
  'event:vaultStatus': VaultStatus
}

export type IpcEventName = keyof IpcEvents

/** Shape of the object exposed by the preload on `window.datagrippe`. */
export interface PreloadBridge {
  invoke<C extends IpcChannel>(channel: C, ...args: IpcArgs<C>): Promise<IpcEnvelope<IpcResult<C>>>
  on<E extends IpcEventName>(event: E, listener: (payload: IpcEvents[E]) => void): () => void
  platform: string
}

export const IPC_EVENT_NAMES: IpcEventName[] = [
  'event:sessionClosed',
  'event:connectionClosed',
  'event:menu',
  'event:nativeTheme',
  'event:sessionMessages',
  'event:exportProgress',
  'event:importProgress',
  'event:vaultLogin',
  'event:vaultStatus',
]
