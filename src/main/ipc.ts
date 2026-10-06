// Registers every IpcContract channel. Handlers are a typed map, so a missing channel is a
// compile error; each call is checked (sender, argument shapes) and wrapped in an IpcEnvelope.
import { app, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { IpcArgs, IpcChannel, IpcEnvelope, IpcEventName, IpcEvents, IpcResult } from '@shared/ipc'
import type { AppSettings, ConnectionInput, UnsavedWorkItem, VaultDefaults } from '@shared/types'
import { DriverError, toErrorInfo } from './db/errors'
import type { EmitFn, SessionManager } from './db/session-manager'
import { exportQuery } from './export/export-query'
import { chooseExportFile, openText, pickImportFile, pickPath, saveText, writeTextInPlace } from './export/files'
import { defaultDbeaverScanAllowed } from './automation-guard'
import { scanDbeaver } from './import/dbeaver'
import { importCsv, previewCsvFile } from './import/import-csv'
import { OperationRegistry } from './operations'
import type { Stores } from './store'
import { normalizeVaultAddress } from './vault/client'
import { appVersion } from './version'

export type IpcHandlers = { [C in IpcChannel]: (...args: IpcArgs<C>) => Promise<IpcResult<C>> | IpcResult<C> }

type ArgKind = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'string?' | 'object?'

/** Light runtime validation of what the renderer sends. */
export const ARG_SPECS: { [C in IpcChannel]: ArgKind[] } = {
  'app:info': [],
  'app:openExternal': ['string'],
  'app:showItemInFolder': ['string'],
  'app:setUnsavedWork': ['array'],
  'settings:get': [],
  'settings:update': ['object'],
  'connections:list': [],
  'connections:save': ['object'],
  'connections:delete': ['string'],
  'connections:duplicate': ['string'],
  'connections:test': ['object'],
  'connections:connect': ['string', 'object?'],
  'connections:disconnect': ['string'],
  'connections:active': [],
  'ssh:trustHostKey': ['object'],
  'vault:test': ['object'],
  'vault:status': ['string'],
  'vault:refresh': ['string'],
  'vault:cancelLogin': [],
  'vault:logout': ['string', 'string?'],
  'vault:defaults': [],
  'vault:discover': ['object'],
  'import:dbeaverScan': ['string?'],
  'meta:databases': ['string'],
  'meta:schemas': ['string', 'string'],
  'meta:objects': ['string', 'string', 'string'],
  'meta:tableDetails': ['string', 'string', 'string', 'string'],
  'meta:ddl': ['object'],
  'meta:completionCatalog': ['string', 'string'],
  'session:open': ['object'],
  'session:close': ['string'],
  'session:execute': ['string', 'string', 'object'],
  'session:fetchMore': ['string', 'string', 'number'],
  'session:cancel': ['string'],
  'session:setAutoCommit': ['string', 'boolean'],
  'session:commit': ['string'],
  'session:rollback': ['string'],
  'session:setDatabase': ['string', 'string', 'object?'],
  'session:setSchema': ['string', 'string'],
  'session:explain': ['string', 'string', 'boolean'],
  'data:fetch': ['object'],
  'data:count': ['object'],
  'data:cancel': ['string'],
  'data:previewChanges': ['object', 'array'],
  'data:applyChanges': ['object', 'array'],
  'history:list': ['object?'],
  'history:clear': ['string?'],
  'workspace:load': [],
  'workspace:save': ['object'],
  'files:saveText': ['object'],
  'files:openText': [],
  'files:writeText': ['object'],
  'files:exportQuery': ['object'],
  'files:cancelExport': ['string'],
  'files:pickImportFile': ['object?'],
  'files:previewImport': ['string', 'object'],
  'files:importCsv': ['object'],
  'files:cancelImport': ['string'],
  'files:pickPath': ['string', 'string?'],
}

function matches(kind: ArgKind, value: unknown): boolean {
  switch (kind) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    case 'array':
      return Array.isArray(value)
    case 'string?':
      return value === undefined || value === null || typeof value === 'string'
    case 'object?':
      return value === undefined || value === null || (typeof value === 'object' && !Array.isArray(value))
  }
}

