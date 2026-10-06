// Typed client for the main process. Every call resolves to the value or throws ApiError.
import type { IpcArgs, IpcChannel, IpcEventName, IpcEvents, IpcResult } from '@shared/ipc'
import type { DbErrorInfo } from '@shared/types'

export class ApiError extends Error {
  readonly info: DbErrorInfo

  constructor(info: DbErrorInfo) {
    super(info.message)
    this.name = 'ApiError'
    this.info = info
  }
}

export function errorInfo(error: unknown): DbErrorInfo {
  if (error instanceof ApiError) return error.info
  if (error instanceof Error) return { message: error.message, kind: 'internal' }
  return { message: String(error), kind: 'internal' }
}

export function errorMessage(error: unknown): string {
  return errorInfo(error).message
}

export async function call<C extends IpcChannel>(channel: C, ...args: IpcArgs<C>): Promise<IpcResult<C>> {
  const envelope = await window.datagrippe.invoke(channel, ...args)
  if (envelope.ok) return envelope.value
  throw new ApiError(envelope.error)
}

export function onEvent<E extends IpcEventName>(event: E, listener: (payload: IpcEvents[E]) => void): () => void {
  return window.datagrippe.on(event, listener)
}

/** Namespaced helpers — thin sugar over `call`. */
export const api = {
  app: {
    info: () => call('app:info'),
    openExternal: (url: string) => call('app:openExternal', url),
    showItemInFolder: (path: string) => call('app:showItemInFolder', path),
  },
  settings: {
    get: () => call('settings:get'),
    update: (...a: IpcArgs<'settings:update'>) => call('settings:update', ...a),
  },
  connections: {
    list: () => call('connections:list'),
    save: (...a: IpcArgs<'connections:save'>) => call('connections:save', ...a),
    delete: (...a: IpcArgs<'connections:delete'>) => call('connections:delete', ...a),
    duplicate: (...a: IpcArgs<'connections:duplicate'>) => call('connections:duplicate', ...a),
    test: (...a: IpcArgs<'connections:test'>) => call('connections:test', ...a),
    connect: (...a: IpcArgs<'connections:connect'>) => call('connections:connect', ...a),
    disconnect: (...a: IpcArgs<'connections:disconnect'>) => call('connections:disconnect', ...a),
    active: () => call('connections:active'),
  },
  vault: {
    test: (...a: IpcArgs<'vault:test'>) => call('vault:test', ...a),
    status: (...a: IpcArgs<'vault:status'>) => call('vault:status', ...a),
    refresh: (...a: IpcArgs<'vault:refresh'>) => call('vault:refresh', ...a),
    cancelLogin: () => call('vault:cancelLogin'),
    logout: (...a: IpcArgs<'vault:logout'>) => call('vault:logout', ...a),
    defaults: () => call('vault:defaults'),
    discover: (...a: IpcArgs<'vault:discover'>) => call('vault:discover', ...a),
  },
  importers: {
    dbeaverScan: (...a: IpcArgs<'import:dbeaverScan'>) => call('import:dbeaverScan', ...a),
  },
  meta: {
    databases: (...a: IpcArgs<'meta:databases'>) => call('meta:databases', ...a),
    schemas: (...a: IpcArgs<'meta:schemas'>) => call('meta:schemas', ...a),
    objects: (...a: IpcArgs<'meta:objects'>) => call('meta:objects', ...a),
    tableDetails: (...a: IpcArgs<'meta:tableDetails'>) => call('meta:tableDetails', ...a),
    ddl: (...a: IpcArgs<'meta:ddl'>) => call('meta:ddl', ...a),
    completionCatalog: (...a: IpcArgs<'meta:completionCatalog'>) => call('meta:completionCatalog', ...a),
  },
  session: {
    open: (...a: IpcArgs<'session:open'>) => call('session:open', ...a),
    close: (...a: IpcArgs<'session:close'>) => call('session:close', ...a),
    execute: (...a: IpcArgs<'session:execute'>) => call('session:execute', ...a),
    fetchMore: (...a: IpcArgs<'session:fetchMore'>) => call('session:fetchMore', ...a),
    cancel: (...a: IpcArgs<'session:cancel'>) => call('session:cancel', ...a),
    setAutoCommit: (...a: IpcArgs<'session:setAutoCommit'>) => call('session:setAutoCommit', ...a),
    commit: (...a: IpcArgs<'session:commit'>) => call('session:commit', ...a),
    rollback: (...a: IpcArgs<'session:rollback'>) => call('session:rollback', ...a),
    setDatabase: (...a: IpcArgs<'session:setDatabase'>) => call('session:setDatabase', ...a),
    setSchema: (...a: IpcArgs<'session:setSchema'>) => call('session:setSchema', ...a),
    explain: (...a: IpcArgs<'session:explain'>) => call('session:explain', ...a),
  },
  data: {
    fetch: (...a: IpcArgs<'data:fetch'>) => call('data:fetch', ...a),
    count: (...a: IpcArgs<'data:count'>) => call('data:count', ...a),
    cancel: (...a: IpcArgs<'data:cancel'>) => call('data:cancel', ...a),
    previewChanges: (...a: IpcArgs<'data:previewChanges'>) => call('data:previewChanges', ...a),
    applyChanges: (...a: IpcArgs<'data:applyChanges'>) => call('data:applyChanges', ...a),
  },
  history: {
    list: (...a: IpcArgs<'history:list'>) => call('history:list', ...a),
    clear: (...a: IpcArgs<'history:clear'>) => call('history:clear', ...a),
  },
  workspace: {
    load: () => call('workspace:load'),
    save: (...a: IpcArgs<'workspace:save'>) => call('workspace:save', ...a),
  },
  files: {
    saveText: (...a: IpcArgs<'files:saveText'>) => call('files:saveText', ...a),
    openText: () => call('files:openText'),
    writeText: (...a: IpcArgs<'files:writeText'>) => call('files:writeText', ...a),
    exportQuery: (...a: IpcArgs<'files:exportQuery'>) => call('files:exportQuery', ...a),
    cancelExport: (...a: IpcArgs<'files:cancelExport'>) => call('files:cancelExport', ...a),
    pickPath: (...a: IpcArgs<'files:pickPath'>) => call('files:pickPath', ...a),
  },
}
