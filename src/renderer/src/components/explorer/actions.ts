// Explorer actions shared by the tree (double-click, Enter), its context menus and the palette.
import type { DbObjectInfo, Dialect } from '@shared/types'
import { generateDelete, generateInsert, generateSelect, generateUpdate } from '@shared/sql'
import { confirmDisconnect, consoleWork, describeWork } from '@/components/layout/console-guards'
import { newConsole } from '@/components/layout/useGlobalCommands'
import { toast } from '@/components/ui'
import { toastError } from '@/components/vault/actions'
import { api } from '@/lib/api'
import { useCatalog } from '@/stores/catalog'
import { connectionById, useConnections } from '@/stores/connections'
import { useConsoles } from '@/stores/consoles'
import { defaultDatabase, defaultSchema, objectKey, useExplorer } from '@/stores/explorer'
import { useTabs } from '@/stores/tabs'
import { useUi } from '@/stores/ui'
import { generateDrop, KIND_LABEL } from './scripts'
import { nodeIds, RELATION_KINDS, type LoadRequest, type ObjectPath, type TreeRow } from './tree'

export type ScriptKind = 'select' | 'insert' | 'update' | 'delete' | 'ddl'

const dialectOf = (connectionId: string): Dialect => connectionById(connectionId)?.dialect ?? 'postgres'

export function runLoad(request: LoadRequest, force?: boolean): void {
  const ex = useExplorer.getState()
  switch (request.type) {
    case 'databases':
      void ex.loadDatabases(request.connectionId, force)
      break
    case 'schemas':
      void ex.loadSchemas(request.connectionId, request.database, force)
      break
    case 'objects':
      void ex.loadObjects(request.connectionId, request.database, request.schema, force)
      break
    case 'details':
      void ex.loadDetails(request.connectionId, request.database, request.schema, request.name, force)
      break
  }
}