export function validateArgs(channel: IpcChannel, args: unknown[]): void {
  const spec = ARG_SPECS[channel]
  spec.forEach((kind, i) => {
    if (!matches(kind, args[i])) {
      throw DriverError.of('invalid-input', `Invalid argument ${i + 1} for ${channel}: expected ${kind.replace('?', '')}.`)
    }
  })
}

export function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export function createEmitter(getWindow: () => BrowserWindow | null): EmitFn {
  return <E extends IpcEventName>(event: E, payload: IpcEvents[E]) => {
    const win = getWindow()
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send(event, payload)
  }
}

export interface IpcDeps {
  stores: Stores
  sessions: SessionManager
  getWindow: () => BrowserWindow | null
  emit?: EmitFn
  onSettingsChanged?: (settings: AppSettings) => void
  /** Latest unsaved-work report of the renderer (quit guard). */
  onUnsavedWork?: (items: UnsavedWorkItem[]) => void
  /** Running exports / imports (cancelled on renderer reload). */
  operations?: OperationRegistry
  /** VAULT_ADDR / VAULT_NAMESPACE / VAULT_CACERT of the vault CLI's environment (login shell included). */
  vaultDefaults?: () => Promise<VaultDefaults>
  log?: Pick<Console, 'error'>
}

const MAX_UNSAVED_ITEMS = 200

/** Keep only well-formed items (the renderer is not trusted to send exact shapes). */
function sanitizeUnsavedWork(items: unknown[]): UnsavedWorkItem[] {
  const out: UnsavedWorkItem[] = []
  for (const raw of items.slice(0, MAX_UNSAVED_ITEMS)) {
    if (typeof raw !== 'object' || raw === null) continue
    const item = raw as Record<string, unknown>
    if (typeof item.title !== 'string') continue
    const kind = item.kind === 'table-edits' || item.kind === 'console' ? item.kind : 'other'
    out.push({ kind, title: item.title.slice(0, 200), ...(typeof item.detail === 'string' ? { detail: item.detail.slice(0, 200) } : {}) })
  }
  return out
}

export function createHandlers({
  stores,
  sessions,
  getWindow,
  emit,
  onSettingsChanged,
  onUnsavedWork,
  operations = new OperationRegistry(),
  vaultDefaults,
}: IpcDeps): IpcHandlers {
  /** Files the user picked for an import in this run: the renderer may only read those. */
  const importFiles = new Set<string>()
  /** .sql files opened or saved through a dialog in this run (may be saved in place). */
  const textFiles = new Set<string>()
  const remember = <T extends string | null>(path: T): T => {
    if (path) textFiles.add(path)
    return path
  }
  const requireImportFile = (path: string) => {
    if (!importFiles.has(path)) throw DriverError.of('invalid-input', 'Choose the file to import again.')
  }
  return {
    'app:info': () => ({
      version: appVersion(),
      platform: process.platform,
      userDataPath: app.getPath('userData'),
      electronVersion: process.versions.electron ?? '',
    }),
    'app:openExternal': async (url) => {
      if (!isSafeExternalUrl(url)) throw DriverError.of('invalid-input', 'Only http(s) links can be opened.')
      await shell.openExternal(url)
    },
    'app:showItemInFolder': (path) => shell.showItemInFolder(path),
    'app:setUnsavedWork': (items) => onUnsavedWork?.(sanitizeUnsavedWork(items)),

    'settings:get': () => stores.settings.get(),
    'settings:update': (patch: Partial<AppSettings>) => {
      const settings = stores.settings.update(patch)
      onSettingsChanged?.(settings)
      return settings
    },

    'connections:list': () => stores.connections.list(),
    'connections:save': async (input: ConnectionInput) => {
      const before = input.id ? stores.connections.get(input.id) : undefined
      const saved = stores.connections.save(input)
      const secretsPatched = Object.values(input.secrets ?? {}).some((v) => v !== undefined)
      await sessions.connectionSaved(before, saved, secretsPatched)
      return stores.connections.get(saved.id) ?? saved
    },
    'connections:delete': async (id) => {
      await sessions.disconnect(id)
      stores.connections.delete(id)
    },
    'connections:duplicate': (id) => stores.connections.duplicate(id),
    'connections:test': (input) => sessions.test(input),
    'connections:connect': (id, secrets) => sessions.connect(id, secrets ?? undefined),
    'connections:disconnect': (id) => sessions.disconnect(id),
    'connections:active': () => sessions.activeConnections(),
    'ssh:trustHostKey': (key) => {
      try {
        stores.hostKeys.trust(key)
      } catch (error) {
        throw DriverError.of('invalid-input', error instanceof Error ? error.message : String(error))
      }
    },

    // HashiCorp Vault (src/main/vault/**): tokens and database passwords never leave the main process.
    'vault:test': (input) => sessions.vaultTest(input),
    'vault:status': (id) => sessions.vaultStatus(id),
    'vault:refresh': (id) => sessions.vaultRefresh(id),
    'vault:cancelLogin': () => sessions.vaultCancelLogin(),
    'vault:logout': (address, namespace) => {
      // Validates the address (invalid-input otherwise); the cache key normalizes it the same way.
      normalizeVaultAddress(address)
      sessions.vaultLogout(address, namespace ?? undefined)
    },
    'vault:defaults': () => (vaultDefaults ? vaultDefaults() : { source: 'none' as const, cliTokenFile: false }),
    'vault:discover': (req) => sessions.vaultDiscover(req),

    'import:dbeaverScan': (path) => {
      const chosen = path?.trim() ? path : undefined
      if (!chosen && !defaultDbeaverScanAllowed()) {
        return { files: [], candidates: [], warnings: ['Automated run: the default DBeaver workspace is not scanned. Choose a file instead.'] }
      }
      return scanDbeaver(chosen, stores.connections.list())
    },

    'meta:databases': (id) => sessions.databases(id),
    'meta:schemas': (id, database) => sessions.schemas(id, database),
    'meta:objects': (id, database, schema) => sessions.objects(id, database, schema),
    'meta:tableDetails': (id, database, schema, name) => sessions.tableDetails(id, database, schema, name),
    'meta:ddl': (req) => sessions.ddl(req),
    'meta:completionCatalog': (id, database) => sessions.completionCatalog(id, database),

    'session:open': (req) => sessions.openSession(req),
    'session:close': (sessionId) => sessions.closeSession(sessionId),
    'session:execute': (sessionId, sql, options) => {
      const maxRows = typeof options.maxRows === 'number' ? options.maxRows : stores.settings.get().maxRows
      const { history, ...rest } = options
      return sessions.execute(sessionId, sql, { ...rest, maxRows }, { history: history !== false })
    },
    'session:fetchMore': (sessionId, cursorId, count) => sessions.fetchMore(sessionId, cursorId, count),
    'session:cancel': (sessionId) => sessions.cancel(sessionId),
    'session:setAutoCommit': (sessionId, autoCommit) => sessions.setAutoCommit(sessionId, autoCommit),
    'session:commit': (sessionId) => sessions.commit(sessionId),
    'session:rollback': (sessionId) => sessions.rollback(sessionId),
    'session:setDatabase': (sessionId, database, options) => sessions.setDatabase(sessionId, database, options ?? {}),
    'session:setSchema': (sessionId, schema) => sessions.setSchema(sessionId, schema),
    'session:explain': (sessionId, sql, analyze) => sessions.explain(sessionId, sql, analyze),

    'data:fetch': (req) => sessions.fetchTableData(req),
    'data:count': (req) => sessions.countTableData(req),
    'data:cancel': (requestId) => sessions.cancelTableData(requestId),
    'data:previewChanges': (table, changes) => sessions.previewChanges(table, changes),
    'data:applyChanges': (table, changes) => sessions.applyChanges(table, changes),

    'history:list': (query) => stores.history.list(query ?? {}),
    'history:clear': (connectionId) => stores.history.clear(connectionId ?? undefined),

    'workspace:load': () => stores.workspace.load(),
    'workspace:save': (state) => stores.workspace.save(state),

    'files:saveText': async (req) => remember(await saveText(getWindow(), req)),
    'files:openText': async () => {
      const result = await openText(getWindow())
      if (result) remember(result.path)
      return result
    },
    'files:writeText': async (req) => remember(await writeTextInPlace(req, textFiles)),
    'files:exportQuery': async (req) => {
      const exportId = typeof req.exportId === 'string' ? req.exportId : undefined
      const { signal, release } = operations.start(exportId ? `export:${exportId}` : undefined)
      try {
        return await exportQuery(req, {
          sessions,
          chooseFile: (defaultName, format) => chooseExportFile(getWindow(), defaultName, format),
          signal,
          onProgress: exportId ? (rows) => emit?.('event:exportProgress', { exportId, rows }) : undefined,
        })
      } finally {
        release()
      }
    },
    'files:cancelExport': (exportId) => operations.cancel(`export:${exportId}`),
    'files:pickImportFile': async (options) => {
      const preview = await pickImportFile(getWindow(), options)
      if (preview) importFiles.add(preview.path)
      return preview
    },
    'files:previewImport': (path, options) => {
      requireImportFile(path)
      return previewCsvFile(path, options)
    },
    'files:importCsv': async (req) => {
      requireImportFile(req.path)
      if (typeof req.importId !== 'string' || !req.importId) throw DriverError.of('invalid-input', 'importId is required.')
      if (!Array.isArray(req.mapping) || typeof req.table !== 'object' || req.table === null) {
        throw DriverError.of('invalid-input', 'Invalid import request.')
      }
      const { importId } = req
      const { signal, release } = operations.start(`import:${importId}`)
      try {
        return await importCsv(req, {
          sessions,
          signal,
          onProgress: (p) => emit?.('event:importProgress', { importId, ...p }),
        })
      } finally {
        release()
      }
    },
    'files:cancelImport': (importId) => operations.cancel(`import:${importId}`),
    'files:pickPath': (title, kind) => pickPath(getWindow(), title, kind ?? undefined),
  }
}