/** Expand connection → default database → default schema (public / dbo), loading as needed. */
export async function revealDefaults(connectionId: string): Promise<void> {
  const ex = useExplorer.getState()
  const group = connectionById(connectionId)?.group?.trim()
  ex.setExpandedMany([...(group ? [nodeIds.group(group)] : []), nodeIds.connection(connectionId)], true)
  const databases = await ex.loadDatabases(connectionId)
  if (!databases || databases.length === 0) return
  const preferred = defaultDatabase(connectionId)
  const database = databases.some((d) => d.name === preferred)
    ? preferred!
    : (databases.find((d) => !d.isSystem)?.name ?? databases[0]!.name)
  ex.setExpanded(nodeIds.database(connectionId, database), true)
  const schemas = await ex.loadSchemas(connectionId, database)
  if (!schemas) return
  const schema = defaultSchema(connectionId, database)
  if (schema) ex.setExpanded(nodeIds.schema(connectionId, database, schema), true)
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export async function connect(connectionId: string): Promise<void> {
  try {
    await useConnections.getState().connect(connectionId)
  } catch (error) {
    const name = connectionById(connectionId)?.name
    // Vault failures (sealed, permission denied, wrong path…) are titled "Vault".
    toastError(`Could not connect to ${name ?? 'the server'}`, error, name)
  }
}

/** Disconnect, after confirming when consoles of the connection would lose a transaction or a running statement. */
export async function disconnect(connectionId: string): Promise<void> {
  if (!(await confirmDisconnect(connectionId))) return
  try {
    await useConnections.getState().disconnect(connectionId)
  } catch (error) {
    toast.error('Could not disconnect', error)
  }
}

export function editConnection(connectionId: string): void {
  useUi.getState().openConnectionDialog({ editId: connectionId })
}

export async function duplicateConnection(connectionId: string): Promise<void> {
  try {
    const copy = await useConnections.getState().duplicate(connectionId)
    useExplorer.getState().select(nodeIds.connection(copy.id))
    toast.success(`Duplicated as “${copy.name}”`, {
      action: { label: 'Edit', onClick: () => editConnection(copy.id) },
    })
  } catch (error) {
    toast.error('Could not duplicate the connection', error)
  }
}

export async function deleteConnection(connectionId: string): Promise<void> {
  const connection = connectionById(connectionId)
  if (!connection) return
  const work = describeWork(consoleWork(useTabs.getState().tabs, useConsoles.getState().runtimes, connectionId))
  const ok = await useUi.getState().confirm({
    title: `Delete “${connection.name}”?`,
    message: `The connection and its saved password are removed. Open consoles and query history are kept.${work ? ` ${work}` : ''}`,
    confirmLabel: 'Delete',
    danger: true,
  })
  if (!ok) return
  try {
    await useConnections.getState().remove(connectionId)
    if (useExplorer.getState().selectedNode?.startsWith(nodeIds.connection(connectionId))) useExplorer.getState().select(null)
    toast.success(`Deleted “${connection.name}”`)
  } catch (error) {
    toast.error('Could not delete the connection', error)
  }
}

export function newConsoleFor(connectionId: string): void {
  newConsole(connectionId)
}

// ---------------------------------------------------------------------------
// Consoles and tabs
// ---------------------------------------------------------------------------

export function newConsoleHere(connectionId: string, database?: string, schema?: string): void {
  useTabs.getState().openConsole({ connectionId, database, schema })
}

function openScript(path: ObjectPath, content: string, title?: string): void {
  useTabs.getState().openConsole({ connectionId: path.connectionId, database: path.database, schema: path.schema, content, title })
}

export function openTable(path: ObjectPath, object: DbObjectInfo, view: 'table' | 'structure'): void {
  useTabs.getState().openTable({ ...path, name: object.name, kind: object.kind }, view)
}

async function columnsOf(path: ObjectPath, object: DbObjectInfo) {
  const details = await useExplorer.getState().loadDetails(path.connectionId, path.database, path.schema, object.name)
  if (!details) {
    const error = useExplorer.getState().details[objectKey(path.connectionId, path.database, path.schema, object.name)]?.error
    throw new Error(error ?? `Could not read the columns of ${object.name}`)
  }
  return details.columns
}

export async function generateScript(path: ObjectPath, object: DbObjectInfo, kind: ScriptKind): Promise<void> {
  const dialect = dialectOf(path.connectionId)
  try {
    if (kind === 'ddl') {
      const ddl = await api.meta.ddl({ ...path, name: object.name, kind: object.kind, identity: object.identity })
      openScript(path, ddl.endsWith('\n') ? ddl : `${ddl}\n`, object.name)
      return
    }
    const columns = await columnsOf(path, object)
    const script =
      kind === 'select'
        ? generateSelect(object.schema, object.name, [...columns].sort((a, b) => a.ordinal - b.ordinal).map((c) => c.name), dialect, 100)
        : kind === 'insert'
          ? generateInsert(object.schema, object.name, columns, dialect)
          : kind === 'update'
            ? generateUpdate(object.schema, object.name, columns, dialect)
            : generateDelete(object.schema, object.name, columns, dialect)
    openScript(path, `${script}\n`)
  } catch (error) {
    toast.error(kind === 'ddl' ? `Could not generate the DDL of ${object.name}` : `Could not generate the ${kind.toUpperCase()} script`, error)
  }
}

export function dropObject(path: ObjectPath, object: DbObjectInfo): void {
  openScript(path, generateDrop(object, dialectOf(path.connectionId)), `Drop ${object.name}`)
  toast.info(`Review the DROP ${KIND_LABEL[object.kind]} script, then run it`)
}

/** Double-click / Enter on an object: data tab for relations, DDL console for the rest. */
export function activateObject(path: ObjectPath, object: DbObjectInfo): void {
  if (RELATION_KINDS.has(object.kind)) openTable(path, object, 'table')
  else void generateScript(path, object, 'ddl')
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export async function copyText(text: string, what = 'name'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`Copied ${what}`, { description: text.length > 80 ? `${text.slice(0, 80)}…` : text, duration: 2000 })
  } catch (error) {
    toast.error('Could not copy to the clipboard', error)
  }
}

/** Reload what the row shows (and everything cached below it). */
export async function refreshRow(row: TreeRow): Promise<void> {
  const ex = useExplorer.getState()
  const node = row.node
  switch (node.type) {
    case 'group': {
      const ids = useConnections
        .getState()
        .connections.filter((c) => c.group?.trim() === node.name)
        .map((c) => c.id)
      await Promise.all(ids.map((id) => refreshConnection(id)))
      return
    }
    case 'connection':
      await refreshConnection(node.connection.id)
      return
    case 'database':
      useCatalog.getState().invalidate(node.connectionId)
      await ex.refresh(node.connectionId, node.database.name)
      return
    case 'schema':
      useCatalog.getState().invalidate(node.connectionId)
      await ex.refresh(node.connectionId, node.database, node.schema.name)
      return
    case 'folder':
      useCatalog.getState().invalidate(node.path.connectionId)
      await ex.refresh(node.path.connectionId, node.path.database, node.path.schema)
      return
    case 'object':
    case 'column':
    case 'detail-folder':
    case 'detail':
      useCatalog.getState().invalidate(node.path.connectionId)
      await ex.refresh(node.path.connectionId, node.path.database, node.path.schema, node.object.name)
      return
    case 'message':
      if (node.retry) runLoad(node.retry, true)
  }
}

async function refreshConnection(connectionId: string): Promise<void> {
  useCatalog.getState().invalidate(connectionId)
  const loaded = useExplorer.getState().databases[connectionId] !== undefined
  if (loaded) await useExplorer.getState().refresh(connectionId)
}