/** Only our own main window's top frame may call main. */
function isTrustedSender(event: IpcMainInvokeEvent, win: BrowserWindow | null): boolean {
  if (!win || win.isDestroyed()) return false
  return event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
}

/** Wrap a handler: sender check, argument validation, envelope, logging of unexpected errors. */
export function wrapHandler<C extends IpcChannel>(
  channel: C,
  handler: IpcHandlers[C],
  deps: Pick<IpcDeps, 'getWindow' | 'log'>,
  trusted: (event: IpcMainInvokeEvent) => boolean = (event) => isTrustedSender(event, deps.getWindow()),
): (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<IpcEnvelope<IpcResult<C>>> {
  const log = deps.log ?? console
  const fn = handler as (...args: unknown[]) => Promise<IpcResult<C>> | IpcResult<C>
  return async (event, ...args) => {
    if (!trusted(event)) {
      log.error(`[ipc] rejected ${channel} from an untrusted sender`)
      return { ok: false, error: { kind: 'internal', message: 'Untrusted IPC sender.' } }
    }
    try {
      validateArgs(channel, args)
      const value = await fn(...args)
      return { ok: true, value }
    } catch (error) {
      const info = toErrorInfo(error)
      if (!(error instanceof DriverError)) log.error(`[ipc] ${channel} failed`, error)
      return { ok: false, error: info }
    }
  }
}

export function registerIpc(deps: IpcDeps): () => void {
  const handlers = createHandlers(deps)
  const channels = Object.keys(handlers) as IpcChannel[]
  for (const channel of channels) {
    ipcMain.handle(channel, wrapHandler(channel, handlers[channel] as IpcHandlers[typeof channel], deps))
  }
  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel)
  }
}
